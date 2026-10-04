// Auto Apply (Experimental) — POC contracts.
//
// These are UI-facing PROJECTIONS over the existing Application Engine
// output (SubmissionPlan / MappedField / consent / manual fields). No engine
// logic lives here; no duplicate provider/answer/artifact types.

import type { PlanStatus } from '../applicationEngine/contract.js';
import type { ReadinessResult } from './submissionReadiness.js';

export type AutoApplyDryRunStatus =
  | 'DRY_RUN_READY'
  | 'PACKAGE_NOT_READY'
  | 'UNSUPPORTED_ATS'
  | 'INSPECTION_FAILED';

export interface AutoApplyFieldPreview {
  providerFieldId: string;
  label: string;
  type: string;
  required: boolean;
  canonicalKey?: string;
  proposedValue: string | number | boolean | string[] | null;
  source: string;
  mappingMethod: string;
  confidence: string;
  requiresUser: boolean;
}

export interface AutoApplyUnresolvedField {
  providerFieldId: string;
  label: string;
  type?: string;
  required: boolean;
  reason: string;
  /** Required unresolved fields always need the user; optional stay informational. */
  requiresUser: boolean;
}

export interface AutoApplyConsentField {
  providerFieldId: string;
  label: string;
  required: boolean;
  classification: string;
  status: 'REQUIRES_REVIEW';
}

export interface AutoApplySensitiveField {
  providerFieldId: string;
  label: string;
  required: boolean;
  reason: string;
}

export interface AutoApplyResumePreview {
  fileName: string | null;
  artifactHash: string | null;
  available: boolean;
  source: 'TAILORED' | 'MASTER_CV' | null;
}

export interface AutoApplySupportingFact {
  id: string;
  source: string;
  summary: string;
}

/** Grounded draft for a GENERATIVE_REQUIRED question. Always review-required;
 *  never promoted to an approved auto-fill value in this phase. */
export interface AutoApplyGeneratedDraft {
  value: string;
  source: 'GENERATED_FROM_CANDIDATE_FACTS';
  requiresUserReview: true;
  supportingFacts: AutoApplySupportingFact[];
  warnings: string[];
  questionCategory: string;
}

/** A question answered from the user's Candidate Answer Bank. */
export interface AutoApplyBankMatch {
  providerFieldId: string;
  label: string;
  matchStatus: 'EXACT' | 'CANONICAL' | 'SEMANTIC';
  value: string | number | boolean | string[] | null;
  source: 'ANSWER_BANK';
  confidence: number;
  requiresReview: boolean;
  matchedAnswerId?: string;
  reason?: string;
}

export interface AutoApplyAnswerBankInfo {
  enabled: boolean;
  matched: AutoApplyBankMatch[];
}

/** Safe generative-pass metadata — counts and duration only, never answers. */
export interface AutoApplyGenerativeMeta {
  engine: string;
  enabled: boolean;
  requested: number;
  generated: number;
  failed: number;
  durationMs: number;
}

/** Advisory classification from a decision engine (e.g. local Laya).
 *  NEVER a generated answer: `proposedValue` can only come from the existing
 *  package answer catalog. `hardBlocked` items are display-only. */
export interface AutoApplySuggestion {
  providerFieldId: string;
  label: string;
  canonicalKey?: string;
  category: string;
  answerSource?: string;
  confidence: number;
  mappingMethod: 'AI_SUGGESTED';
  proposedValue: string | number | boolean | string[] | null;
  valueSource?: string;
  requiresUser: boolean;
  hardBlocked: boolean;
  reason?: string;
  /** Grounded draft (generative pass only; never auto-approved). */
  generatedDraft?: AutoApplyGeneratedDraft;
}

export interface AutoApplyExecutionInfo {
  planId?: string;
  packageId?: string;
  planStatus?: PlanStatus;
  mode: 'dry_run' | 'fill_only' | 'auto_submit';
  /** Browser fill capability enabled server-side (pairing checked at fill). */
  fillEnabled: boolean;
}

/** Safe decision-pass metadata — counts and duration only, never answers. */
export interface AutoApplyDecisionMeta {
  engine: string;
  enabled: boolean;
  evaluated: number;
  suggested: number;
  requiresUser: number;
  failed: number;
  durationMs: number;
}

export interface AutoApplyDryRunResult {
  status: AutoApplyDryRunStatus;
  job: { id: string; title: string; company: string };
  provider: string;
  targetUrl: string | null;
  resume: AutoApplyResumePreview;
  fields: AutoApplyFieldPreview[];
  unresolvedFields: AutoApplyUnresolvedField[];
  consentFields: AutoApplyConsentField[];
  sensitiveFields: AutoApplySensitiveField[];
  /** Advisory engine suggestions for fields the deterministic system could
   *  not resolve. Empty when the decision engine is disabled (default). */
  aiSuggestions: AutoApplySuggestion[];
  decision: AutoApplyDecisionMeta;
  /** Grounded-draft pass metadata. Disabled by default. */
  generative: AutoApplyGenerativeMeta;
  /** Candidate Answer Bank resolution (disabled by default). */
  answerBank: AutoApplyAnswerBankInfo;
  /** Separate submission-readiness gate — field completion alone is NOT it. */
  readiness?: ReadinessResult;
  /** Fill-execution bindings for this job (fill-only phase). */
  execution?: AutoApplyExecutionInfo;
  warnings: string[];
  /** Submission transport does not exist. ALWAYS false — never configurable. */
  submission: { enabled: false };
  planStatus?: PlanStatus;
  message?: string;
}
