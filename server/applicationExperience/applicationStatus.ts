// Application Experience V1 — user-facing status/checkpoint domain.
// INTERNAL states stay authoritative; this layer projects them for users.
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import type { ApplicationAttempt, AttemptStatus } from '../applicationEngine/executionContract.js';

export type UserApplicationStatus =
  | 'PREPARING'
  | 'READY'
  | 'APPLYING'
  | 'ACTION_REQUIRED'
  | 'WAITING_FOR_YOU'
  | 'READY_TO_SUBMIT'
  | 'APPLIED'
  | 'CHECK_SUBMISSION'
  | 'FAILED'
  // Post-application lifecycle (projected from events/evidence).
  | 'ASSESSMENT'
  | 'INTERVIEW'
  | 'OFFER'
  | 'REJECTED'
  | 'WITHDRAWN';

export const USER_STATUS_LABELS: Record<UserApplicationStatus, string> = {
  PREPARING: 'Preparing',
  READY: 'Ready',
  APPLYING: 'Applying',
  ACTION_REQUIRED: 'Action Required',
  WAITING_FOR_YOU: 'Waiting for You',
  READY_TO_SUBMIT: 'Ready to Submit',
  APPLIED: 'Applied',
  CHECK_SUBMISSION: 'Check Submission',
  FAILED: 'Failed',
  ASSESSMENT: 'Assessment',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export type CheckpointType =
  | 'CAPTCHA'
  | 'LOGIN'
  | 'MFA'
  | 'CONSENT'
  | 'REQUIRED_QUESTION'
  | 'PROVIDER_CHALLENGE'
  | 'MANUAL_SUBMISSION'
  | 'ACCOUNT_CREATION'
  | 'EMAIL_VERIFICATION'
  | 'OTP'
  | 'UNKNOWN';

export interface HumanCheckpoint {
  type: CheckpointType;
  reasonCode: string;
  title: string;
  description: string;
  provider: string;
  attemptId?: string;
  jobId?: string;
  externalJobId?: string;
  actionUrl?: string;
  createdAt?: string;
}

export type AvailableAction = 'VIEW' | 'START_APPLICATION' | 'CONTINUE_PROVIDER' | 'REOPEN_PROVIDER' | 'CONFIRM_SUBMITTED' | 'REVIEW_AND_SUBMIT' | 'RETRY' | 'NONE';

export type ApplicationEventType =
  | 'APPLICATION_STARTED'
  | 'PROVIDER_HANDOFF'
  | 'USER_CONFIRMED_SUBMITTED'
  | 'SUBMISSION_CONFIRMED'
  | 'SUBMISSION_UNCONFIRMED'
  | 'SESSION_OPENED'
  | 'PAGE_VERIFIED'
  | 'FORM_DISCOVERED'
  | 'FORM_CHANGED'
  | 'FIELDS_FILLED'
  | 'RESUME_ATTACHED'
  | 'RESUME_ATTACHMENT_FAILED'
  | 'CHECKPOINT_CLEARED'
  | 'READY_FOR_USER_SUBMISSION'
  | 'HUMAN_ACTION_REQUIRED'
  | 'SUBMISSION_INITIATED'
  | 'SUBMISSION_CONFIRMED'
  | 'SUBMISSION_UNCONFIRMED'
  | 'SUBMISSION_FAILED'
  | 'SESSION_EXPIRED'
  | 'PAGE_IDENTITY_MISMATCH'
  | 'COMPANION_ERROR';

export interface ApplicationEvent {
  id: string;
  userId: string;
  attemptId: string;
  eventType: ApplicationEventType;
  reasonCode?: string;
  createdAt: string;
  metadata: Record<string, string>; // non-sensitive only
}

/** Execution reason → generic human checkpoint (one domain router; no
 *  duplication across API/UI). Future: LOGIN/MFA from execution modes. */
export function humanCheckpointFrom(reasonCode: string | undefined, provider: string, plan?: SubmissionPlan): HumanCheckpoint {
  const reason = reasonCode ?? 'UNKNOWN';
  switch (reason) {
    case 'CAPTCHA_REQUIRED':
      return {
        type: 'CAPTCHA', reasonCode: reason, provider,
        title: 'Human verification required',
        description: 'Your application is prepared, but ' + provider + ' requires you to complete a verification step before the application can be submitted.',
      };
    case 'PROVIDER_CHALLENGE':
      return {
        type: 'PROVIDER_CHALLENGE', reasonCode: reason, provider,
        title: 'Security check required',
        description: provider + ' is asking for a security check before accepting this application.',
      };
    case 'ACCOUNT_CREATION_REQUIRED':
      return {
        type: 'ACCOUNT_CREATION', reasonCode: reason, provider,
        title: 'Create an account to continue',
        description: 'The employer requires a new account. Tailor AI can fill the email and a dedicated application password after you approve.',
      };
    case 'EMAIL_VERIFICATION_REQUIRED':
      return {
        type: 'EMAIL_VERIFICATION', reasonCode: reason, provider,
        title: 'Verify your email',
        description: 'The employer sent a verification email. Complete it on the employer page to continue.',
      };
    case 'OTP_REQUIRED':
      return {
        type: 'OTP', reasonCode: reason, provider,
        title: 'Security code required',
        description: 'The employer requires a security code. Complete it on the employer page to continue.',
      };
    case 'PASSWORD_POLICY_REJECTED':
      return {
        type: 'ACCOUNT_CREATION', reasonCode: reason, provider,
        title: 'Password format not accepted',
        description: 'This employer requires a different password format. Generate a compatible password for this account.',
      };
    case 'ACCOUNT_EXISTS':
      return {
        type: 'LOGIN', reasonCode: reason, provider,
        title: 'An account already exists',
        description: 'Sign in on the employer page to continue.',
      };
    case 'CONSENT_REQUIRED':
      return {
        type: 'CONSENT', reasonCode: reason, provider,
        title: 'Consent required',
        description: 'This application includes a consent step that needs your review.',
      };
    case 'MANUAL_SUBMISSION':
      return {
        type: 'MANUAL_SUBMISSION', reasonCode: reason, provider,
        title: 'Continue on the provider',
        description: 'Your application is prepared. Continue on ' + provider + ' to complete the required step.',
      };
    case 'FORM_CHANGED':
    case 'PLAN_CHANGED':
    case 'PACKAGE_STALE':
      return {
        type: 'MANUAL_SUBMISSION', reasonCode: reason, provider,
        title: 'Application needs to be prepared again',
        description: 'The application details changed on the provider side. Prepare it again to continue.',
      };
    default:
      if (plan?.manualFields?.length) {
        return {
          type: 'REQUIRED_QUESTION', reasonCode: reason, provider,
          title: 'Review required',
          description: 'This application includes questions that need your explicit answers.',
        };
      }
      return {
        type: 'UNKNOWN', reasonCode: reason, provider,
        title: 'Attention required',
        description: 'This application needs your attention before it can continue.',
      };
  }
}

/** CENTRAL internal → user status mapper. Exhaustive; unknown → safe
 *  CHECK_SUBMISSION fallback (never crashes, never silently Applied). */
export function mapApplicationStatus(input: {
  plan?: SubmissionPlan | null;
  attempt?: ApplicationAttempt | null;
  hasHandoffEvent: boolean;
  hasUserConfirmedEvent: boolean;
}): UserApplicationStatus {
  const { plan, attempt, hasHandoffEvent, hasUserConfirmedEvent } = input;
  if (hasUserConfirmedEvent) return 'APPLIED';
  if (attempt) {
    switch (attempt.status as AttemptStatus) {
      case 'MANUAL_ACTION_REQUIRED':
        return hasHandoffEvent ? 'WAITING_FOR_YOU' : 'ACTION_REQUIRED';
      case 'READY_FOR_DRY_RUN':
        // Automation-eligible form without transport: actionable manual
        // boundary (Phase 1 projection).
        return 'ACTION_REQUIRED';
      case 'READY_FOR_USER_SUBMISSION':
        return 'READY_TO_SUBMIT';
      case 'SUBMISSION_OBSERVED':
        return 'APPLYING';
      case 'BLOCKED':
        return 'FAILED';
      case 'PREPARING':
        return 'APPLYING';
      case 'SUBMITTED':
        return 'APPLIED';
      case 'SUCCESS_UNCONFIRMED':
        return 'CHECK_SUBMISSION';
      case 'FAILED':
        return 'FAILED';
      default:
        break; // PENDING_APPROVAL/APPROVED/CANCELLED → plan-based fallthrough
    }
  }
  if (plan) {
    if (plan.status === 'NEEDS_INPUT') return 'PREPARING';
    if (plan.status === 'NEEDS_REVIEW') return 'ACTION_REQUIRED';
    if (plan.status === 'READY_TO_SUBMIT') return 'READY';
    if (plan.status === 'UNSUPPORTED') return 'FAILED';
  }
  return 'CHECK_SUBMISSION'; // safe fallback
}

export function availableActions(status: UserApplicationStatus, checkpointType?: CheckpointType): AvailableAction[] {
  switch (status) {
    case 'ACTION_REQUIRED':
      // Ready-for-dry-run (no transport) → manual continuation; form changed
      // → retry/reprepare; otherwise provider handoff.
      if (checkpointType === 'MANUAL_SUBMISSION') return ['CONTINUE_PROVIDER', 'VIEW'];
      if (checkpointType === undefined) return ['RETRY', 'VIEW'];
      return ['CONTINUE_PROVIDER', 'VIEW'];
    case 'WAITING_FOR_YOU':
      return ['REOPEN_PROVIDER', 'CONFIRM_SUBMITTED'];
    case 'READY':
      return ['START_APPLICATION'];
    case 'READY_TO_SUBMIT':
      return ['REVIEW_AND_SUBMIT'];
    case 'APPLIED':
      return ['VIEW'];
    case 'FAILED':
      return ['RETRY', 'VIEW'];
    default:
      return ['VIEW'];
  }
}