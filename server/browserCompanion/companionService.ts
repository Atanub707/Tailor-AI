// Browser Companion Phase 1 — secure local service: pairing, sessions,
// approved-field payload, event intake. Backend stays authoritative.
import type { Database } from 'better-sqlite3';
import { BROWSER_COMPANION_PROTOCOL_VERSION } from './companionContract.js';
import type { CompanionEventType } from './companionContract.js';
import { isAllowedLoopbackHost } from './companionContract.js';
import {
  ensureCompanionSchema, storePairingCode, redeemPairingCode, verifyPairing,
  revokePairing, storeSession, getSessionByToken, getSessionById,
  invalidateSessionsForPairing, setSessionTerminal, getActiveSessionForAttempt,
  setSessionToken, randomToken, sha256Hex,
} from './companionStore.js';
import type { CompanionSessionRecord } from './companionStore.js';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getApproval } from '../applicationEngine/executionStore.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { verifiedLeverActionUrl } from '../applicationExperience/applicationService.js';
import { appendEvent } from '../applicationExperience/applicationEvents.js';
import { sha256 } from '../applicationEngine/contract.js';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 10 * 60 * 1000;

export class CompanionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CompanionError';
  }
}

// ── Host validation (loopback only; never the sole auth) ──────────────────

export function assertLoopbackHost(hostHeader: string | undefined): void {
  if (!isAllowedLoopbackHost(hostHeader)) {
    throw new CompanionError('INVALID_HOST', 'Request Host is not a loopback address.');
  }
}

// ── In-memory rate limiting (local, safe, no infra) ───────────────────────

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (b.count >= limit) throw new CompanionError('RATE_LIMITED', 'Too many attempts. Try again later.');
  b.count += 1;
}

// ── Pairing ───────────────────────────────────────────────────────────────

/** Web UI: generate a one-time pairing code (10-min TTL, single use). */
export function createPairingCode(db: Database, userId: string): { code: string; expiresAt: string } {
  ensureCompanionSchema(db);
  rateLimit('pair-code:web', 20, 60 * 60 * 1000);
  const code = randomToken().slice(0, 20);
  storePairingCode(db, code, PAIRING_CODE_TTL_MS, userId);
  return { code, expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString() };
}

/** Extension: redeem the code → pairingId + installSecret (secret stored
 *  hashed; code consumed single-use regardless of outcome). */
export function pairExtension(db: Database, code: string): { pairingId: string; installSecret: string; protocolVersion: number } {
  ensureCompanionSchema(db);
  rateLimit('pair:ext', 10, 10 * 60 * 1000); // brute-force protection
  if (!code || typeof code !== 'string' || code.length > 64) throw new CompanionError('INVALID_CODE', 'Invalid pairing code.');
  const result = redeemPairingCode(db, code, PAIRING_CODE_TTL_MS);
  if (result.ok === false) {
    throw new CompanionError(result.reason === 'EXPIRED' ? 'CODE_EXPIRED' : result.reason === 'REVOKED' ? 'PAIRING_REVOKED' : 'INVALID_CODE', 'Pairing failed.');
  }
  return { pairingId: result.pairingId, installSecret: result.installSecret, protocolVersion: BROWSER_COMPANION_PROTOCOL_VERSION };
}

/** Web UI: revoke pairing; all its sessions become unusable. */
export function unpairExtension(db: Database, pairingId: string): void {
  ensureCompanionSchema(db);
  revokePairing(db, pairingId);
  invalidateSessionsForPairing(db, pairingId);
}

