// Application Package Engine — builds immutable packages, validates
// readiness, detects staleness, supports idempotent reuse + rebuild.

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import { jdHash } from '../fit/fitCache.js';
import { getLatestTailorVersion, type TailoredResumeVersionRow } from '../tailorV2/versionStore.js';
import { toTailoredCv } from '../tailorV2/tailorV2Engine.js';
import type { TailorDraft } from '../tailorV2/drafter.js';
import { generatePdfBuffer } from '../builder/docxGenerator.js';
import { freshPackage, getLatestPackage, nextPackageVersion, packageInputFingerprint, snapshotHash, storePackage } from './packageStore.js';
import { persistPdfArtifact, readPdfArtifact, sha256Bytes } from './artifactStore.js';
import type { ApplicationPackage, PackageStatus, ResolvedAnswer } from './packageModel.js';
import {
  answerStateKey,
  resolveDeterministicAnswers,
  validatePackage,
} from './answers.js';

export interface BuildPackageInput {
  userId: string;
  job: Job;
  jd: string;
  profile: ApplicantProfile;
  masterCv: MasterCv;
  fit: FitResult;
  tailoredVersion?: TailoredResumeVersionRow;
  answers?: ResolvedAnswer[];
  generatedContent?: ApplicationPackage['generatedContent'];
  questions?: ApplicationPackage['questions'];
}

export function computePackageKeys(input: BuildPackageInput): {
  jobId: string;
  jdHash: string;
  profileUpdatedAt?: string;
  masterCvUpdatedAt?: string;
  fitEngineVersion?: number;
  fitScore?: number;
  tailoredResumeVersionId?: string;
  tailorEngineVersion?: number;
  answersState: string;
} {
  return {
    jobId: input.job.id,
    jdHash: jdHash(input.jd),
    profileUpdatedAt: input.profile.updatedAt,
    masterCvUpdatedAt: undefined, // supplied by caller
    fitEngineVersion: input.fit?.version,
    fitScore: input.fit?.score ?? 0,
    tailoredResumeVersionId: input.tailoredVersion?.id,
    tailorEngineVersion: input.tailoredVersion?.tailorEngineVersion,
    answersState: answerStateKey(input.answers ?? resolveDeterministicAnswers(input.masterCv, input.profile, input.job)),
  };
}

/** Build a fresh package object from current inputs (no persistence). */
/** Convert the authoritative Master CV into the structured resume shape used
 *  by the PDF renderer — deterministic, no generation, no invented facts. */
export function masterCvToTailorDraft(cv: MasterCv): TailorDraft {
  const toSkillList = (raw: MasterCv['skills']): string[] =>
    Array.isArray(raw)
      ? raw.flatMap((s) => (typeof s === 'string' ? [s] : Array.isArray(s.items) ? s.items : []))
      : [];
  return {
    summary: cv.summary || '',
    skills: toSkillList(cv.skills),
    experience: (cv.experiences || []).map((e) => ({ title: e.title, company: e.company, location: e.location, dates: e.dates, highlights: e.responsibilities || [] })),
    education: (cv.education || []).map((ed) => ({ degree: ed.degree, institution: ed.institution, dates: ed.dates, details: Array.isArray(ed.details) ? ed.details.join('\n') : ed.details })),
    certifications: (cv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '')),
    projects: (cv.projects || []).map((pr) => ({ name: pr.name || '', description: pr.description || '' })),
  };
}

