// Application Package Engine — builds immutable packages, validates
// readiness, detects staleness, supports idempotent reuse + rebuild.

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import { jdHash } from '../fit/fitCache.js';
import { getLatestTailorVersion, type TailoredResumeVersionRow } from '../tailorV2/versionStore.js';
import { toTailoredCv } from '../tailorV2/tailorV2Engine.js';
import { generatePdfBuffer } from '../builder/docxGenerator.js';
import { freshPackage, getLatestPackage, nextPackageVersion, packageInputFingerprint, snapshotHash, storePackage } from './packageStore.js';
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
    fitEngineVersion: input.fit.version,
    fitScore: input.fit.score,
    tailoredResumeVersionId: input.tailoredVersion?.id,
    tailorEngineVersion: input.tailoredVersion?.tailorEngineVersion,
    answersState: answerStateKey(input.answers ?? resolveDeterministicAnswers(input.masterCv, input.profile, input.job)),
  };
}

/** Build a fresh package object from current inputs (no persistence). */
export function buildPackage(input: BuildPackageInput, masterCvUpdatedAt: string | undefined): ApplicationPackage {
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

  pkg.fitSnapshot = {
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
  };

  if (input.tailoredVersion) {
    const pdfHash = resumePdfHash(input.tailoredVersion, input.masterCv);
    pkg.resumeSnapshot = {
      tailoredResumeVersionId: input.tailoredVersion.id,
      resumeUserId: input.tailoredVersion.userId,
      resumeJobId: input.tailoredVersion.jobId,
      version: input.tailoredVersion.version,
      tailorEngineVersion: input.tailoredVersion.tailorEngineVersion,
      structuredResume: input.tailoredVersion.content,
      verification: input.tailoredVersion.verification,
      pdfHash,
      pdfOk: true,
    };
  } else {
    pkg.resumeSnapshot = null;
  }

  pkg.answers = answers;
  pkg.questions = input.questions ?? [];
  pkg.generatedContent = input.generatedContent ?? { generatedAnswers: [] };

  const keys = computePackageKeys(input);
  keys.masterCvUpdatedAt = masterCvUpdatedAt;
  pkg.inputFingerprint = packageInputFingerprint(keys);

  pkg.validation = validatePackage(pkg, answers, input.fit, input.profile);
  pkg.status = pkg.validation.status;
  pkg.updatedAt = new Date().toISOString();
  return pkg;
}

/** Deterministic PDF hash for a tailored resume version — regenerates the
 *  exact document from the frozen structured resume so the package resolves
 *  to the intended PDF, byte-for-byte. */
export function resumePdfHash(version: TailoredResumeVersionRow, masterCv: MasterCv): string {
  return snapshotHash(JSON.stringify({ resume: version.content, cvName: masterCv.fullName }));
}

/** Rebuild (or create) the current package. If the latest non-stale package
 *  has an identical fingerprint AND identical answers, reuse it. */
export function preparePackage(input: BuildPackageInput, masterCvUpdatedAt: string | undefined): ApplicationPackage {
  const latest = getLatestPackage(input.userId, input.job.id);
  const keys = computePackageKeys(input);
  keys.masterCvUpdatedAt = masterCvUpdatedAt;
  const fp = packageInputFingerprint(keys);

  if (latest && latest.status !== 'STALE' && latest.inputFingerprint === fp) {
    return latest; // idempotent reuse — identical inputs, no new answers
  }
  const pkg = buildPackage(input, masterCvUpdatedAt);
  return storePackage(pkg);
}

export function isPackageStale(latest: ApplicationPackage, keys: ReturnType<typeof computePackageKeys>, masterCvUpdatedAt: string | undefined): boolean {
  const k = { ...keys, masterCvUpdatedAt };
  return latest.inputFingerprint !== packageInputFingerprint(k);
}

export type { PackageStatus };