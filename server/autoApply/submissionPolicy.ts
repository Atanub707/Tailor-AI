/**
 * Auto Apply Phase 5 — Controlled Auto Submit: submission POLICY (pure, no I/O).
 *
 * Safety invariants (non-negotiable):
 *  - AUTO_APPLY_SUBMIT_ENABLED defaults to FALSE. Nothing here enables submission.
 *  - safe_auto is CLAMPED DOWN to explicit_approval unless AUTO_APPLY_SAFE_AUTO_PROMOTED=true
 *    (the promotion gate: only after explicit-approval live Stage A passes end-to-end).
 *  - Every blocker is collected (never short-circuit) so the UI can show the full picture.
 *  - The extension never bypasses CAPTCHA / OTP / MFA / login / legal consent. Policy
 *    simply refuses to submit while those are pending.
 *  - No PII crosses this module: inputs are booleans, counts and opaque fingerprints.
 */

export type SubmissionMode = 'manual_review' | 'explicit_approval' | 'safe_auto';

export type SubmissionBlocker =
  | 'UNRESOLVED_REQUIRED_FIELD'
  | 'FIELD_MISMATCH'
  | 'FIELD_NOT_FOUND'
  | 'FIELD_UNVERIFIABLE'
  | 'NEW_REQUIRED_FIELD'
  | 'RESUME_NOT_VERIFIED'
  | 'CAPTCHA_REQUIRED'
  | 'OTP_REQUIRED'
  | 'MFA_REQUIRED'
  | 'LOGIN_REQUIRED'
  | 'REQUIRED_CONSENT_UNAPPROVED'
  | 'EEO_REQUIRES_REVIEW'
  | 'LEGAL_ATTESTATION'
  | 'FORM_CHANGED'
  | 'JOB_CHANGED'
  | 'SESSION_STALE'
  | 'APPLICATION_ALREADY_SUBMITTED'
  | 'PRIOR_SUBMISSION_UNVERIFIED'
  | 'PROVIDER_UNSUPPORTED'
  | 'USER_AUTO_SUBMIT_DISABLED'
  | 'SUBMIT_DISABLED'
  | 'VERIFICATION_MISSING'
  | 'ATTEMPT_NOT_READY'
  | 'PLAN_DRIFT'
  | 'REQUIREMENTS_DRIFT'
  | 'ANSWER_UNAPPROVED'
  | 'ANSWER_STALE';

export interface SubmissionInputs {
  /** Provider slug; auto-submit is LEVER ONLY. */
  provider: string;
  /** Effective, already-clamped mode from {@link loadSubmissionConfig}. */
  mode: SubmissionMode;
  /** AUTO_APPLY_SUBMIT_ENABLED — top-level gate. */
  submitFeatureEnabled: boolean;
  /** AUTO_APPLY_SAFE_AUTO_PROMOTED — promotion gate for safe_auto only. */
  safeAutoPromoted: boolean;
  /** Explicit per-user opt-in (stored pref). Required for SAFE_AUTO, not for EXPLICIT_APPROVAL. */
  userAutoSubmitEnabled: boolean;
  /** Posting identity (hostname/slug/posting id) of the live page matches the plan target. */
  postingMatches: boolean;
  /** Plan fingerprint of the latest verification evidence matches the current plan. */
  planFingerprintMatches: boolean;
  /** Requirements fingerprint matches the current inspection. */
  requirementsFingerprintMatches: boolean;
  /** Active companion session bound to this attempt (same session the fill ran under). */
  sessionBound: boolean;
  /** Backend attempt status is READY_FOR_USER_SUBMISSION. */
  attemptReady: boolean;
  /** A FILL_VERIFICATION_COMPLETED read-back exists for this attempt. */
  verificationPresent: boolean;
  /** Compact plan-ordered status string: V=verified, A=already-correct, M=mismatch, N=not-found, U=unverifiable, B=blocked. */
  statuses: string;
  /** Exact resume attachment was part of the verified read-back. */
  resumeVerified: boolean;
  captchaPending: boolean;
  otpPending: boolean;
  mfaPending: boolean;
  loginPending: boolean;
  /** Fields newly required after verification (form mutated). */
  newRequiredFields: number;
  /** Form mutated since the verification read-back. */
  formMutatedSinceVerification: boolean;
  /** A REQUIRED legal consent is not user-approved. */
  requiredConsentUnapproved: boolean;
  /** Sensitive voluntary EEO question needs review (never auto-answered). */
  eeoRequiresReview: boolean;
  /** Ambiguous legal attestation pending. */
  legalAttestationUnapproved: boolean;
  /** Generated answers not yet user-approved. */
  unapprovedGeneratedAnswers: number;
  /** Stale Answer Bank answers detected. */
  staleBankAnswers: number;
  /** A receipt or SUBMITTED attempt already exists for this job/attempt. */
  alreadySubmitted: boolean;
  /** Previous SUBMITTED_UNVERIFIED exists for this attempt: never blind-retry. */
  priorUnverified: boolean;
}

