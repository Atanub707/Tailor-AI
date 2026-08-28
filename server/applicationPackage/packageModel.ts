// Application Package V1 — canonical, immutable, locally-stored snapshot of
// EXACTLY what the user intends to submit. Preparation only: no submission.
//
// Responsibilities:
//   * freeze job/JD + applicant profile + Master CV provenance + Fit +
//     exact verified Tailor V2 resume + PDF association
//   * resolve canonical deterministic application answers
//   * optional LLM-generated answers/cover letter, verified before use
//   * centralized readiness validator (DRAFT / NEEDS_INPUT / READY / STALE)
//
// The future Application Engine answers "how do we submit?"; ATS adapters
// answer "how does this ATS represent these fields?". Neither exists here.

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import type { TailorDraft } from '../tailorV2/drafter.js';
import type { TailorVerification } from '../tailorV2/verifier.js';
import type { TailoredResumeVersionRow } from '../tailorV2/versionStore.js';

export type PackageStatus = 'DRAFT' | 'NEEDS_INPUT' | 'READY' | 'STALE';
export const PACKAGE_VERSION = 1;

export interface ResolvedAnswer {
  key: string;
  value: string | number | boolean | string[] | null;
  source: 'PROFILE' | 'MASTER_CV' | 'TAILORED_RESUME' | 'USER' | 'GENERATED';
  status: 'RESOLVED' | 'MISSING' | 'NEEDS_INPUT';
  label: string;
}

export interface ApplicationQuestion {
  id: string;
  question: string;
  type: 'text' | 'textarea' | 'boolean' | 'single-select' | 'multi-select' | 'number' | 'date';
  required: boolean;
  answer?: string | number | boolean | string[] | null;
  source?: ResolvedAnswer['source'];
  status?: ResolvedAnswer['status'];
}

export interface PackageValidation {
  ready: boolean;
  status: PackageStatus;
  missingFields: string[];
  needsInput: string[];
  blockers: string[];
  warnings: string[];
}

export interface ApplicationPackage {
  id: string;
  userId: string;
  jobId: string;
  version: number;
  status: PackageStatus;
  jobSnapshot: {
    jobId: string;
    externalJobId?: string;
    platform?: string;
    source?: string;
    company: string;
    title: string;
    location?: string;
    workMode?: string;
    employmentType?: string;
    applyUrl?: string;
    jobUrl?: string;
    postedDate?: string;
    jd: string;
    jdHash: string;
  };
  applicantSnapshot: {
    profileUpdatedAt?: string;
    personal: Record<string, unknown>;
    contact: Record<string, unknown>;
    links: Record<string, unknown>;
    locationPrefs: Record<string, unknown>;
    workAuthorization: Record<string, unknown>;
    preferences: Record<string, unknown>;
    applicationDefaults: Record<string, unknown>;
  };
  masterCvProvenance: {
    masterCvUpdatedAt?: string;
    masterCvHash?: string;
  };
  fitSnapshot: {
    score: number;
    grade: string;
    categories?: Record<string, unknown>;
    strengths: string[];
    gaps: string[];
    blockers: string[];
    unknowns: string[];
    assessmentCoverage?: Record<string, unknown>;
    engineVersion?: number;
    calculatedAt?: string;
  };
  resumeSnapshot: {
    tailoredResumeVersionId?: string;
    resumeUserId?: string;
    resumeJobId?: string;
    version?: number;
    tailorEngineVersion?: number;
    structuredResume?: TailorDraft;
    verification?: TailorVerification;
    pdfHash?: string;
    pdfOk?: boolean;
  } | null;
  answers: ResolvedAnswer[];
  questions: ApplicationQuestion[];
  generatedContent: {
    coverLetter?: { text: string; verified: boolean };
    generatedAnswers: Array<{ questionId: string; answer: string; verified: boolean }>;
  };
  validation: PackageValidation;
  inputFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export function defaultValidation(): PackageValidation {
  return { ready: false, status: 'DRAFT', missingFields: [], needsInput: [], blockers: [], warnings: [] };
}