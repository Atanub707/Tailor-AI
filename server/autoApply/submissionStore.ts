/**
 * Auto Apply Phase 5 — Controlled Auto Submit: persistence.
 *
 * Tables (self-contained, additive):
 *  - auto_apply_preferences     explicit per-user opt-in for auto submit
 *  - auto_verification_evidence compact, PII-free read-back evidence per attempt
 *  - auto_submission_receipts   lightweight submission receipts (verified success)
 *  - auto_submission_events     structured, PII-free audit events
 *  - submit_orders              single-use submit commands bound to a companion session
 *
 * Privacy: no names/emails/phones/answers/resume contents/cookies/tokens are stored here.
 * Only counts, statuses, opaque fingerprints and identifiers.
 */

import { getDb } from '../storage/fileStorage.js';
import type { Database } from 'better-sqlite3';

export interface AutoApplyPreferences {
  userId: string;
  autoSubmitEnabled: boolean;
  mode: 'manual_review' | 'explicit_approval' | 'safe_auto';
  updatedAt: string;
}

export interface VerificationEvidence {
  attemptId: string;
  userId: string;
  statuses: string;
  resumeVerified: boolean;
  captchaPending: boolean;
  otpPending: boolean;
  mfaPending: boolean;
  loginPending: boolean;
  newRequiredCount: number;
  formMutated: boolean;
  consentUnapproved: boolean;
  eeoReview: boolean;
  legalUnapproved: boolean;
  unapprovedAnswers: number;
  staleAnswers: number;
  planFingerprint: string;
  requirementsFingerprint: string;
  packageSnapshotHash: string;
  createdAt: string;
}

export interface SubmissionReceipt {
  id: string;
  attemptId: string;
  userId: string;
  jobId: string;
  provider: string;
  postingId: string;
  submittedAt: string;
  confirmationType: 'THANK_YOU_PAGE' | 'SUCCESS_MESSAGE' | 'CONFIRMATION_ROUTE' | 'USER_ASSERTED';
  confirmationFingerprint: string;
  resumeHash: string;
  submissionVerified: boolean;
  createdAt: string;
}

export interface SubmitOrder {
  id: string;
  sessionId: string;
  attemptId: string;
  userId: string;
  payload: string;
  createdAt: string;
  consumedAt?: string;
}

