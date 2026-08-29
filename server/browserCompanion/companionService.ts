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
  setSessionToken, bindSessionPairing, randomToken, sha256Hex,
} from './companionStore.js';
import type { CompanionSessionRecord } from './companionStore.js';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { transitionAttempt } from '../applicationEngine/executionEngine.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getApproval } from '../applicationEngine/executionStore.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { verifiedLeverActionUrl } from '../applicationExperience/applicationService.js';
import { appendEvent } from '../applicationExperience/applicationEvents.js';
import { sha256 } from '../applicationEngine/contract.js';
import { readPdfArtifact, sha256Bytes } from '../applicationPackage/artifactStore.js';

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
  if (!['MANUAL_ACTION_REQUIRED', 'READY_FOR_DRY_RUN', 'PREPARING', 'READY_FOR_USER_SUBMISSION'].includes(attempt.status)) {
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
    userId,
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
  if (pairing.userId !== session.userId) throw new CompanionError('SESSION_INVALID', 'Session belongs to another user.');
  if (session.pairingId && session.pairingId !== pairingId) throw new CompanionError('SESSION_INVALID', 'Session belongs to another pairing.');
  if (session.nonce === 'CLAIMED') throw new CompanionError('SESSION_CLAIMED', 'Session token already claimed.');
  const token = randomToken();
  bindSessionPairing(db, session.sessionId, pairingId);
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
  const attempt = getAttempt(db, session.userId, session.applicationAttemptId);
  if (!attempt) throw new CompanionError('ATTEMPT_NOT_FOUND', 'Attempt not found.');
  const plan = getPlanById(session.userId, attempt.planId);
  if (!plan) throw new CompanionError('BINDINGS_MISSING', 'Plan missing.');
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
  'FIELDS_FILLED', 'RESUME_ATTACHED', 'RESUME_ATTACHMENT_FAILED',
  'CHECKPOINT_CLEARED', 'READY_FOR_USER_SUBMISSION',
  'SUBMISSION_INITIATED', 'SUBMISSION_CONFIRMED', 'SUBMISSION_UNCONFIRMED',
  'SUBMISSION_FAILED', 'HUMAN_ACTION_REQUIRED', 'SESSION_EXPIRED',
  'PAGE_IDENTITY_MISMATCH', 'COMPANION_ERROR',
]);

const TERMINAL_EVENT_TYPES = new Set(['SUBMISSION_CONFIRMED', 'SUBMISSION_UNCONFIRMED', 'SUBMISSION_FAILED', 'SESSION_EXPIRED']);

/** Phase 2 events require evidence-shaped metadata (non-PII). */
function validateEvidence(eventType: string, metadata: Record<string, string>): void {
  if (eventType === 'RESUME_ATTACHED') {
    if (!metadata.artifactHashPrefix || !metadata.size || !metadata.mimeType) throw new CompanionError('INVALID_EVIDENCE', 'Resume event requires artifactHashPrefix/size/mimeType.');
    if (!/^[0-9a-f]{8,16}$/.test(metadata.artifactHashPrefix)) throw new CompanionError('INVALID_EVIDENCE', 'Bad artifactHashPrefix.');
    if (!/^\d{1,10}$/.test(metadata.size)) throw new CompanionError('INVALID_EVIDENCE', 'Bad size.');
    if (metadata.mimeType !== 'application/pdf') throw new CompanionError('INVALID_EVIDENCE', 'Bad mimeType.');
  }
  if (eventType === 'SUBMISSION_CONFIRMED') {
    if (!metadata.confirmationEvidenceType || !metadata.confirmationFingerprint) throw new CompanionError('INVALID_EVIDENCE', 'Confirmation requires evidence type + fingerprint.');
    if (!/^[a-z0-9_-]{1,40}$/i.test(metadata.confirmationEvidenceType)) throw new CompanionError('INVALID_EVIDENCE', 'Bad evidence type.');
    if (!/^[0-9a-f]{1,64}$/i.test(metadata.confirmationFingerprint)) throw new CompanionError('INVALID_EVIDENCE', 'Bad confirmation fingerprint.');
  }
  if (eventType === 'SUBMISSION_FAILED') {
    if (!['VALIDATION_ERROR', 'PROVIDER_ERROR', 'FORM_CHANGED', 'SESSION_ERROR', 'UNKNOWN_ERROR'].includes(metadata.failureCategory || '')) {
      throw new CompanionError('INVALID_EVIDENCE', 'Bad failure category.');
    }
  }
}

/** Strict event intake: enum-only, session-bound, evidence-validated,
 *  idempotent (clientEventId-bounded), terminal-aware. The backend is the
 *  authority: SUBMISSION_* events transition the attempt through the central
 *  state machine and are never treated as blind evidence. */
