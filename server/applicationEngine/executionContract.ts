// Lever Execution — Phase 0 CONTRACT TYPES (compile-only design).
// NO operational submission code, NO network, NO DB. Pure types + pure
// transition/binding/retry helpers used by Phase 1 tests and design review.

// ── Capability model ─────────────────────────────────────────────────────

export type ProviderCapability =
  | 'INSPECTION_NOT_IMPLEMENTED'
  | 'READ_ONLY_INSPECTION_SUPPORTED'
  | 'EXECUTION_RESEARCHED'
  | 'ASSISTED_SUBMISSION_SUPPORTED'
  | 'AUTO_SUBMISSION_SUPPORTED'
  | 'MANUAL_ONLY';

// ── Consent / approval ───────────────────────────────────────────────────

export interface ConsentApproval {
  fieldId: string;
  legalText: string;
  legalTextHash: string;
  approvedByUser: boolean;
  approvedAt: string;
}

export interface ApplicationApproval {
  id: string;
  planId: string;
  planFingerprint: string;
  packageSnapshotHash: string;
  requirementsFingerprint: string;
  resumeArtifactHash: string;
  mappedFieldsHash: string;
  consents: ConsentApproval[];
  approvedAt: string;
}

// ── Execution attempt ────────────────────────────────────────────────────

export type AttemptStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PREPARING'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'MANUAL_ACTION_REQUIRED'
  | 'SUCCESS_UNCONFIRMED'
  | 'CANCELLED';

export interface ApplicationAttempt {
  id: string;
  userId: string;
  planId: string;
  packageId: string;
  provider: string;
  externalJobId: string;
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
  APPROVED: ['PREPARING', 'CANCELLED', 'FAILED'],
  PREPARING: ['SUBMITTING', 'FAILED', 'MANUAL_ACTION_REQUIRED', 'CANCELLED'],
  SUBMITTING: ['SUBMITTED', 'SUCCESS_UNCONFIRMED', 'FAILED', 'MANUAL_ACTION_REQUIRED'],
  SUBMITTED: [],                       // terminal
  SUCCESS_UNCONFIRMED: [],             // terminal — never auto-resubmit
  FAILED: ['MANUAL_ACTION_REQUIRED'],  // user may re-approach manually
  MANUAL_ACTION_REQUIRED: ['PENDING_APPROVAL'], // new approval cycle only
  CANCELLED: [],                       // terminal
};

export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export const TERMINAL_STATES: AttemptStatus[] = ['SUBMITTED', 'SUCCESS_UNCONFIRMED', 'CANCELLED'];

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
    approval.consents.length > 0 &&
    approval.consents.every((c) => c.approvedByUser && c.legalTextHash.length === 64)
  );
}

/** A consent approval is bound to the exact legal text: if the text (or its
 *  hash) changes, the old approval no longer applies. */
export function consentCovers(approval: ConsentApproval, fieldId: string, legalTextHash: string): boolean {
  return approval.fieldId === fieldId && approval.legalTextHash === legalTextHash && approval.approvedByUser;
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