export function ensureSubmissionTables(db: Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_apply_preferences (
      userId TEXT PRIMARY KEY,
      autoSubmitEnabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'manual_review',
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auto_verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attemptId TEXT NOT NULL,
      userId TEXT NOT NULL,
      statuses TEXT NOT NULL,
      resumeVerified INTEGER NOT NULL DEFAULT 0,
      captchaPending INTEGER NOT NULL DEFAULT 0,
      otpPending INTEGER NOT NULL DEFAULT 0,
      mfaPending INTEGER NOT NULL DEFAULT 0,
      loginPending INTEGER NOT NULL DEFAULT 0,
      newRequiredCount INTEGER NOT NULL DEFAULT 0,
      formMutated INTEGER NOT NULL DEFAULT 0,
      consentUnapproved INTEGER NOT NULL DEFAULT 0,
      eeoReview INTEGER NOT NULL DEFAULT 0,
      legalUnapproved INTEGER NOT NULL DEFAULT 0,
      unapprovedAnswers INTEGER NOT NULL DEFAULT 0,
      staleAnswers INTEGER NOT NULL DEFAULT 0,
      planFingerprint TEXT NOT NULL DEFAULT '',
      requirementsFingerprint TEXT NOT NULL DEFAULT '',
      packageSnapshotHash TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_evidence_attempt ON auto_verification_evidence(attemptId);
    CREATE TABLE IF NOT EXISTS auto_submission_receipts (
      id TEXT PRIMARY KEY,
      attemptId TEXT NOT NULL UNIQUE,
      userId TEXT NOT NULL,
      jobId TEXT NOT NULL,
      provider TEXT NOT NULL,
      postingId TEXT NOT NULL,
      submittedAt TEXT NOT NULL,
      confirmationType TEXT NOT NULL,
      confirmationFingerprint TEXT NOT NULL,
      resumeHash TEXT NOT NULL DEFAULT '',
      submissionVerified INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_receipts_user ON auto_submission_receipts(userId);
    CREATE INDEX IF NOT EXISTS idx_auto_receipts_job ON auto_submission_receipts(jobId);
    CREATE TABLE IF NOT EXISTS auto_submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      attemptId TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_events_attempt ON auto_submission_events(attemptId);
    CREATE TABLE IF NOT EXISTS submit_orders (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL UNIQUE,
      attemptId TEXT NOT NULL,
      userId TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      consumedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_submit_orders_attempt ON submit_orders(attemptId);
  `);
}

const rowPrefs = (r: any): AutoApplyPreferences => ({
  userId: String(r.userId),
  autoSubmitEnabled: Number(r.autoSubmitEnabled) === 1,
  mode: r.mode === 'explicit_approval' || r.mode === 'safe_auto' ? r.mode : 'manual_review',
  updatedAt: String(r.updatedAt),
});

export function getAutoApplyPreferences(db: Database, userId: string): AutoApplyPreferences {
  ensureSubmissionTables(db);
  const r = db.prepare(`SELECT * FROM auto_apply_preferences WHERE userId = ?`).get(userId) as any;
  if (!r) return { userId, autoSubmitEnabled: false, mode: 'manual_review', updatedAt: new Date(0).toISOString() };
  return rowPrefs(r);
}

export function setAutoApplyPreferences(
  db: Database,
  userId: string,
  patch: { autoSubmitEnabled?: boolean; mode?: AutoApplyPreferences['mode'] }
): AutoApplyPreferences {
  ensureSubmissionTables(db);
  const current = getAutoApplyPreferences(db, userId);
  const next: AutoApplyPreferences = {
    userId,
    autoSubmitEnabled: patch.autoSubmitEnabled ?? current.autoSubmitEnabled,
    mode: patch.mode ?? current.mode,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO auto_apply_preferences (userId, autoSubmitEnabled, mode, updatedAt)
     VALUES (@userId, @autoSubmitEnabled, @mode, @updatedAt)
     ON CONFLICT(userId) DO UPDATE SET
       autoSubmitEnabled = @autoSubmitEnabled, mode = @mode, updatedAt = @updatedAt`
  ).run({ ...next, autoSubmitEnabled: next.autoSubmitEnabled ? 1 : 0 });
  return next;
}

export function recordVerificationEvidence(
  db: Database,
  userId: string,
  attemptId: string,
  e: Partial<Omit<VerificationEvidence, 'attemptId' | 'userId' | 'createdAt'>> & { statuses: string }
): void {
  ensureSubmissionTables(db);
  const b = (v: unknown): number => (v ? 1 : 0);
  db.prepare(
    `INSERT INTO auto_verification_evidence
     (attemptId, userId, statuses, resumeVerified, captchaPending, otpPending, mfaPending, loginPending,
      newRequiredCount, formMutated, consentUnapproved, eeoReview, legalUnapproved, unapprovedAnswers,
      staleAnswers, planFingerprint, requirementsFingerprint, packageSnapshotHash, createdAt)
     VALUES (@attemptId, @userId, @statuses, @resumeVerified, @captchaPending, @otpPending, @mfaPending, @loginPending,
      @newRequiredCount, @formMutated, @consentUnapproved, @eeoReview, @legalUnapproved, @unapprovedAnswers,
      @staleAnswers, @planFingerprint, @requirementsFingerprint, @packageSnapshotHash, @createdAt)`
  ).run({
    attemptId,
    userId,
    statuses: String(e.statuses || '').slice(0, 200),
    resumeVerified: b(e.resumeVerified),
    captchaPending: b(e.captchaPending),
    otpPending: b(e.otpPending),
    mfaPending: b(e.mfaPending),
    loginPending: b(e.loginPending),
    newRequiredCount: Number(e.newRequiredCount || 0),
    formMutated: b(e.formMutated),
    consentUnapproved: b(e.consentUnapproved),
    eeoReview: b(e.eeoReview),
    legalUnapproved: b(e.legalUnapproved),
    unapprovedAnswers: Number(e.unapprovedAnswers || 0),
    staleAnswers: Number(e.staleAnswers || 0),
    planFingerprint: String(e.planFingerprint || '').slice(0, 128),
    requirementsFingerprint: String(e.requirementsFingerprint || '').slice(0, 128),
    packageSnapshotHash: String(e.packageSnapshotHash || '').slice(0, 128),
    createdAt: new Date().toISOString(),
  });
}

export function getLatestVerificationEvidence(db: Database, attemptId: string): VerificationEvidence | null {
  ensureSubmissionTables(db);
  const r = db
    .prepare(`SELECT * FROM auto_verification_evidence WHERE attemptId = ? ORDER BY id DESC LIMIT 1`)
    .get(attemptId) as any;
  if (!r) return null;
  return {
    attemptId: String(r.attemptId),
    userId: String(r.userId),
    statuses: String(r.statuses),
    resumeVerified: Number(r.resumeVerified) === 1,
    captchaPending: Number(r.captchaPending) === 1,
    otpPending: Number(r.otpPending) === 1,
    mfaPending: Number(r.mfaPending) === 1,
    loginPending: Number(r.loginPending) === 1,
    newRequiredCount: Number(r.newRequiredCount),
    formMutated: Number(r.formMutated) === 1,
    consentUnapproved: Number(r.consentUnapproved) === 1,
    eeoReview: Number(r.eeoReview) === 1,
    legalUnapproved: Number(r.legalUnapproved) === 1,
    unapprovedAnswers: Number(r.unapprovedAnswers),
    staleAnswers: Number(r.staleAnswers),
    planFingerprint: String(r.planFingerprint),
    requirementsFingerprint: String(r.requirementsFingerprint),
    packageSnapshotHash: String(r.packageSnapshotHash),
    createdAt: String(r.createdAt),
  };
}

export function saveSubmissionReceipt(db: Database, receipt: SubmissionReceipt): void {
  ensureSubmissionTables(db);
  db.prepare(
    `INSERT INTO auto_submission_receipts
     (id, attemptId, userId, jobId, provider, postingId, submittedAt, confirmationType, confirmationFingerprint, resumeHash, submissionVerified, createdAt)
     VALUES (@id, @attemptId, @userId, @jobId, @provider, @postingId, @submittedAt, @confirmationType, @confirmationFingerprint, @resumeHash, @submissionVerified, @createdAt)`
  ).run({ ...receipt, submissionVerified: receipt.submissionVerified ? 1 : 0 });
}

export function getReceiptByAttempt(db: Database, attemptId: string): SubmissionReceipt | null {
  ensureSubmissionTables(db);
  const r = db.prepare(`SELECT * FROM auto_submission_receipts WHERE attemptId = ?`).get(attemptId) as any;
  if (!r) return null;
  return rowReceipt(r);
}

export function hasVerifiedReceiptForJob(db: Database, userId: string, jobId: string): boolean {
  ensureSubmissionTables(db);
  const r = db
    .prepare(`SELECT 1 AS x FROM auto_submission_receipts WHERE userId = ? AND jobId = ? AND submissionVerified = 1 LIMIT 1`)
    .get(userId, jobId) as any;
  return !!r;
}

function rowReceipt(r: any): SubmissionReceipt {
  return {
    id: String(r.id),
    attemptId: String(r.attemptId),
    userId: String(r.userId),
    jobId: String(r.jobId),
    provider: String(r.provider),
    postingId: String(r.postingId),
    submittedAt: String(r.submittedAt),
    confirmationType: r.confirmationType,
    confirmationFingerprint: String(r.confirmationFingerprint),
    resumeHash: String(r.resumeHash || ''),
    submissionVerified: Number(r.submissionVerified) === 1,
    createdAt: String(r.createdAt),
  };
}

export type SubmissionAuditType =
  | 'SUBMISSION_DECISION_CREATED'
  | 'FINAL_REVALIDATION_STARTED'
  | 'FINAL_REVALIDATION_PASSED'
  | 'SUBMISSION_STARTED'
  | 'SUBMIT_CONTROL_ACTIVATED'
  | 'SUBMISSION_CONFIRMATION_DETECTED'
  | 'SUBMISSION_VERIFIED'
  | 'SUBMISSION_UNVERIFIED'
  | 'SUBMISSION_BLOCKED'
  | 'SUBMISSION_FAILED';

/** Structured, PII-free audit trail. detail must be counts/statuses/fingerprints only. */
export function logSubmissionEvent(db: Database, userId: string, attemptId: string, type: SubmissionAuditType, detail = ''): void {
  ensureSubmissionTables(db);
  db.prepare(
    `INSERT INTO auto_submission_events (userId, attemptId, type, detail, createdAt) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, attemptId, type, String(detail).slice(0, 500), new Date().toISOString());
}

export function listSubmissionEvents(db: Database, attemptId: string, limit = 50): Array<{ type: string; detail: string; createdAt: string }> {
  ensureSubmissionTables(db);
  return (db
    .prepare(`SELECT type, detail, createdAt FROM auto_submission_events WHERE attemptId = ? ORDER BY id DESC LIMIT ?`)
    .all(attemptId, limit) as any[]).map((r) => ({ type: String(r.type), detail: String(r.detail), createdAt: String(r.createdAt) }));
}

/** Create the single-use submit command bound to a live companion session. One per session. */
export function createSubmitOrder(
  db: Database,
  order: { id: string; sessionId: string; attemptId: string; userId: string; payload: unknown }
): void {
  ensureSubmissionTables(db);
  db.prepare(
    `INSERT INTO submit_orders (id, sessionId, attemptId, userId, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(order.id, order.sessionId, order.attemptId, order.userId, JSON.stringify(order.payload), new Date().toISOString());
}

/**
 * Atomically consume the order (single-use). Returns the payload exactly once;
 * subsequent calls return null — this is the cross-restart idempotency guard that
 * makes a second SUBMIT click impossible even after a service-worker restart.
 */
export function consumeSubmitOrder(db: Database, sessionId: string): { order: SubmitOrder; payload: any } | null {
  ensureSubmissionTables(db);
  const now = new Date().toISOString();
  const info = db
    .prepare(`UPDATE submit_orders SET consumedAt = ? WHERE sessionId = ? AND consumedAt IS NULL`)
    .run(now, sessionId);
  if (info.changes !== 1) return null;
  const r = db.prepare(`SELECT * FROM submit_orders WHERE sessionId = ?`).get(sessionId) as any;
  if (!r) return null;
  return {
    order: {
      id: String(r.id),
      sessionId: String(r.sessionId),
      attemptId: String(r.attemptId),
      userId: String(r.userId),
      payload: String(r.payload),
      createdAt: String(r.createdAt),
      consumedAt: r.consumedAt ? String(r.consumedAt) : undefined,
    },
    payload: JSON.parse(String(r.payload)),
  };
}

export function getSubmitOrderForSession(db: Database, sessionId: string): SubmitOrder | null {
  ensureSubmissionTables(db);
  const r = db.prepare(`SELECT * FROM submit_orders WHERE sessionId = ?`).get(sessionId) as any;
  if (!r) return null;
  return {
    id: String(r.id),
    sessionId: String(r.sessionId),
    attemptId: String(r.attemptId),
    userId: String(r.userId),
    payload: String(r.payload),
    createdAt: String(r.createdAt),
    consumedAt: r.consumedAt ? String(r.consumedAt) : undefined,
  };
}