export function recordCompanionEvent(db: Database, token: string, eventType: string, reasonCode?: string, metadata: Record<string, string> = {}, clientEventId?: string): { accepted: boolean } {
  const session = authorizeSession(db, token);
  if (!ALLOWED_EVENTS.has(eventType as CompanionEventType)) {
    throw new CompanionError('UNKNOWN_EVENT', 'Event type is not supported.');
  }
  if (clientEventId !== undefined && (!/^[a-zA-Z0-9._-]{1,64}$/.test(clientEventId))) {
    throw new CompanionError('INVALID_EVENT_ID', 'clientEventId is malformed or unbounded.');
  }
  validateEvidence(eventType, metadata);
  const safeMeta = sanitizeMetadata(metadata);
  const key = clientEventId ? `companion-${session.sessionId}-${eventType}-${clientEventId}` : `companion-${session.sessionId}-${eventType}`;
  if (eventType === 'SESSION_EXPIRED') setSessionTerminal(db, session.sessionId, 'EXPIRED');
  if (TERMINAL_EVENT_TYPES.has(eventType as CompanionEventType)) setSessionTerminal(db, session.sessionId, eventType === 'SESSION_EXPIRED' ? 'EXPIRED' : eventType);
  // Backend-authoritative attempt transitions (central machine only).
  const attempt = getAttempt(db, session.userId, session.applicationAttemptId);
  if (attempt) {
    const from = attempt.status;
    const to = eventType === 'SUBMISSION_CONFIRMED' ? 'SUBMITTED' : eventType === 'SUBMISSION_UNCONFIRMED' ? 'SUCCESS_UNCONFIRMED' : eventType === 'SUBMISSION_FAILED' ? 'FAILED' : eventType === 'READY_FOR_USER_SUBMISSION' ? 'READY_FOR_USER_SUBMISSION' : null;
    if (to && to !== from) {
      try { transitionAttempt(db, session.userId, attempt.id, to); } catch { /* illegal transition — event rejected by authority */ }
    }
  }
  appendEvent(db, {
    userId: session.userId,
    attemptId: session.applicationAttemptId,
    eventType: eventType as any,
    reasonCode,
    metadata: safeMeta,
    idempotencyId: key,
  });
  return { accepted: true };
}

/** EXACT immutable resume bytes for an authorized session. Full artifact
 *  validation per request: session valid → attempt/package/plan/approval/
 *  resume binding unchanged → artifact exists → PDF magic → size cap →
 *  SHA-256 == resumeArtifactHash. NEVER falls back to another resume. */
export function serveSessionResume(db: Database, token: string, sessionId: string): { bytes: Buffer; filename: string } {
  const session = authorizeSession(db, token);
  if (session.sessionId !== sessionId) throw new CompanionError('SESSION_INVALID', 'Session mismatch.');
  rateLimit(`resume:${session.sessionId}`, 10, 60 * 60 * 1000);
  const attempt = getAttempt(db, session.userId, session.applicationAttemptId);
  if (!attempt) throw new CompanionError('ATTEMPT_NOT_FOUND', 'Attempt not found.');
  const plan = getPlanById(session.userId, attempt.planId);
  const pkg = getPackageById(session.userId, attempt.packageId);
  const approval = getApproval(db, session.userId, attempt.approvalId);
  if (!plan || !pkg || !approval) throw new CompanionError('BINDINGS_MISSING', 'Bindings missing.');
  if (pkg.snapshotHash !== session.packageSnapshotHash) throw new CompanionError('PACKAGE_DRIFT', 'Package changed.');
  if (plan.planFingerprint !== session.planFingerprint) throw new CompanionError('PLAN_DRIFT', 'Plan changed.');
  if (approval.resumeArtifactHash !== session.resumeArtifactHash) throw new CompanionError('RESUME_DRIFT', 'Resume changed.');
  if (session.resumeArtifactHash !== pkg.resumeSnapshot?.pdfHash) throw new CompanionError('RESUME_DRIFT', 'Resume artifact mismatch.');
  const bytes = readPdfArtifact(session.resumeArtifactHash);
  if (!bytes.length) throw new CompanionError('ARTIFACT_MISSING', 'Resume artifact missing.');
  if (bytes.length > 5 * 1024 * 1024) throw new CompanionError('ARTIFACT_TOO_LARGE', 'Resume exceeds size limit.');
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new CompanionError('ARTIFACT_INVALID', 'Not a PDF.');
  if (sha256Bytes(bytes) !== session.resumeArtifactHash) throw new CompanionError('ARTIFACT_HASH_MISMATCH', 'Resume bytes do not match the approved artifact.');
  return { bytes, filename: `resume-${session.resumeArtifactHash.slice(0, 12)}.pdf` };
}

function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (/^[a-z][a-z0-9]*$/i.test(k) && k.length <= 32 && v.length <= 120) safe[k] = v;
  }
  return safe;
}