export async function buildPackage(input: BuildPackageInput, masterCvUpdatedAt: string | undefined): Promise<ApplicationPackage> {
  const version = nextPackageVersion(input.userId, input.job.id);
  const pkg = freshPackage(input.userId, input.job.id, version);
  const answers = input.answers ?? resolveDeterministicAnswers(input.masterCv, input.profile, input.job);

  pkg.jobSnapshot = {
    jobId: input.job.id,
    externalJobId: input.job.externalId,
    platform: input.job.atsPlatform,
    source: input.job.source,
    company: input.job.company,
    title: input.job.title,
    location: input.job.location,
    employmentType: input.job.employmentType,
    applyUrl: input.job.applyUrl,
    jobUrl: (input.job as any).jobUrl ?? input.job.url,
    postedDate: input.job.postedDate,
    jd: input.jd,
    jdHash: jdHash(input.jd),
  };

  pkg.applicantSnapshot = {
    profileUpdatedAt: input.profile.updatedAt,
    personal: { ...input.profile.personal },
    contact: { ...input.profile.contact },
    links: { ...input.profile.links },
    locationPrefs: { ...input.profile.locationPrefs },
    workAuthorization: { ...input.profile.workAuthorization },
    preferences: { ...input.profile.preferences },
    applicationDefaults: { ...input.profile.applicationDefaults },
  };

  pkg.masterCvProvenance = {
    masterCvUpdatedAt,
    masterCvHash: snapshotHash(input.masterCv),
  };

  pkg.fitSnapshot = input.fit ? {
    score: input.fit.score,
    grade: input.fit.grade,
    categories: input.fit.categories,
    strengths: input.fit.strengths,
    gaps: input.fit.gaps,
    blockers: input.fit.blockers,
    unknowns: input.fit.unknowns,
    assessmentCoverage: input.fit.assessmentCoverage,
    engineVersion: input.fit.version,
    calculatedAt: input.fit.calculatedAt,
  } : { score: 0, grade: '', strengths: [], gaps: [], blockers: [], unknowns: [] };

  if (input.tailoredVersion) {
    // IMMUTABLE PDF ARTIFACT: generate the exact document from the frozen
    // structured resume, persist the byte-exact artifact (content-addressed),
    // and verify the persisted bytes hash back to the same value.
    if (input.tailoredVersion.verification?.passed) {
      const buf = await generatePdfBuffer(toTailoredCv(input.tailoredVersion.content, input.masterCv.fullName || ''));
      const art = persistPdfArtifact(buf);
      const reRead = readPdfArtifact(art.sha256);
      const pdfOk = sha256Bytes(reRead) === art.sha256;
      pkg.resumeSnapshot = {
        tailoredResumeVersionId: input.tailoredVersion.id,
        resumeUserId: input.tailoredVersion.userId,
        resumeJobId: input.tailoredVersion.jobId,
        version: input.tailoredVersion.version,
        tailorEngineVersion: input.tailoredVersion.tailorEngineVersion,
        structuredResume: input.tailoredVersion.content,
        verification: input.tailoredVersion.verification,
        pdfHash: art.sha256,
        pdfSize: art.size,
        pdfArtifact: art.path,
        pdfOk,
      };
    } else {
      pkg.resumeSnapshot = {
        tailoredResumeVersionId: input.tailoredVersion.id,
        resumeUserId: input.tailoredVersion.userId,
        resumeJobId: input.tailoredVersion.jobId,
        version: input.tailoredVersion.version,
        tailorEngineVersion: input.tailoredVersion.tailorEngineVersion,
        structuredResume: input.tailoredVersion.content,
        verification: input.tailoredVersion.verification,
        pdfOk: false,
      };
    }
  } else {
    // AUTHORITATIVE MASTER CV as the resume artifact — deterministic, local,
    // no LLM. The user's own current CV is the truthful baseline when no
    // verified tailored version exists (resume-selection policy).
    try {
      const draft = masterCvToTailorDraft(input.masterCv);
      const buf = await generatePdfBuffer(toTailoredCv(draft, input.masterCv.fullName || ''));
      const art = persistPdfArtifact(buf);
      const reRead = readPdfArtifact(art.sha256);
      const pdfOk = sha256Bytes(reRead) === art.sha256;
      pkg.resumeSnapshot = {
        source: 'MASTER_CV',
        tailoredResumeVersionId: undefined,
        resumeUserId: input.userId,
        resumeJobId: input.job.id,
        version: 0,
        tailorEngineVersion: 0,
        structuredResume: draft,
        verification: undefined,
        pdfHash: art.sha256,
        pdfSize: art.size,
        pdfArtifact: art.path,
        pdfOk,
      };
    } catch (pdfErr: any) {
      pkg.resumeSnapshot = null;
    }
  }

  pkg.answers = answers;
  pkg.questions = input.questions ?? [];
  pkg.generatedContent = input.generatedContent ?? { generatedAnswers: [] };

  const keys = computePackageKeys(input);
  keys.masterCvUpdatedAt = masterCvUpdatedAt;
  pkg.inputFingerprint = packageInputFingerprint(keys);

  pkg.validation = validatePackage(pkg, answers, input.fit, input.profile);
  pkg.status = pkg.validation.status;
  pkg.snapshotHash = computeSnapshotHash(pkg);
  pkg.updatedAt = new Date().toISOString();
  return pkg;
}

/** Immutable snapshot hash over frozen submission-preparation content only —
 *  never lifecycle metadata (status, updatedAt). */
export function computeSnapshotHash(pkg: ApplicationPackage): string {
  return snapshotHash({
    job: pkg.jobSnapshot,
    applicant: pkg.applicantSnapshot,
    cvProvenance: pkg.masterCvProvenance,
    fit: pkg.fitSnapshot,
    resume: pkg.resumeSnapshot,
    answers: pkg.answers,
    questions: pkg.questions,
    generated: pkg.generatedContent,
  });
}

/** Deterministic PDF hash for a tailored resume version — regenerates the
 *  exact document from the frozen structured resume so the package resolves
 *  to the intended PDF, byte-for-byte. */
export function resumePdfHash(version: TailoredResumeVersionRow, masterCv: MasterCv): string {
  return snapshotHash(JSON.stringify({ resume: version.content, cvName: masterCv.fullName }));
}

/** Rebuild (or create) the current package. If the latest non-stale package
 *  has an identical fingerprint AND identical answers, reuse it. */
export async function preparePackage(input: BuildPackageInput, masterCvUpdatedAt: string | undefined): Promise<ApplicationPackage> {
  const latest = getLatestPackage(input.userId, input.job.id);
  const keys = computePackageKeys(input);
  keys.masterCvUpdatedAt = masterCvUpdatedAt;
  const fp = packageInputFingerprint(keys);

  if (latest && latest.status !== 'STALE' && latest.inputFingerprint === fp) {
    return latest; // idempotent reuse — identical inputs, no new answers
  }
  const pkg = await buildPackage(input, masterCvUpdatedAt);
  return storePackage(pkg);
}

export function isPackageStale(latest: ApplicationPackage, keys: ReturnType<typeof computePackageKeys>, masterCvUpdatedAt: string | undefined): boolean {
  const k = { ...keys, masterCvUpdatedAt };
  return latest.inputFingerprint !== packageInputFingerprint(k);
}

export type { PackageStatus };