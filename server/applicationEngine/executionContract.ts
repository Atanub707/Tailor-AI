// Lever Execution — Phase 0 CONTRACT TYPES (compile-only design).
// NO operational submission code, NO network, NO DB. Pure types + pure
// transition/binding/retry helpers used by Phase 1 tests and design review.

// ── Capability model ─────────────────────────────────────────────────────

export type ProviderCapability =
  | 'INSPECTION_NOT_IMPLEMENTED'
  | 'READ_ONLY_INSPECTION_SUPPORTED'
  | 'EXECUTION_RESEARCHED'
  | 'DRY_RUN_EXECUTION_SUPPORTED'
  | 'ASSISTED_SUBMISSION_SUPPORTED'
  | 'AUTO_SUBMISSION_SUPPORTED'
  | 'MANUAL_ONLY';

export const LEVER_CAPABILITY: Record<string, ProviderCapability> = {
  inspection: 'READ_ONLY_INSPECTION_SUPPORTED',
  executionResearch: 'EXECUTION_RESEARCHED',
  dryRun: 'DRY_RUN_EXECUTION_SUPPORTED',
  assistedSubmission: 'ASSISTED_SUBMISSION_SUPPORTED',
  autoSubmission: 'AUTO_SUBMISSION_SUPPORTED',
};

// ── Consent / approval ───────────────────────────────────────────────────

export type ConsentClassification =
  | 'LEGAL_CONSENT'
  | 'REQUIRED_ACKNOWLEDGEMENT'
  | 'OPTIONAL_MARKETING'
  | 'OPTIONAL_COMMUNICATION'
  | 'UNKNOWN_CONSENT';

/** Phase-0 evidence: consent[marketing] is an OPTIONAL marketing opt-in, not
 *  legal consent. Classify conservatively: only explicit legal wording maps
 *  to LEGAL_CONSENT/REQUIRED_ACKNOWLEDGEMENT; everything else is optional or
 *  unknown (unknown → review). */
export function classifyConsent(providerFieldId: string, label: string): ConsentClassification {
  const t = `${providerFieldId} ${label}`.toLowerCase();
  if (/marketing|future job opportunities|contact me|job alerts|newsletter/.test(t)) return 'OPTIONAL_MARKETING';
  if (/communication|updates about your application|interview updates/.test(t)) return 'OPTIONAL_COMMUNICATION';
  if (/acknowledg|privacy|terms of use|terms and conditions|data processing|consent to|declare|background check|candidate agreement|agree to the/.test(t)) return 'LEGAL_CONSENT';
  if (/required acknowledgement|acknowledge receipt/.test(t)) return 'REQUIRED_ACKNOWLEDGEMENT';
  return 'UNKNOWN_CONSENT';
}

export interface ConsentApproval {
  providerFieldId: string;
  classification: ConsentClassification;
  legalTextHash?: string;
  selectedValue: boolean | string;
  approvedAt: string;
}

export interface ApplicationApproval {
  id: string;
  userId: string;
  planId: string;
  packageId: string;
  planFingerprint: string;
  packageSnapshotHash: string;
  requirementsFingerprint: string;
  resumeArtifactHash: string;
  mappedFieldsHash: string;
  consents: ConsentApproval[];
  status: 'ACTIVE' | 'REVOKED';
  approvedAt: string;
  createdAt: string;
}

// ── Execution attempt ────────────────────────────────────────────────────

export type AttemptStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PREPARING'
  | 'READY_FOR_DRY_RUN'
  | 'MANUAL_ACTION_REQUIRED'
  | 'BLOCKED'
  | 'CANCELLED'
  // Phase 2 (Browser Companion): user-triggered submission lifecycle.
  | 'READY_FOR_USER_SUBMISSION'
  | 'SUBMISSION_OBSERVED'
  // Future transport states — Phase 1 MUST NEVER enter these.
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'SUCCESS_UNCONFIRMED';

/** States the Phase-1 runtime may actually enter. */
export const PHASE1_ENTERABLE_STATES: AttemptStatus[] = [
  'PENDING_APPROVAL', 'APPROVED', 'PREPARING', 'READY_FOR_DRY_RUN',
  'MANUAL_ACTION_REQUIRED', 'BLOCKED', 'CANCELLED',
  'READY_FOR_USER_SUBMISSION', 'SUBMISSION_OBSERVED',
];

