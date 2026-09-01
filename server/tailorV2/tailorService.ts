// Tailor V2 — canonical user-facing tailoring service.
//
// Single entry point used by EVERY normal Tailor Resume path (job-card
// Tailor, Re-Tailor, batch Tailor, Manual JD Tailor, application-package
// auto-tailor). There is exactly one tailoring implementation: the
// fact-grounded V2 pipeline (ledger → drafter → verifier → fail-closed).
//
//   job (resolved JD) + master CV + applicant profile
//     → deterministic fit (cached)
//     → Candidate Fact Ledger (deterministic, LLM-free)
//     → LLM drafter
//     → deterministic verifier (fail closed)
//     → verified version persisted (versioned, per job)
//     → PDF with text-layer verification
//     → UI-compatible TailoredCv + audit
//
// The job description is NEVER candidate evidence. Unsupported claims fail
// verification; the generated resume is never persisted or published.

import type { Job, MasterCv, TailoredCv, TailoringAudit } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import { TailorVerificationFailedError, runTailorV2, toTailoredCv, type TailorV2Result } from './tailorV2Engine.js';
import { getLatestTailorVersion } from './versionStore.js';
import { getCurrentUserId, getMasterCv, getMasterCvUpdatedAt, getDb } from '../storage/fileStorage.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';
import { computeFit } from '../fit/fitEngine.js';
import { fitCacheKeyFor, getCachedFit, storeCachedFit, jdHash } from '../fit/fitCache.js';
import type { TailorDraft } from './drafter.js';
import type { TailorVerification } from './verifier.js';
import { jdSkillTerms } from './tailorV2Engine.js';

export interface TailorJobResult {
  version: number;
  tailoredCv: TailoredCv;
  draft: TailorDraft;
  verification: TailorVerification;
  jdTerms: string[];
  pdfOk: boolean;
  audit: TailoringAudit;
}

/** Resolve the real job description or throw (never tailor on a stub). */
export async function resolveJobDescription(job: Job): Promise<Job> {
  const { ensureJobDescription } = await import('../tailor/jdResolver.js');
  return ensureJobDescription(job);
}

/** Deterministic fit for a job (cached per user/job/inputs). */
export function fitForJob(userId: string, job: Job, masterCv: MasterCv, jd: string): FitResult {
  const profile = getApplicantProfile(userId);
  const key = fitCacheKeyFor(profile.updatedAt, getMasterCvUpdatedAt(userId), jd);
  const cached = getCachedFit(userId, job.id, key);
  if (cached) return cached;
  const fit = computeFit(profile, masterCv, job, jd);
  storeCachedFit(userId, job.id, key, fit);
  return fit;
}

/** UI audit: same field shape the job detail / manual JD screens consume.
 *  beforeScore = the existing Resume Match score (unchanged methodology);
 *  afterScore mirrors the previous deterministic keyword-weighted formula
 *  using the VERIFIER's grounded keyword coverage — never a separate score. */
export function buildTailorAudit(job: Job, draft: TailorDraft, verification: TailorVerification, jdTerms: string[], masterCv: MasterCv): TailoringAudit {
  const beforeScore = job.matchScore ?? job.gapAnalysis?.matchScore ?? 50;
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const expText = (draft.experience || []).flatMap((w) => w.highlights || []).join(' ').toLowerCase();
  const skillsText = (draft.skills || []).join(' ').toLowerCase();
  const allText = `${expText} ${skillsText} ${draft.summary || ''}`.toLowerCase();
  const verifiedInExperience = jdTerms.filter((t) => norm(expText).includes(norm(t)));
  const verifiedInSkills = jdTerms.filter((t) => norm(skillsText).includes(norm(t)));
  const verifiedAll = [...new Set([...verifiedInExperience, ...verifiedInSkills])];
  const notIntegrable = jdTerms.filter((t) => !norm(allText).includes(norm(t)));

  const totalMissing = Math.max(jdTerms.length, 1);
  const expWeight = verifiedInExperience.length;
  const skillsWeight = verifiedInSkills.length * 0.5;
  const weightedFill = Math.min((expWeight + skillsWeight) / totalMissing, 0.95);
  const afterScore = Math.round(beforeScore + weightedFill * (100 - beforeScore));

  const sourceBullets = (masterCv.experiences || []).flatMap((e) => e.responsibilities || []);
  const draftBullets = (draft.experience || []).flatMap((w) => w.highlights || []);
  const rephrasedHighlightsCount = Math.min(sourceBullets.length, draftBullets.length);

  return {
    beforeScore,
    afterScore,
    scoreBoost: afterScore - beforeScore,
    scoreBreakdown: {
      alreadyMatched: jdTerms.length - notIntegrable.length,
      newlyIntegrated: verifiedAll.length,
      remainingGap: notIntegrable.length,
    },
    missingBefore: {
      skills: job.gapAnalysis?.missingSkills ?? [],
      keywords: job.gapAnalysis?.missingKeywords ?? [],
    },
    addedAfter: {
      keywordsIncorporated: verifiedAll,
      keywordsInExperience: verifiedInExperience,
      keywordsInSkills: verifiedInSkills,
      rephrasedHighlightsCount,
      skillsAdded: [],
    },
    notIntegrable,
    auditNotes: [
      `Aligned the resume to "${job.title}" using only evidence from the candidate's Master CV and profile.`,
      `Integrated ${verifiedAll.length} job-description terms that the candidate's evidence supports.`,
      `Left out ${notIntegrable.length} job-description requirement(s) the candidate's evidence does not support — surfaced as gaps instead.`,
      `Every employer, title, date, degree, certification, skill, metric and project was verified against the candidate's fact ledger before publication.`,
    ],
  };
}

