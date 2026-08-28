// Application Package — deterministic canonical answers + readiness validator.
// NO LLM here. Unknown facts stay UNKNOWN / NEEDS_INPUT — never guessed.

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import type { ApplicationPackage, PackageValidation, ResolvedAnswer } from './packageModel.js';

export function resolveDeterministicAnswers(cv: MasterCv, profile: ApplicantProfile, job: Job): ResolvedAnswer[] {
  const out: ResolvedAnswer[] = [];
  const push = (key: string, label: string, value: unknown, source: ResolvedAnswer['source']): void => {
    const resolved = value !== undefined && value !== null && value !== '';
    out.push({
      key,
      label,
      value: resolved ? (value as string | number | boolean | string[] | null) : null,
      source,
      status: resolved ? 'RESOLVED' : 'MISSING',
    });
  };

  const name = [profile.personal?.firstName, profile.personal?.lastName].filter(Boolean).join(' ') || cv.fullName;
  push('firstName', 'First name', profile.personal?.firstName ?? cv.fullName?.split(/\s+/)[0], profile.personal?.firstName ? 'PROFILE' : 'MASTER_CV');
  push('lastName', 'Last name', profile.personal?.lastName ?? cv.fullName?.split(/\s+/).slice(-1)[0], profile.personal?.lastName ? 'PROFILE' : 'MASTER_CV');
  push('fullName', 'Full name', name, name === cv.fullName ? 'MASTER_CV' : 'PROFILE');
  push('preferredName', 'Preferred name', profile.personal?.preferredName, 'PROFILE');
  push('email', 'Email', profile.personal?.email ?? cv.email, profile.personal?.email ? 'PROFILE' : 'MASTER_CV');
  push('phone', 'Phone', profile.personal?.phone ?? cv.phone, profile.personal?.phone ? 'PROFILE' : 'MASTER_CV');
  push('currentCity', 'Current city', profile.contact?.city ?? profile.locationPrefs?.currentCity, 'PROFILE');
  push('currentState', 'Current state', profile.contact?.state ?? profile.locationPrefs?.currentState, 'PROFILE');
  push('currentCountry', 'Current country', profile.contact?.country ?? profile.locationPrefs?.currentCountry, 'PROFILE');
  push('linkedinUrl', 'LinkedIn URL', profile.links?.linkedin ?? cv.linkedin, profile.links?.linkedin ? 'PROFILE' : 'MASTER_CV');
  push('githubUrl', 'GitHub URL', profile.links?.github ?? cv.github, profile.links?.github ? 'PROFILE' : 'MASTER_CV');
  push('portfolioUrl', 'Portfolio URL', profile.links?.portfolio, 'PROFILE');
  push('websiteUrl', 'Website URL', profile.links?.website ?? cv.website, profile.links?.website ? 'PROFILE' : 'MASTER_CV');

  const wa = profile.workAuthorization ?? {};
  push('authorizedToWork', 'Authorized to work', wa.authorizedToWork === 'yes' ? 'Yes' : wa.authorizedToWork === 'no' ? 'No' : null, 'PROFILE');
  push('requiresSponsorship', 'Requires sponsorship', wa.requiresSponsorship === 'yes' ? 'Yes' : wa.requiresSponsorship === 'no' ? 'No' : null, 'PROFILE');
  push('visaType', 'Visa / work permit type', wa.visaType, 'PROFILE');

  const prefs = profile.preferences ?? {};
  const appDefaults = profile.applicationDefaults ?? {};
  push('willingToRelocate', 'Willing to relocate', profile.locationPrefs?.willingToRelocate, 'PROFILE');
  push('remotePreference', 'Remote preference', profile.locationPrefs?.remotePreference, 'PROFILE');
  push('noticePeriod', 'Notice period', prefs.noticePeriod, 'PROFILE');
  push('earliestStartDate', 'Earliest start date', prefs.earliestStartDate, 'PROFILE');
  push('currentSalary', 'Current salary', prefs.currentSalary, 'PROFILE');
  push('minimumSalary', 'Minimum salary', prefs.minimumSalary, 'PROFILE');
  push('targetSalary', 'Target salary', prefs.targetSalary, 'PROFILE');
  push('salaryCurrency', 'Salary currency', prefs.salaryCurrency, 'PROFILE');
  push('salaryPeriod', 'Salary period', prefs.salaryPeriod, 'PROFILE');
  push('desiredEmploymentTypes', 'Desired employment types', prefs.preferredEmploymentTypes, 'PROFILE');
  push('desiredTitles', 'Desired titles', prefs.desiredTitles, 'PROFILE');
  push('reasonForChange', 'Reason for change', appDefaults.reasonForChange, 'PROFILE');
  push('whyInterested', 'Why interested (default)', appDefaults.whyInterestedDefault, 'PROFILE');
  push('preferredContactMethod', 'Preferred contact method', appDefaults.preferredContactMethod, 'PROFILE');

  return out;
}