export interface ApplicationAttempt {
  id: string;
  userId: string;
  planId: string;
  packageId: string;
  provider: string;
  externalJobId: string;
  executionKey: string;
  planFingerprint: string;
  packageSnapshotHash: string;
  requirementsFingerprint: string;
  approvalId: string;
  status: AttemptStatus;
  transportAttemptCount: number;
  verification?: SubmissionVerification;
  failure?: ExecutionFailure;
  startedAt: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Provider execution context (transient) ───────────────────────────────

export interface ProviderExecutionContext {
  provider: 'lever';
  targetUrl: string;
  semanticRequirementsFingerprint: string;
  volatileTransport: Record<string, string>; // hidden metadata, tokens — memory only
  inspectedAt: string;
  adapterVersion: string;
}

// ── Multipart dry-run payload (normalized, no bytes in preview) ──────────

export type TransportClassification = 'REQUIRED' | 'OPTIONAL' | 'TRACKING' | 'UNKNOWN';

export interface MultipartTextPart {
  kind: 'TEXT';
  name: string;
  value: string;
  classification: TransportClassification;
  semantic: boolean; // affects payloadFingerprint
}

export interface MultipartFilePart {
  kind: 'FILE';
  name: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  artifactReference: string;
}

export type MultipartPart = MultipartTextPart | MultipartFilePart;

export interface MultipartPayload {
  target: string;
  method: 'POST';
  parts: MultipartPart[];
  captcha: { present: boolean; provider?: string; requiredForSubmission: boolean };
  omittedTracking: string[];
  executionEligible: boolean;
}

// ── Verification / receipt ───────────────────────────────────────────────

export interface SubmissionVerification {
  status: 'PROVIDER_CONFIRMED' | 'SUCCESS_UNCONFIRMED' | 'REJECTED';
  providerApplicationId?: string;
  confirmationUrl?: string;
  confirmationMarker?: string;
  evidenceHash: string;
}

export interface ApplicationReceipt {
  attemptId: string;
  provider: string;
  externalJobId: string;
  company: string;
  title: string;
  packageId: string;
  planId: string;
  submittedAt: string;
  verification: SubmissionVerification;
  resumeArtifactHash: string;
  answersFingerprint: string;
}

// ── Failures / retry classification ──────────────────────────────────────

export type ExecutionFailureKind =
  | 'PLAN_NOT_READY'
  | 'PLAN_CHANGED'
  | 'PACKAGE_STALE'
  | 'FORM_CHANGED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'CONSENT_REQUIRED'
  | 'MANUAL_ACTION_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'PROVIDER_CHALLENGE'
  | 'VALIDATION_FAILED'
  | 'UPLOAD_FAILED'
  | 'PROVIDER_REJECTED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSPORT_FAILED_PRE_SEND'
  | 'SUCCESS_UNCONFIRMED'
  | 'DUPLICATE_BLOCKED'
  | 'VERIFICATION_FAILED'
  | 'UNKNOWN';

export type RetryClass =
  | 'SAFE_RETRY'
  | 'REQUIRES_REINSPECTION'
  | 'REQUIRES_USER_REVIEW'
  | 'NEVER_AUTO_RETRY'
  | 'MANUAL_ONLY';

const RETRY_MATRIX: Record<ExecutionFailureKind, RetryClass> = {
  PLAN_NOT_READY: 'REQUIRES_USER_REVIEW',
  PLAN_CHANGED: 'REQUIRES_USER_REVIEW',
  PACKAGE_STALE: 'REQUIRES_USER_REVIEW',
  FORM_CHANGED: 'REQUIRES_REINSPECTION',
  APPROVAL_REQUIRED: 'REQUIRES_USER_REVIEW',
  APPROVAL_STALE: 'REQUIRES_USER_REVIEW',
  CONSENT_REQUIRED: 'REQUIRES_USER_REVIEW',
  MANUAL_ACTION_REQUIRED: 'MANUAL_ONLY',
  CAPTCHA_REQUIRED: 'MANUAL_ONLY',
  PROVIDER_CHALLENGE: 'MANUAL_ONLY',
  VALIDATION_FAILED: 'REQUIRES_USER_REVIEW',
  UPLOAD_FAILED: 'NEVER_AUTO_RETRY',
  PROVIDER_REJECTED: 'NEVER_AUTO_RETRY',
  RATE_LIMITED: 'REQUIRES_REINSPECTION',
  PROVIDER_UNAVAILABLE: 'REQUIRES_REINSPECTION',
  TRANSPORT_FAILED_PRE_SEND: 'SAFE_RETRY',
  SUCCESS_UNCONFIRMED: 'NEVER_AUTO_RETRY',
  DUPLICATE_BLOCKED: 'NEVER_AUTO_RETRY',
  VERIFICATION_FAILED: 'NEVER_AUTO_RETRY',
  UNKNOWN: 'NEVER_AUTO_RETRY',
};

export function retryClass(kind: ExecutionFailureKind): RetryClass {
  return RETRY_MATRIX[kind];
}

export interface ExecutionFailure {
  kind: ExecutionFailureKind;
  message: string;
  retryClass: RetryClass;
  occurredAt: string;
}

// ── State machine (pure) ─────────────────────────────────────────────────

export const EXECUTION_TRANSITIONS: Record<AttemptStatus, AttemptStatus[]> = {
  PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
  APPROVED: ['PREPARING', 'CANCELLED', 'BLOCKED'],
  PREPARING: ['READY_FOR_DRY_RUN', 'SUBMITTING', 'MANUAL_ACTION_REQUIRED', 'BLOCKED', 'CANCELLED'],
  READY_FOR_DRY_RUN: ['SUBMITTING', 'CANCELLED', 'MANUAL_ACTION_REQUIRED', 'READY_FOR_USER_SUBMISSION'],
  READY_FOR_USER_SUBMISSION: ['SUBMISSION_OBSERVED', 'MANUAL_ACTION_REQUIRED', 'BLOCKED', 'CANCELLED'],
  SUBMISSION_OBSERVED: ['SUBMITTED', 'SUCCESS_UNCONFIRMED', 'FAILED', 'MANUAL_ACTION_REQUIRED'],
  MANUAL_ACTION_REQUIRED: ['PENDING_APPROVAL', 'READY_FOR_USER_SUBMISSION', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['CANCELLED'],
  CANCELLED: [],
  // Future transport states — modeled, never entered in Phase 1.
  SUBMITTING: ['SUBMITTED', 'SUCCESS_UNCONFIRMED', 'FAILED', 'MANUAL_ACTION_REQUIRED'],
  SUBMITTED: [],
  SUCCESS_UNCONFIRMED: [],
  FAILED: ['MANUAL_ACTION_REQUIRED'],
};

export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export const TERMINAL_STATES: AttemptStatus[] = ['SUBMITTED', 'SUCCESS_UNCONFIRMED', 'CANCELLED'];

/** Phase-1 guard: mutation states must never be entered by the runtime. */
export function assertPhase1Transition(from: AttemptStatus, to: AttemptStatus): void {
  if (!PHASE1_ENTERABLE_STATES.includes(to)) {
    throw new Error(`Phase 1 forbids entering state ${to} (from ${from}).`);
  }
}

export function isTerminal(s: AttemptStatus): boolean {
  return TERMINAL_STATES.includes(s);
}

/** Crash recovery: an attempt found in SUBMITTING after restart can NEVER
 *  be treated as FAILED or resubmitted — it becomes SUCCESS_UNCONFIRMED
 *  unless provider verification proves the outcome. */
export function recoverFromCrash(status: AttemptStatus): AttemptStatus {
  if (status === 'SUBMITTING') return 'SUCCESS_UNCONFIRMED';
  return status;
}

// ── Approval binding (pure) ──────────────────────────────────────────────

/** The approval is valid ONLY if every bound fingerprint still matches the
 *  current plan/package/resume. Any drift → stale. */
export function isApprovalValid(
  approval: ApplicationApproval,
  current: {
    planId: string;
    planFingerprint: string;
    packageSnapshotHash: string;
    requirementsFingerprint: string;
    resumeArtifactHash: string;
    mappedFieldsHash: string;
  },
): boolean {
  return (
    approval.planId === current.planId &&
    approval.planFingerprint === current.planFingerprint &&
    approval.packageSnapshotHash === current.packageSnapshotHash &&
    approval.requirementsFingerprint === current.requirementsFingerprint &&
    approval.resumeArtifactHash === current.resumeArtifactHash &&
    approval.mappedFieldsHash === current.mappedFieldsHash &&
    approval.consents.every((c) => c.selectedValue === true && (c.classification === 'OPTIONAL_MARKETING' || c.classification === 'OPTIONAL_COMMUNICATION' || (c.legalTextHash?.length ?? 0) === 64))
  );
}

/** A consent approval is bound to the exact legal text: if the text (or its
 *  hash) changes, the old approval no longer applies. */
export function consentCovers(approval: ConsentApproval, providerFieldId: string, legalTextHash: string): boolean {
  return approval.providerFieldId === providerFieldId && approval.legalTextHash === legalTextHash && approval.selectedValue === true;
}

/** OPTIONAL_MARKETING/OPTIONAL_COMMUNICATION never block execution. */
export function consentBlocksExecution(classification: ConsentClassification): boolean {
  return classification === 'LEGAL_CONSENT' || classification === 'REQUIRED_ACKNOWLEDGEMENT' || classification === 'UNKNOWN_CONSENT';
}

// ── Integrity gate (pure) ────────────────────────────────────────────────

/** All-or-nothing pre-submit integrity: any mismatch → NO POST. */
export function integrityGate(
  check: {
    userIdMatches: boolean;
    packageBelongs: boolean;
    snapshotHash: boolean;
    planFingerprint: boolean;
    requirementsFingerprint: boolean;
    approvalValid: boolean;
    resumeArtifactVerified: boolean;
    targetMatches: boolean;
    adapterMatches: boolean;
  },
): { ok: true } | { ok: false; reason: ExecutionFailureKind } {
  if (!check.userIdMatches || !check.packageBelongs) return { ok: false, reason: 'PLAN_NOT_READY' };
  if (!check.snapshotHash) return { ok: false, reason: 'PACKAGE_STALE' };
  if (!check.planFingerprint) return { ok: false, reason: 'PLAN_CHANGED' };
  if (!check.requirementsFingerprint) return { ok: false, reason: 'FORM_CHANGED' };
  if (!check.approvalValid) return { ok: false, reason: 'APPROVAL_STALE' };
  if (!check.resumeArtifactVerified) return { ok: false, reason: 'VALIDATION_FAILED' };
  if (!check.targetMatches || !check.adapterMatches) return { ok: false, reason: 'PLAN_CHANGED' };
  return { ok: true };
}