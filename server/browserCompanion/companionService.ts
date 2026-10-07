// Execution binding sessions for Auto Apply attempts (formerly "Browser
// Companion Phase 1"). The pairing/bootstrap/claim/eventing transport was
// removed with the Chrome extension; Tailor Browser is the only execution
// client. What remains is the binding record created per attempt — it gates
// SESSION_STALE in the submission policy — plus the verified-target check.
import type { Database } from 'better-sqlite3';
import { BROWSER_COMPANION_PROTOCOL_VERSION } from './companionContract.js';
import {
  ensureCompanionSchema, storeSession, getActiveSessionForAttempt, setSessionTerminal,
} from './companionStore.js';
import type { CompanionSessionRecord } from './companionStore.js';
import { getAttempt, getApproval } from '../applicationEngine/executionStore.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { sha256 } from '../applicationEngine/contract.js';
import { randomToken, sha256Hex } from '../autoApply/crypto.js';

export const SESSION_TTL_MS = 10 * 60 * 1000;

export class CompanionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CompanionError';
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

/** Canonical application URL validation per provider (allowlisted,
 *  https-only, posting identity enforced). */
export function verifiedProviderActionUrl(provider: string, applyUrl: string | undefined, externalJobId?: string): string | null {
  if (!applyUrl) return null;
  let u: URL;
  try { u = new URL(applyUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  const normalizedExternal = String(externalJobId || '').replace(/^(lev|gh|ash|ashby)-/, '');
  if (provider === 'lever') {
    if (u.hostname !== 'jobs.lever.co') return null;
    if (seg.length < 2) return null;
    if (seg[seg.length - 1] !== 'apply') {
      if (seg.length !== 2) return null;
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/apply`;
    }
    const urlJobId = seg[seg.length - 2];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  if (provider === 'greenhouse') {
    if (u.hostname !== 'boards.greenhouse.io' && u.hostname !== 'job-boards.greenhouse.io') return null;
    if (seg.length < 3 || seg[1] !== 'jobs') return null;
    const urlJobId = seg[2];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  if (provider === 'ashby') {
    if (u.hostname !== 'jobs.ashbyhq.com') return null;
    if (seg.length < 3 || seg[2] !== 'application') return null;
    const urlJobId = seg[1];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  return null;
}

/** Session creation is USER-TRIGGERED: the authenticated web flow supplies
 *  userId + attemptId. All bindings are captured from the AUTHORITATIVE
 *  attempt/plan/approval/package. Single active session per attempt (a
 *  still-valid one is reused; otherwise the old one is terminalized). */
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
  const canonicalUrl = verifiedProviderActionUrl(attempt.provider, plan.target.applyUrl, plan.target.externalJobId);
  if (!canonicalUrl) throw new CompanionError('INVALID_TARGET', 'Application target is not a verified provider URL.');
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