/** Required application facts — a package cannot be READY without these
 *  being RESOLVED (never guessed). */
const REQUIRED_KEYS = ['fullName', 'email', 'phone', 'currentCity', 'currentCountry', 'authorizedToWork', 'requiresSponsorship'];

export function answerByKey(answers: ResolvedAnswer[], key: string): ResolvedAnswer | undefined {
  return answers.find((a) => a.key === key);
}

export function answerStateKey(answers: ResolvedAnswer[]): string {
  return answers.map((a) => `${a.key}:${a.status}:${String(a.value ?? '')}`).join('|');
}

/** Centralized deterministic readiness validator. */
export function validatePackage(
  pkg: ApplicationPackage,
  answers: ResolvedAnswer[],
  fit: FitResult | undefined,
  profile: ApplicantProfile,
  opts: { requireGeneratedAnswers?: boolean } = {}
): PackageValidation {
  const missingFields: string[] = [];
  const needsInput: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  // JOB
  if (!pkg.jobSnapshot.jobId || !pkg.jobSnapshot.jdHash) blockers.push('Job/JD snapshot incomplete.');

  // APPLICANT
  for (const key of REQUIRED_KEYS) {
    const a = answerByKey(answers, key);
    if (!a || a.status !== 'RESOLVED') {
      const label = a?.label ?? key;
      if (key === 'authorizedToWork' || key === 'requiresSponsorship') needsInput.push(`${label} — cannot be guessed`);
      else missingFields.push(label);
    }
  }

  // FIT
  if (!fit) warnings.push('Fit snapshot absent — package prepared without fit context.');
  else if (fit.blockers?.length) warnings.push('Fit blockers present — review before applying.');

  // RESUME
  const rs = pkg.resumeSnapshot;
  if (!rs) {
    blockers.push('No verified tailored resume — run Tailor V2 first.');
  } else {
    if (!rs.tailoredResumeVersionId) blockers.push('Resume version not associated.');
    if (rs.resumeJobId && rs.resumeJobId !== pkg.jobId) blockers.push('Resume belongs to a different job.');
    if (rs.resumeUserId && rs.resumeUserId !== pkg.userId) blockers.push('Resume belongs to a different user.');
    if (!rs.verification?.passed) blockers.push('Tailor V2 factual verification not passed.');
    if (!rs.pdfOk || !rs.pdfHash) blockers.push('Resume PDF not verified.');
  }

  // ANSWERS
  for (const q of pkg.questions || []) {
    if (!q.required) continue;
    if (q.status === 'NEEDS_INPUT') needsInput.push(q.question);
    else if (!q.answer && q.answer !== false) missingFields.push(q.question);
  }
  for (const g of pkg.generatedContent?.generatedAnswers || []) {
    if (!g.verified) blockers.push('An unsafe generated answer is present.');
  }
  if (pkg.generatedContent?.coverLetter && !pkg.generatedContent.coverLetter.verified) {
    warnings.push('Cover letter failed verification and was omitted.');
  }
  if (opts.requireGeneratedAnswers && pkg.questions.some((q) => q.required && !q.answer)) {
    needsInput.push('Required generated answers missing.');
  }

  const ready = blockers.length === 0 && needsInput.length === 0 && missingFields.length === 0;
  const status: PackageValidation['status'] = ready ? 'READY' : needsInput.length > 0 ? 'NEEDS_INPUT' : blockers.length > 0 ? 'DRAFT' : 'DRAFT';
  return { ready, status, missingFields, needsInput, blockers, warnings };
}