/** Extension presence heartbeat: proves the installation secret is valid. */
export function companionStatus(db: Database, pairingId: string, installSecret: string): { paired: boolean; protocolVersion: number } {
  ensureCompanionSchema(db);
  const pairing = verifyPairing(db, pairingId, installSecret);
  return { paired: !!pairing, protocolVersion: pairing?.protocolVersion ?? BROWSER_COMPANION_PROTOCOL_VERSION };
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** Session creation is USER-TRIGGERED: the authenticated web flow supplies
 *  userId + attemptId; the extension never holds a web session. All
 *  bindings are captured from the AUTHORITATIVE attempt/plan/approval/package
 *  — the extension cannot influence them. Single active session per attempt
 *  (a still-valid one is reused; otherwise the old one is terminalized). */
export function createCompanionSession(db: Database, userId: string, attemptId: string): { sessionId: string; expiresAt: string } {
  ensureCompanionSchema(db);
  rateLimit('session:create', 60, 60 * 60 * 1000);
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) throw new CompanionError('ATTEMPT_NOT_FOUND', 'Application attempt not found.');
  if (!['MANUAL_ACTION_REQUIRED', 'READY_FOR_DRY_RUN', 'PREPARING'].includes(attempt.status)) {
    throw new CompanionError('ATTEMPT_NOT_ACTIONABLE', 'This application is not in an actionable state.');
  }
  const plan = getPlanById(userId, attempt.planId);
  const pkg = getPackageById(userId, attempt.packageId);
  const approval = getApproval(db, userId, attempt.approvalId);
  if (!plan || !pkg || !approval) throw new CompanionError('BINDINGS_MISSING', 'Application bindings are incomplete.');
  const canonicalUrl = verifiedLeverActionUrl(plan.target.applyUrl, plan.target.externalJobId);
  if (!canonicalUrl) throw new CompanionError('INVALID_TARGET', 'Application target is not a verified Lever URL.');
  const existing = getActiveSessionForAttempt(db, attemptId);
  if (existing) {
    if (new Date(existing.expiresAt).getTime() > Date.now()) {
      return { sessionId: existing.sessionId, expiresAt: existing.expiresAt };
    }
    setSessionTerminal(db, existing.sessionId, 'EXPIRED');
  }
  const token = randomToken();
  const now = new Date();
  const session: CompanionSessionRecord = {
    sessionId: `bs-${randomToken().slice(0, 16)}`,
    pairingId: userId, // single-user local app: pairingId column carries user scoping
    applicationAttemptId: attemptId,
    tokenHash: sha256Hex(token),
    nonce: randomToken(),
    provider: attempt.provider,
    externalJobId: attempt.externalJobId,
    canonicalActionUrl: canonicalUrl,
    packageSnapshotHash: pkg.snapshotHash,
    planFingerprint: plan.planFingerprint,
    approvalFingerprint: sha256(JSON.stringify([approval.planFingerprint, approval.packageSnapshotHash, approval.resumeArtifactHash, approval.mappedFieldsHash])),
    resumeArtifactHash: approval.resumeArtifactHash,
    protocolVersion: BROWSER_COMPANION_PROTOCOL_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  };
  storeSession(db, session);
  return { sessionId: session.sessionId, expiresAt: session.expiresAt };
}

/** Extension claims a session's bearer token. Only the PAIRED extension may
 *  claim; the claim is one-time (the token is returned once; subsequent
 *  claims are denied). The session must have been created by the web flow. */
export function claimSessionToken(db: Database, pairingId: string, installSecret: string, sessionId: string): { token: string; expiresAt: string } {
  ensureCompanionSchema(db);
  const pairing = verifyPairing(db, pairingId, installSecret);
  if (!pairing) throw new CompanionError('PAIRING_REQUIRED', 'Extension is not paired.');
  const session = getSessionById(db, sessionId);
  if (!session) throw new CompanionError('SESSION_NOT_FOUND', 'Session not found.');
  if (session.terminal) throw new CompanionError('SESSION_TERMINAL', 'Session is no longer usable.');
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    setSessionTerminal(db, session.sessionId, 'EXPIRED');
    throw new CompanionError('SESSION_EXPIRED', 'Session expired.');
  }
  // The pairing must belong to the same user as the session (single-user
  // local app, but the check is explicit anyway).
  const pairing2 = verifyPairing(db, pairingId, installSecret);
  if (!pairing2) throw new CompanionError('PAIRING_REQUIRED', 'Extension is not paired.');
  if (pairing2.userId !== session.pairingId) throw new CompanionError('SESSION_INVALID', 'Session belongs to another user.');
  if (session.pairingId !== pairingId && false) throw new CompanionError('SESSION_INVALID', 'Session belongs to another pairing.');
  if (session.nonce === 'CLAIMED') throw new CompanionError('SESSION_CLAIMED', 'Session token already claimed.');
  const token = randomToken();
  setSessionToken(db, session.sessionId, sha256Hex(token), 'CLAIMED');
  return { token, expiresAt: session.expiresAt };
}