export type SubmissionDecision =
  | { allowed: true; mode: 'EXPLICIT_APPROVAL' | 'SAFE_AUTO' }
  | { allowed: false; blockerCodes: SubmissionBlocker[] };

export interface SubmissionConfig {
  enabled: boolean;
  mode: SubmissionMode;
  safeAutoPromoted: boolean;
}

/** Read + clamp config. Defaults are the safest possible; nothing is inferred from AA usage. */
export function loadSubmissionConfig(env: Record<string, string | undefined> = process.env): SubmissionConfig {
  const safeAutoPromoted = env.AUTO_APPLY_SAFE_AUTO_PROMOTED === 'true';
  const enabled = env.AUTO_APPLY_SUBMIT_ENABLED === 'true';
  const raw = String(env.AUTO_APPLY_SUBMIT_MODE || 'manual_review');
  let mode: SubmissionMode =
    raw === 'explicit_approval' || raw === 'safe_auto' ? raw : 'manual_review';
  if (!enabled) mode = 'manual_review';
  if (mode === 'safe_auto' && !safeAutoPromoted) mode = 'explicit_approval';
  return { enabled, mode, safeAutoPromoted };
}

const PASS_LETTERS = new Set(['V', 'A']);

/** Map the lever.js compact status string to blocker codes (all of them). */
export function blockersFromStatuses(statuses: string): SubmissionBlocker[] {
  const out: SubmissionBlocker[] = [];
  const seen = new Set<string>();
  for (const ch of statuses) {
    if (PASS_LETTERS.has(ch)) continue;
    const code: SubmissionBlocker =
      ch === 'M' ? 'FIELD_MISMATCH'
      : ch === 'N' ? 'FIELD_NOT_FOUND'
      : ch === 'U' ? 'FIELD_UNVERIFIABLE'
      : ch === 'B' ? 'UNRESOLVED_REQUIRED_FIELD'
      : 'FIELD_UNVERIFIABLE';
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/**
 * The per-job submission gate. Returns EVERY blocker (never short-circuits).
 * allowed=true only when the list is empty AND the mode is eligible.
 */
export function computeSubmissionDecision(inputs: SubmissionInputs): SubmissionDecision {
  const blockers: SubmissionBlocker[] = [];

  // 1. Feature + provider scope.
  if (!inputs.submitFeatureEnabled || inputs.mode === 'manual_review') blockers.push('SUBMIT_DISABLED');
  if (inputs.provider !== 'lever') blockers.push('PROVIDER_UNSUPPORTED');

  // 2. Identity + plan integrity.
  if (!inputs.postingMatches) blockers.push('JOB_CHANGED');
  if (!inputs.planFingerprintMatches) blockers.push('PLAN_DRIFT');
  if (!inputs.requirementsFingerprintMatches) blockers.push('REQUIREMENTS_DRIFT');
  if (inputs.formMutatedSinceVerification) blockers.push('FORM_CHANGED');
  if (inputs.newRequiredFields > 0) blockers.push('NEW_REQUIRED_FIELD');

  // 3. Attempt + session.
  if (!inputs.sessionBound) blockers.push('SESSION_STALE');
  if (!inputs.attemptReady) blockers.push('ATTEMPT_NOT_READY');

  // 4. Verification completeness — every required field VERIFIED or ALREADY_CORRECT.
  if (!inputs.verificationPresent || inputs.statuses.length === 0) {
    blockers.push('VERIFICATION_MISSING');
  } else {
    for (const b of blockersFromStatuses(inputs.statuses)) blockers.push(b);
  }
  if (!inputs.resumeVerified) blockers.push('RESUME_NOT_VERIFIED');

  // 5. Human checkpoints — never bypassed, only paused on.
  if (inputs.captchaPending) blockers.push('CAPTCHA_REQUIRED');
  if (inputs.otpPending) blockers.push('OTP_REQUIRED');
  if (inputs.mfaPending) blockers.push('MFA_REQUIRED');
  if (inputs.loginPending) blockers.push('LOGIN_REQUIRED');

  // 6. Consent + sensitive/legal review.
  if (inputs.requiredConsentUnapproved) blockers.push('REQUIRED_CONSENT_UNAPPROVED');
  if (inputs.eeoRequiresReview) blockers.push('EEO_REQUIRES_REVIEW');
  if (inputs.legalAttestationUnapproved) blockers.push('LEGAL_ATTESTATION');

  // 7. Answer hygiene.
  if (inputs.unapprovedGeneratedAnswers > 0) blockers.push('ANSWER_UNAPPROVED');
  if (inputs.staleBankAnswers > 0) blockers.push('ANSWER_STALE');

  // 8. Duplicate protection — before anything else can pass.
  if (inputs.alreadySubmitted) blockers.push('APPLICATION_ALREADY_SUBMITTED');
  if (inputs.priorUnverified) blockers.push('PRIOR_SUBMISSION_UNVERIFIED');

  // 9. Mode eligibility.
  if (inputs.mode === 'safe_auto') {
    if (!inputs.safeAutoPromoted) blockers.push('SUBMIT_DISABLED');
    if (!inputs.userAutoSubmitEnabled) blockers.push('USER_AUTO_SUBMIT_DISABLED');
  }

  const unique = Array.from(new Set(blockers));
  if (unique.length > 0) return { allowed: false, blockerCodes: unique };
  return { allowed: true, mode: inputs.mode === 'safe_auto' ? 'SAFE_AUTO' : 'EXPLICIT_APPROVAL' };
}

/** User-facing, PII-free one-liner for the first blocker (UI helper). */
export function describeBlocker(code: SubmissionBlocker): string {
  switch (code) {
    case 'CAPTCHA_REQUIRED': return 'CAPTCHA needs your attention in the browser.';
    case 'OTP_REQUIRED': return 'A verification code is required.';
    case 'MFA_REQUIRED': return 'Multi-factor authentication is required.';
    case 'LOGIN_REQUIRED': return 'The application requires you to log in first.';
    case 'REQUIRED_CONSENT_UNAPPROVED': return 'A required consent needs your review.';
    case 'EEO_REQUIRES_REVIEW': return 'A voluntary demographic question needs your review.';
    case 'LEGAL_ATTESTATION': return 'A legal attestation needs your review.';
    case 'APPLICATION_ALREADY_SUBMITTED': return 'This application was already submitted.';
    case 'PRIOR_SUBMISSION_UNVERIFIED': return 'A previous submission may have gone through — check the site before retrying.';
    case 'USER_AUTO_SUBMIT_DISABLED': return 'Auto Submit is off in your settings.';
    case 'SUBMIT_DISABLED': return 'Submission is not enabled.';
    case 'PROVIDER_UNSUPPORTED': return 'Auto Submit supports Lever only.';
    case 'FORM_CHANGED': return 'The form changed since verification. Recheck this job.';
    case 'JOB_CHANGED': return 'The job posting changed. Recheck this job.';
    case 'RESUME_NOT_VERIFIED': return 'The resume attachment was not verified.';
    default: return 'Review required before submission.';
  }
}