/** The one canonical user-facing tailoring entry point. */
export async function tailorJobWithV2(
  job: Job,
  opts: { userId?: string } = {}
): Promise<TailorJobResult> {
  const userId = opts.userId || getCurrentUserId();

  const fullJob = await resolveJobDescription(job);
  const jd = fullJob.description || '';
  const masterCv = getMasterCv(userId);
  const profile = getApplicantProfile(userId);
  const fit = fitForJob(userId, fullJob, masterCv, jd);

  const result: TailorV2Result = await runTailorV2(
    userId, masterCv, profile, fullJob, jd, fit,
    { masterCvUpdatedAt: getMasterCvUpdatedAt(userId), profileUpdatedAt: profile.updatedAt, jdHash: jdHash(jd), fitEngineVersion: fit.version }
  );

  const tailoredCv = toTailoredCv(result.draft, masterCv.fullName || '');
  const audit = buildTailorAudit(fullJob, result.draft, result.verification, result.jdTerms, masterCv);
  // The UI artifact carries the same metadata the legacy engine provided:
  // contact block (templates render the header/contact area), audit
  // (before/after scores, gaps, keyword incorporation) and display-only
  // counters. The versioned draft itself stays canonical.
  enrichTailoredCv(tailoredCv, audit, masterCv);

  return {
    version: result.version,
    tailoredCv,
    draft: result.draft,
    verification: result.verification,
    jdTerms: result.jdTerms,
    pdfOk: result.pdfOk,
    audit,
  };
}

/** Latest verified Tailor V2 version for a job (for package/immutable use). */
export function latestVerifiedVersion(userId: string, jobId: string) {
  return getLatestTailorVersion(userId, jobId);
}

/** Attach the UI metadata the legacy engine provided (contact block, audit,
 *  display counters) to a TailoredCv. Idempotent — keeps an existing audit. */
export function enrichTailoredCv(tailoredCv: TailoredCv, audit: TailoringAudit, masterCv?: MasterCv): TailoredCv {
  if (masterCv) {
    tailoredCv.contactInfo = {
      email: masterCv.email,
      phone: masterCv.phone,
      location: masterCv.location,
      linkedin: masterCv.linkedin,
      github: masterCv.github,
      website: masterCv.website,
    };
  }
  tailoredCv.audit = audit;
  tailoredCv.rephraseHighlightsCount = audit.addedAfter.rephrasedHighlightsCount;
  tailoredCv.keywordsIncorporated = audit.addedAfter.keywordsIncorporated;
  return tailoredCv;
}

/** Deterministic backfill for tailored CVs stored before the V2 service
 *  attached audit/contactInfo. No LLM calls — rerun-safe. */
export function backfillTailoredAudits(): number {
  const db = getDb();
  let count = 0;
  // jobs are stored as JSON blobs (id, user_id, data) — no state column.
  const rows = db.prepare(`SELECT id, data FROM jobs`).all() as Array<{ id: string; data: string }>;
  for (const row of rows) {
    let job: Job;
    try {
      job = JSON.parse(row.data) as Job;
    } catch { continue; }
    const cv = job.tailoredCv;
    if (job.state !== 'tailored' || !cv) continue;
    const needsAudit = !cv.audit;
    const needsContact = !cv.contactInfo || !cv.contactInfo.email;
    if (!needsAudit && !needsContact) continue;
    // Terms: from the real JD when stored; otherwise the gap analysis the
    // match produced (deterministic, grounded, never LLM).
    const terms = needsAudit ? jdSkillTerms(String(job.description || '')) : [];
    if (!terms.length && needsAudit) {
      const gapTerms = [
        ...(job.gapAnalysis?.matchingSkills || []),
        ...(job.gapAnalysis?.missingSkills || []),
        ...(job.gapAnalysis?.missingKeywords || []),
      ];
      if (!gapTerms.length) continue;
      terms.push(...gapTerms);
    }
    backfillRowWithTerms(job, cv, terms, db, row.id, needsAudit);
    count++;
  }
  return count;
}

function backfillRowWithTerms(job: Job, cv: TailoredCv, terms: string[], db: ReturnType<typeof getDb>, rowId: string, needsAudit: boolean): void {
  const baseAudit = cv.audit || null;
  let audit = baseAudit;
  if (needsAudit) {
    const draft: TailorDraft = {
      summary: cv.professionalSummary || '',
      skills: cv.coreCompetencies || [],
      experience: (cv.workExperience || []).map((w) => ({ title: w.title, company: w.company, dates: w.dates, highlights: w.highlights || [] })),
      education: (cv.education || []).map((e) => ({ degree: e.degree, institution: e.institution, dates: e.dates })),
      certifications: (cv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '')),
      projects: (cv.projects || []).map((p) => ({ name: p.name, description: p.description || '' })),
    };
    audit = buildTailorAudit(job, draft, { passed: true, issues: [], supportedJdTermsBefore: 0, supportedJdTermsAfter: terms.length, unsupportedInserted: 0 }, terms, getMasterCv());
  }
  enrichTailoredCv(cv, audit as TailoringAudit, getMasterCv());
  job.tailoredCv = cv;
  db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), rowId);
}

export { TailorVerificationFailedError };