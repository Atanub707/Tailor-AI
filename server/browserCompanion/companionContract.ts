import { sha256 } from '../applicationEngine/contract.js';

// Browser Companion — Phase 0 CONTRACT FREEZE (type-only scaffolding).
// NO extension code, NO autofill, NO network listeners, NO storage changes.
// Pure types + validation helpers so Phase 1 implements against a frozen
// contract.

export const BROWSER_COMPANION_PROTOCOL_VERSION = 1;
export const BROWSER_COMPANION_BASE_URL = 'http://127.0.0.1:3000';
export const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_ACTIVE_SESSIONS_PER_ATTEMPT = 1;

export type CompanionEventType =
  | 'SESSION_OPENED'
  | 'PAGE_VERIFIED'
  | 'FORM_DISCOVERED'
  | 'FORM_CHANGED'
  | 'FIELDS_FILLED'
  | 'RESUME_ATTACHED'
  | 'HUMAN_ACTION_REQUIRED'
  | 'SUBMISSION_INITIATED'
  | 'SUBMISSION_CONFIRMED'
  | 'SUBMISSION_UNCONFIRMED'
  | 'SESSION_EXPIRED'
  | 'PAGE_IDENTITY_MISMATCH'
  | 'COMPANION_ERROR';

export type CompanionOutcome =
  | 'PROVIDER_CONFIRMED'
  | 'USER_CONFIRMED'
  | 'UNCONFIRMED';

export interface BrowserAssistSession {
  sessionId: string;
  applicationAttemptId: string;
  provider: string;               // 'lever' in V1
  externalJobId: string;
  canonicalActionUrl: string;     // verified by backend (verifiedLeverActionUrl)
  packageSnapshotHash: string;
  planFingerprint: string;
  approvalFingerprint: string;
  resumeArtifactHash: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  protocolVersion: number;
}

export interface ApprovedFieldPayload {
  providerFieldId: string;
  questionIdentity: string;       // normalized question text/identity from the approval
  type: 'TEXT' | 'TEXTAREA' | 'EMAIL' | 'PHONE' | 'URL' | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'BOOLEAN' | 'CONSENT';
  approvedValue: string | string[] | boolean;
  required: boolean;
  allowedOptionsHash?: string;    // sha of current provider options, for stale-form detection
}

export interface CompanionEvent {
  eventId: string;
  sessionId: string;
  type: CompanionEventType;
  at: string;
  reasonCode?: string;
  metadata: Record<string, string>; // non-sensitive only
}

/** Provider-independent browser adapter contract (Phase-1 implementation
 *  surface; no ATS-specific logic scattered through generic code). */
export interface BrowserProviderAdapter {
  provider: string;
  canHandle(url: string): boolean;
  verifyPage(session: BrowserAssistSession): Promise<{ ok: true } | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' | 'SESSION_EXPIRED' }>;
  inspectForm(): Promise<{ fields: unknown[]; fingerprint: string }>;
  mapApprovedFields(approved: ApprovedFieldPayload[], freshFields: unknown[]): { ok: true; plan: unknown[] } | { ok: false; reason: 'FORM_CHANGED' | 'FIELD_MISSING' | 'OPTION_CHANGED' };
  fillFields(plan: unknown[]): Promise<{ ok: true; filled: string[] }>;
  attachResume(bytes: ArrayBuffer, filename: string, mimeType: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  detectHumanCheckpoint(): Promise<{ present: boolean; kind?: 'CAPTCHA' | 'LOGIN' | 'MFA' | 'UNKNOWN' }>;
  detectSubmissionOutcome(): Promise<{ outcome: CompanionOutcome; evidence?: string }>;
}

// ── Pure validation helpers (contract tests only) ─────────────────────────

/** Session still valid: protocol matches, not expired, bound to the SAME
 *  application identity (nothing may be reused across jobs/attempts). */
export function isSessionUsable(
  session: BrowserAssistSession,
  now: number,
  check: { provider: string; externalJobId: string; packageSnapshotHash: string; planFingerprint: string; approvalFingerprint: string; resumeArtifactHash: string; canonicalActionUrl: string },
): boolean {
  if (session.protocolVersion !== BROWSER_COMPANION_PROTOCOL_VERSION) return false;
  if (Date.parse(session.expiresAt) <= now) return false;
  if (session.provider !== check.provider) return false;
  if (session.externalJobId !== check.externalJobId) return false;
  if (session.packageSnapshotHash !== check.packageSnapshotHash) return false;
  if (session.planFingerprint !== check.planFingerprint) return false;
  if (session.approvalFingerprint !== check.approvalFingerprint) return false;
  if (session.resumeArtifactHash !== check.resumeArtifactHash) return false;
  if (session.canonicalActionUrl !== check.canonicalActionUrl) return false;
  return true;
}

/** Replay guard: a session consumed by a terminal event is unusable. */
export function isSessionTerminal(events: Array<{ type: CompanionEventType }>): boolean {
  return events.some((e) =>
    e.type === 'SUBMISSION_CONFIRMED' || e.type === 'SUBMISSION_UNCONFIRMED' ||
    e.type === 'SESSION_EXPIRED' || e.type === 'COMPANION_ERROR',
  );
}

/** Event idempotency key (server dedupes re-delivered events). */
export function companionEventKey(sessionId: string, type: CompanionEventType): string {
  return `evt-${sessionId}-${type}`;
}

/** Loopback-only Host-header allowlist for the local API. */
export function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (host === '127.0.0.1:3000' || host === 'localhost:3000' || host === '[::1]:3000') return true;
  return false;
}

/** Companion must never accept an arbitrary URL — only the canonical
 *  verified application URL the backend issued for this session. */
export function isCanonicalSessionTarget(canonical: string, candidate: string): boolean {
  if (candidate !== canonical) return false;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'jobs.lever.co';
  } catch {
    return false;
  }
}

/** Approved values must match the CURRENT provider options (stale-option
 *  guard); a mismatch means FORM_CHANGED semantics. */
export function optionMatches(approvedValue: string, currentOptions: string[] | undefined, optionsHash: string | undefined): boolean {
  if (!currentOptions?.length) return true; // no options → text field
  if (!currentOptions.includes(approvedValue)) return false;
  if (optionsHash) {
    if (sha256(JSON.stringify(currentOptions)) !== optionsHash) return false;
  }
  return true;
}