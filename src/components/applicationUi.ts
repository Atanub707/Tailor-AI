// Shared Application UI vocabulary — row shapes, status labels/tones and
// providers used by both the Applications screen and the detail drawer.

export interface Checkpoint { type: string; reasonCode: string; title: string; description: string; provider: string }
export interface ApplicationRow {
  applicationId: string; planId?: string; attemptId?: string; jobId: string; jobUrl?: string;
  jobTitle: string; company: string; provider: string;
  userStatus: string; checkpoint: Checkpoint | null;
  availableActions: string[]; updatedAt: string;
}
export interface Details {
  resume?: { artifactHash: string; downloadUrl: string } | null;
  resumeSource?: 'TAILORED' | 'MASTER_CV' | null;
  resumeVersion?: number | null;
  userConfirmed?: { confirmedAt: string; source: string };
  answeredFields: Array<{ label: string; value: string }>;
  autoFilled?: Array<{ label: string; value: string }>;
  optionalOmittedCount: number;
  consentReviewCount: number;
  events?: Array<{ eventType: string; createdAt: string }>;
  planId?: string;
  requiredQuestions?: Array<{ providerFieldId: string; label: string; required: boolean; type: string; options: string[]; reason: string }>;
  consentFields?: Array<{ providerFieldId: string; label: string; classification: string }>;
  reviewGroups?: Array<{ title: string; items: Array<{ label: string; value: string; source: string }> }>;
  needsApproval?: boolean;
}

export const STATUS_LABEL: Record<string, string> = {
  PREPARING: 'Preparing', READY: 'Ready', APPLYING: 'Applying',
  ACTION_REQUIRED: 'Action Required', WAITING_FOR_YOU: 'Waiting for You',
  READY_TO_SUBMIT: 'Ready to Submit', APPLIED: 'Applied',
  CHECK_SUBMISSION: 'Check Submission', MANUAL_REQUIRED: 'Manual application required', FAILED: 'Failed',
};

export const STATUS_TONE: Record<string, string> = {
  ACTION_REQUIRED: 'bg-amber-50 text-amber-800 border-amber-200',
  WAITING_FOR_YOU: 'bg-amber-50 text-amber-800 border-amber-200',
  APPLIED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  FAILED: 'bg-red-50 text-red-800 border-red-200',
  CHECK_SUBMISSION: 'bg-orange-50 text-orange-800 border-orange-200',
  MANUAL_REQUIRED: 'bg-slate-50 text-slate-700 border-slate-200',
  PREPARING: 'bg-slate-50 text-slate-700 border-slate-200',
  READY: 'bg-sky-50 text-sky-800 border-sky-200',
  APPLYING: 'bg-slate-50 text-slate-700 border-slate-200',
  READY_TO_SUBMIT: 'bg-emerald-50 text-emerald-800 border-emerald-200',
};
export const DEFAULT_TONE = 'bg-slate-50 text-slate-700 border-slate-200';

export const EVENT_LABEL: Record<string, string> = {
  APPLICATION_STARTED: 'Application started',
  PROVIDER_HANDOFF: 'Opened the application form',
  USER_CONFIRMED_SUBMITTED: 'Marked as applied',
  SUBMISSION_CONFIRMED: 'Submission confirmed',
  SUBMISSION_UNCONFIRMED: 'Submission unconfirmed',
  SESSION_OPENED: 'Browser assist session opened',
  RESUME_ATTACHED: 'Resume attached',
  CHECKPOINT_DETECTED: 'Checkpoint detected',
  READY_TO_SUBMIT: 'Ready to submit',
};

export const providerLabel = (p: string) => (p === 'lever' ? 'Lever' : p === 'greenhouse' ? 'Greenhouse' : p === 'ashby' ? 'Ashby' : 'the employer site');

export const timeAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};