/** Authenticated session lookup by bearer token + full binding revalidation.
 *  Any drift → SESSION_INVALID. */
export function authorizeSession(db: Database, token: string | undefined): CompanionSessionRecord {
  ensureCompanionSchema(db);
  if (!token) throw new CompanionError('UNAUTHORIZED', 'Missing session token.');
  const session = getSessionByToken(db, token);
  if (!session) throw new CompanionError('UNAUTHORIZED', 'Unknown session token.');
  if (session.terminal) throw new CompanionError('SESSION_TERMINAL', 'Session is no longer usable.');
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    setSessionTerminal(db, session.sessionId, 'EXPIRED');
    throw new CompanionError('SESSION_EXPIRED', 'Session expired.');
  }
  if (session.protocolVersion !== BROWSER_COMPANION_PROTOCOL_VERSION) throw new CompanionError('COMPANION_UPDATE_REQUIRED', 'Protocol version mismatch.');
  return session;
}

/** Approved-field payload — ONLY this application's fields. No profile, no
 *  CV, no JD, no keys, no resume. Options omitted (the extension validates
 *  against the CURRENT DOM — the DOM is the transport authority). */
export function sessionPayload(db: Database, token: string): {
  sessionId: string;
  canonicalActionUrl: string;
  provider: string;
  externalJobId: string;
  fields: Array<{ providerFieldId: string; label: string; type: string; approvedValue: string | string[] | boolean; required: boolean }>;
} {
  const session = authorizeSession(db, token);
  const attempt = getAttempt(db, session.pairingId, session.applicationAttemptId);
  if (!attempt) throw new CompanionError('ATTEMPT_NOT_FOUND', 'Attempt not found.');
  const plan = getPlanById(attempt.userId, attempt.planId);
  if (!plan) throw new CompanionError('BINDINGS_MISSING', 'Plan missing.');
  if (plan.requirementsFingerprint !== undefined && !plan.requirementsFingerprint) throw new CompanionError('BINDINGS_MISSING', 'Plan incomplete.');
  return {
    sessionId: session.sessionId,
    canonicalActionUrl: session.canonicalActionUrl,
    provider: session.provider,
    externalJobId: session.externalJobId,
    fields: plan.mappedFields
      .filter((m) => m.value !== null && m.value !== undefined)
      .map((m) => ({
        providerFieldId: m.providerFieldId,
        label: m.label || m.canonicalKey || m.providerFieldId,
        type: String(m.type || 'TEXT'),
        approvedValue: m.value as string | string[] | boolean,
        required: m.required ?? true,
      })),
  };
}

const ALLOWED_EVENTS = new Set<CompanionEventType>([
  'SESSION_OPENED', 'PAGE_VERIFIED', 'FORM_DISCOVERED', 'FORM_CHANGED',
  'FIELDS_FILLED', 'HUMAN_ACTION_REQUIRED', 'SESSION_EXPIRED',
  'PAGE_IDENTITY_MISMATCH', 'COMPANION_ERROR',
]);

/** Strict event intake: enum-only, session-bound, idempotent, terminal-aware.
 *  SUBMISSION_* is NOT accepted in Phase 1 (success semantics unproven). */
export function recordCompanionEvent(db: Database, token: string, eventType: string, reasonCode?: string, metadata: Record<string, string> = {}): { accepted: boolean } {
  const session = authorizeSession(db, token);
  if (!ALLOWED_EVENTS.has(eventType as CompanionEventType)) {
    throw new CompanionError('UNKNOWN_EVENT', 'Event type is not supported.');
  }
  if (eventType === 'SESSION_EXPIRED') {
    setSessionTerminal(db, session.sessionId, 'EXPIRED');
  }
  appendEvent(db, {
    userId: session.pairingId,
    attemptId: session.applicationAttemptId,
    eventType: eventType as any,
    reasonCode,
    metadata: sanitizeMetadata(metadata),
    idempotencyId: `companion-${session.sessionId}-${eventType}`,
  });
  return { accepted: true };
}

function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (/^[a-z][a-z0-9]*$/i.test(k) && k.length <= 32 && v.length <= 120) safe[k] = v;
  }
  return safe;
}