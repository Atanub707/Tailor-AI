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

/** UNIVERSAL identity prerequisites — every application needs these. Nothing
 *  else is universally mandatory in V1: authorization/sponsorship/salary/
 *  location become required only when a known question marks them required
 *  (future ATS question discovery) — we do not pretend every job asks the
 *  same questions. */
const UNIVERSAL_KEYS = ['fullName', 'email'];

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
  const missingPrerequisites: string[] = [];
  const needsInput: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  // JOB / JD — system prerequisite
  if (!pkg.jobSnapshot.jobId || !pkg.jobSnapshot.jdHash) missingPrerequisites.push('Job/JD snapshot');

  // UNIVERSAL identity — system/user prerequisite (never guessed)
  for (const key of UNIVERSAL_KEYS) {
    const a = answerByKey(answers, key);
    if (!a || a.status !== 'RESOLVED') missingPrerequisites.push(a?.label ?? key);
  }

  // FIT — REQUIRED system prerequisite for READY (deterministic, local).
  if (!fit) missingPrerequisites.push('Fit snapshot');
  else if (fit.blockers?.length) warnings.push('Fit blockers present — review before applying.');

  // RESUME + immutable PDF artifact — REQUIRED system prerequisites
  const rs = pkg.resumeSnapshot;
  if (!rs) {
    missingPrerequisites.push('Verified Tailor V2 resume');
  } else {
    if (!rs.tailoredResumeVersionId) missingPrerequisites.push('Resume version association');
    if (rs.resumeJobId && rs.resumeJobId !== pkg.jobId) blockers.push('Resume belongs to a different job.');
    if (rs.resumeUserId && rs.resumeUserId !== pkg.userId) blockers.push('Resume belongs to a different user.');
    if (!rs.verification?.passed) missingPrerequisites.push('Tailor V2 factual verification');
    if (!rs.pdfOk || !rs.pdfHash || !rs.pdfArtifact) missingPrerequisites.push('Immutable verified PDF artifact');
  }

  // ANSWERS — only REQUIRED questions block (never optional unresolved).
  for (const q of pkg.questions || []) {
    if (!q.required) continue;
    if (q.status === 'NEEDS_INPUT') needsInput.push(q.question);
    else if (!q.answer && q.answer !== false) needsInput.push(q.question);
  }
  for (const g of pkg.generatedContent?.generatedAnswers || []) {
    if (!g.verified) blockers.push('An unsafe generated answer is present.');
  }
  if (pkg.generatedContent?.coverLetter && !pkg.generatedContent.coverLetter.verified) {
    warnings.push('Cover letter failed verification and was omitted.');
  }

  // Precedence: prerequisites → needsInput → blockers → READY.
  const ready = missingPrerequisites.length === 0 && needsInput.length === 0 && blockers.length === 0;
  let status: PackageValidation['status'];
  if (missingPrerequisites.length > 0) status = 'DRAFT';
  else if (needsInput.length > 0) status = 'NEEDS_INPUT';
  else if (blockers.length > 0) status = 'DRAFT';
  else status = 'READY';
  return { ready, status, missingPrerequisites, needsInput, blockers, warnings, missingFields: missingPrerequisites };
}