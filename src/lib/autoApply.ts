// Auto Apply (Experimental) — client-side flag + Lever target checks.
// The server is authoritative (dry-run re-validates everything); this module
// only decides whether the experimental button may be shown.

import type { Job } from '../types';

export interface AutoApplyStatus {
  enabled: boolean;
}

let statusPromise: Promise<AutoApplyStatus> | null = null;

/** Cached one-shot flag read — ONE request per page load, shared by all cards. */
export function fetchAutoApplyStatus(): Promise<AutoApplyStatus> {
  if (!statusPromise) {
    statusPromise = fetch('/api/auto-apply/status')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .catch(() => ({ enabled: false }));
  }
  return statusPromise;
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Mirror of the server's Lever target check (server stays authoritative). */
export function isLeverJob(job: Pick<Job, 'atsPlatform' | 'applyUrl' | 'url'>): boolean {
  if (String(job.atsPlatform || '').toLowerCase() === 'lever') return true;
  return [job.applyUrl, job.url].some((u) => hostOf(u) === 'jobs.lever.co');
}

export function hasHttpApplyUrl(job: Pick<Job, 'applyUrl' | 'url'>): boolean {
  return /^https?:\/\//.test(String(job.applyUrl || job.url || ''));
}


// ── Job-row "AA" (Auto Apply) flow — pure logic (UI-testable) ────────────

export type AaRowState =
  | 'IDLE'
  | 'STARTING'
  | 'WAITING_FOR_BROWSER'
  | 'FILLING'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'SUBMITTING'
  | 'APPLIED'
  | 'NEEDS_REVIEW'
  | 'USER_ACTION_REQUIRED'
  | 'FORM_CHANGED'
  | 'NOT_ELIGIBLE'
  | 'FILL_DISABLED'
  | 'FAILED';

export interface AaStateView {
  state: AaRowState;
  message: string;
}

/** Specific, safe reason from the server's blocker codes (no secrets/PII). */
export function aaReasonFromBlockers(blockers: unknown): string | null {
  const list = Array.isArray(blockers) ? blockers.map(String) : [];
  if (list.some((b) => b === 'CAPTCHA_REQUIRED')) return 'CAPTCHA requires your attention — complete it in the browser, then try AA again.';
  if (list.some((b) => b === 'MANUAL_ACTION_REQUIRED')) return 'The application needs a manual step in the browser.';
  if (list.some((b) => b === 'FORM_CHANGED')) return 'The application form changed. Recheck this job.';
  if (list.some((b) => b === 'RESUME_ARTIFACT_MISSING')) return 'No verified resume artifact — prepare the resume first.';
  if (list.some((b) => b.startsWith('PLAN_') || b.startsWith('READINESS_') || b.startsWith('EXECUTION_'))) {
    return 'This job needs answers or review before Auto Apply can fill it.';
  }
  return null;
}

/** Map the existing fill/start API result to row state + user-facing copy. */
export function aaStateFromFillResult(data: unknown, httpOk: boolean): AaStateView {
  const status = (data as { status?: string } | null)?.status;
  const reason = aaReasonFromBlockers((data as { blockers?: unknown } | null)?.blockers);
  switch (status) {
    case 'FILL_STARTED':
      return { state: 'WAITING_FOR_BROWSER', message: 'Opening Lever application… waiting for Tailor Browser.' };
    case 'FILL_DISABLED':
      return { state: 'FILL_DISABLED', message: 'Auto Apply fill is disabled.' };
    case 'FILL_NOT_ELIGIBLE':
      return { state: 'NOT_ELIGIBLE', message: reason ?? "This job isn't ready for Auto Apply." };
    case 'USER_ACTION_REQUIRED':
      return { state: 'USER_ACTION_REQUIRED', message: reason ?? 'Action required in browser.' };
    case 'FORM_CHANGED':
      return { state: 'FORM_CHANGED', message: reason ?? 'The application form changed. Recheck this job.' };
    case 'FAILED':
      return { state: 'FAILED', message: reason ?? "Auto Apply couldn't start." };
    default:
      return { state: 'FAILED', message: httpOk ? "Auto Apply couldn't start." : 'Auto Apply request failed.' };
  }
}

/** The EXACT application URL only — never reconstructed, never a careers page. */
export function resolveApplicationUrl(
  job: { applyUrl?: string | null; url?: string | null },
  fillResult: { targetUrl?: string | null } | null | undefined
): string | null {
  return fillResult?.targetUrl || job.applyUrl || job.url || null;
}

/** Polling terminal check: stop once the read-back verdict exists. */
export function isTerminalFillStatus(statusJson: unknown): boolean {
  const data = statusJson as { readyForUserSubmission?: boolean; verification?: unknown } | null;
  return Boolean(data?.readyForUserSubmission) || Boolean(data?.verification);
}

/** Compact verification summary for the row tooltip / status surface. */
export function summarizeFillStatus(statusJson: unknown): string {
  const v = (statusJson as { verification?: { verified: number; alreadyCorrect: number; mismatch: number; notFound: number; unverifiable: number; blocked: number; newRequiredFields: number; resumeVerified: boolean } | null } | null)?.verification;
  if (!v) return 'Waiting for Tailor Browser…';
  const needs = v.mismatch + v.notFound + v.unverifiable + v.blocked;
  return `Verified ${v.verified} · Already correct ${v.alreadyCorrect} · Needs review ${needs} · Resume ${v.resumeVerified ? 'verified' : 'not verified'} · New required ${v.newRequiredFields}`;
}

export const AA_POLL_INTERVAL_MS = 1750;
export const AA_POLL_TIMEOUT_MS = 120_000;

export interface SubmissionDecisionView {
  enabled: boolean;
  mode: 'manual_review' | 'explicit_approval' | 'safe_auto';
  allowed: boolean;
  blockerCodes: string[];
  attemptStatus: string;
}

/** PII-free user-facing copy for a submission blocker code (mirrors the server policy). */
export function submissionBlockerMessage(codes: string[]): string {
  const c = codes[0] || '';
  switch (c) {
    case 'CAPTCHA_REQUIRED': return 'CAPTCHA needs your attention in the browser.';
    case 'OTP_REQUIRED': return 'A verification code is required.';
    case 'MFA_REQUIRED': return 'Multi-factor authentication is required.';
    case 'LOGIN_REQUIRED': return 'Log in on the site first.';
    case 'REQUIRED_CONSENT_UNAPPROVED': return 'A required consent needs your review.';
    case 'EEO_REQUIRES_REVIEW': return 'A voluntary demographic question needs your review.';
    case 'LEGAL_ATTESTATION': return 'A legal attestation needs your review.';
    case 'APPLICATION_ALREADY_SUBMITTED': return 'This application was already submitted.';
    case 'PRIOR_SUBMISSION_UNVERIFIED': return 'A previous submission may have gone through — check the site first.';
    case 'USER_AUTO_SUBMIT_DISABLED': return 'Auto Submit is off in settings.';
    case 'SUBMIT_DISABLED': return 'Submission is not enabled.';
    case 'PROVIDER_UNSUPPORTED': return 'Auto Submit supports Lever only.';
    case 'FORM_CHANGED': return 'The form changed since verification — recheck this job.';
    case 'JOB_CHANGED': return 'The job posting changed — recheck this job.';
    case 'RESUME_NOT_VERIFIED': return 'The resume attachment was not verified.';
    default: return codes.length ? 'Review required before submission.' : '';
  }
}

export async function fetchSubmissionDecision(attemptId: string): Promise<SubmissionDecisionView | null> {
  try {
    const res = await fetch(`/api/auto-apply/${encodeURIComponent(attemptId)}/submission-decision`);
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.decision || {};
    return {
      enabled: !!(data?.config && data.config.enabled),
      mode: (data?.config && data.config.mode) || 'manual_review',
      allowed: d.allowed === true,
      blockerCodes: Array.isArray(d.blockerCodes) ? d.blockerCodes.map(String) : [],
      attemptStatus: String(data?.attemptStatus || ''),
    };
  } catch { return null; }
}

