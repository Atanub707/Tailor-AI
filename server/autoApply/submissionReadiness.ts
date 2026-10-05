// Auto Apply — Submission Readiness Engine.
//
// DELIBERATELY SEPARATE from "all visible fields contain values".
// Field completion ≠ safe to submit. `canSubmit` is the ONLY auto-submit
// gate and requires every policy condition below; `canFill` only describes
// whether the companion may fill the known/approved values.

import type { PlanStatus } from '../applicationEngine/contract.js';

export type ReadinessStatus = 'READY' | 'NEEDS_USER_INPUT' | 'NEEDS_REVIEW' | 'BLOCKED' | 'UNSUPPORTED';

export type ExecutionMode = 'dry_run' | 'fill_only' | 'auto_submit';

export interface ReadinessInput {
  provider: string;
  planStatus?: PlanStatus;
  totalRequiredFields: number;
  resolvedRequiredFields: number;
  /** Required questions with no resolved answer (labels). */
  unresolvedRequired: string[];
  /** Values present but awaiting explicit user review (labels + reason). */
  reviewRequired: Array<{ label: string; reason: string }>;
  /** Fields that can only be answered manually (labels). */
  manualOnlyFields: string[];
  /** Consent/legal acknowledgements (required ones block submission). */
  consentFields: Array<{ label: string; required: boolean }>;
  /** Sensitive/EEO fields (labels). */
  sensitiveFields: string[];
  captchaPresent: boolean;
  otpRequired: boolean;
  loginRequired: boolean;
  unsupportedRequiredUpload: boolean;
  resumeReady: boolean;
  artifactVerified: boolean;
  pageStillMatchesPlan: boolean;
  /** Companion pairing/session available (runtime check). */
  companionReady: boolean;
  autoSubmitGlobalEnabled: boolean;
  autoSubmitThisApplication: boolean;
  executionMode: ExecutionMode;
  duplicateRisk: boolean;
  uncertainSubmissionExists: boolean;
}

export interface ReadinessResult {
  status: ReadinessStatus;
  totalRequiredFields: number;
  resolvedRequiredFields: number;
  unresolvedRequiredFields: number;
  reviewRequiredFields: number;
  manualOnlyFields: number;
  blockers: string[];
  resumeReady: boolean;
  atsVerified: boolean;
  pageStillMatchesPlan: boolean;
  canFill: boolean;
  canSubmit: boolean;
}

export function evaluateSubmissionReadiness(input: ReadinessInput): ReadinessResult {
  const blockers: string[] = [];

  const atsVerified = (input.provider === 'lever' || input.provider === 'greenhouse') && Boolean(input.planStatus) && input.planStatus !== 'UNSUPPORTED';

  // Hard blockers (never fillable/submittable around).
  if (input.provider !== 'lever' && input.provider !== 'greenhouse') blockers.push(`Unsupported ATS — ${input.provider}`);
  if (input.captchaPresent) blockers.push('CAPTCHA detected — complete it yourself, never bypassed');
  if (input.otpRequired) blockers.push('OTP/MFA required — complete it yourself, never bypassed');
  if (input.loginRequired) blockers.push('Login/account interruption required');
  if (!input.resumeReady || !input.artifactVerified) blockers.push('Verified resume artifact unavailable');
  if (!input.pageStillMatchesPlan) blockers.push('The application form changed since inspection — re-inspect required');
  if (input.unsupportedRequiredUpload) blockers.push('A required file upload has no approved artifact');
  if (input.duplicateRisk) blockers.push('Possible duplicate application — automatic submission blocked');
  if (input.uncertainSubmissionExists) blockers.push('A previous submission is unconfirmed — verify it before retrying');

  // Review-required work (approvals, stale/sensitive answers, consent, manual-only).
  const reviewRequiredFields =
    input.reviewRequired.length +
    input.consentFields.filter((c) => c.required).length +
    input.manualOnlyFields.length +
    input.sensitiveFields.length;

  const unresolvedRequiredFields = input.unresolvedRequired.length;
  const resolvedRequiredFields = Math.max(
    0,
    Math.min(input.resolvedRequiredFields, input.totalRequiredFields)
  );

  // canFill: known/approved values may be written into the form — but never
  // when the page is blocked, stale, or the companion is unavailable.
  const canFill =
    atsVerified &&
    input.companionReady &&
    input.pageStillMatchesPlan &&
    input.resumeReady &&
    input.artifactVerified &&
    !input.captchaPresent &&
    !input.otpRequired &&
    !input.loginRequired &&
    !input.unsupportedRequiredUpload;

  // Status precedence: UNSUPPORTED > BLOCKED > NEEDS_USER_INPUT > NEEDS_REVIEW > READY
  let status: ReadinessStatus;
  if (!atsVerified) status = 'UNSUPPORTED';
  else if (blockers.length > 0) status = 'BLOCKED';
  else if (unresolvedRequiredFields > 0) status = 'NEEDS_USER_INPUT';
  else if (reviewRequiredFields > 0) status = 'NEEDS_REVIEW';
  else status = 'READY';

  // canSubmit: the FULL gate. Field completion alone never satisfies it.
  const canSubmit =
    status === 'READY' &&
    input.executionMode === 'auto_submit' &&
    input.autoSubmitGlobalEnabled &&
    input.autoSubmitThisApplication &&
    !input.duplicateRisk &&
    !input.uncertainSubmissionExists &&
    blockers.length === 0 &&
    resolvedRequiredFields === input.totalRequiredFields;

  return {
    status,
    totalRequiredFields: input.totalRequiredFields,
    resolvedRequiredFields,
    unresolvedRequiredFields,
    reviewRequiredFields,
    manualOnlyFields: input.manualOnlyFields.length,
    blockers,
    resumeReady: input.resumeReady,
    atsVerified,
    pageStillMatchesPlan: input.pageStillMatchesPlan,
    canFill,
    canSubmit,
  };
}

export function executionModeFromEnv(): ExecutionMode {
  const v = String(process.env.AUTO_APPLY_EXECUTION_MODE ?? 'dry_run').toLowerCase();
  return v === 'fill_only' || v === 'auto_submit' ? v : 'dry_run';
}

/** Browser fill capability (fill-only phase). Companion readiness in the
 *  dry-run readiness projection uses this as the server-side capability flag;
 *  the real pairing/session check happens when fill starts. */
export function browserFillEnabled(): boolean {
  return (process.env.AUTO_APPLY_BROWSER_FILL_ENABLED ?? 'false') === 'true';
}

/** Auto Submit is opt-in at two levels; BOTH default OFF. */
export function autoSubmitPreferencesFromEnv(): { globalEnabled: boolean; thisApplication: boolean } {
  return {
    globalEnabled: (process.env.AUTO_APPLY_AUTO_SUBMIT_ENABLED ?? 'false') === 'true',
    // Per-application opt-in is stored per attempt in a future increment; the
    // env flag keeps the default OFF and explicit for this one.
    thisApplication: (process.env.AUTO_APPLY_AUTO_SUBMIT_THIS_APPLICATION ?? 'false') === 'true',
  };
}
