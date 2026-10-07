/**
 * Auto Apply — Chrome → Tailor Browser handoff (execution ownership: desktop).
 *
 * Flow:
 *  1. Chrome (authed) POST /api/auto-apply/desktop-handoff {jobId}
 *     → short-lived SINGLE-USE executionToken bound to {userId, jobId, nonce, expiry}
 *  2. Chrome POSTs the token to the loopback Tailor Desktop bridge
 *  3. Desktop claims it here (loopback-only, token = auth): the attempt is created
 *     server-side under the token's user, and a per-execution statusToken is issued
 *  4. Desktop posts value-free execution states; Chrome polls the authed status route
 *
 * Security: no arbitrary URLs (the job comes from the DB), no replay (claimed_at
 * CAS), no cross-account execution (userId binding), short TTL, loopback-only
 * claim/status/resume endpoints.
 */
import type { Database } from 'better-sqlite3';
import { randomToken, sha256Hex } from './crypto.js';
import { getReceiptByAttempt, saveSubmissionReceipt } from './submissionStore.js';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { transitionAttempt } from '../applicationEngine/executionEngine.js';
import { getJobById, updateJobInStorage, runWithUser } from '../storage/fileStorage.js';
import { resumeAttachmentFilename } from '../applicationEngine/resumeNaming.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { SubmissionPlan } from '../applicationEngine/contract.js';

export const HANDOFF_TTL_MS = 120_000;
export const EXECUTION_STATES = [
  'DESKTOP_STARTING', 'DESKTOP_CONNECTED', 'NAVIGATING', 'INSPECTING', 'FILLING',
  'ATTACHING_RESUME', 'WAITING_FOR_USER', 'VERIFYING', 'READY_FOR_REVIEW',
  'SUBMITTING', 'SUBMITTED_VERIFIED', 'FAILED',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface HandoffTokenRecord {
  token: string;
  userId: string;
  jobId: string;
  nonce: string;
  expiresAt: string;
}

function ensureTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_handoff_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_user ON desktop_handoff_tokens(user_id);
    CREATE TABLE IF NOT EXISTS desktop_executions (
      execution_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      status_token_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      last_event TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_desktop_exec_attempt ON desktop_executions(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_desktop_exec_token ON desktop_executions(status_token_hash);
    CREATE INDEX IF NOT EXISTS idx_desktop_exec_user ON desktop_executions(user_id);
  `);
  // Submit lifecycle columns (existing DBs): guarded migration.
  const cols = db.prepare(`PRAGMA table_info(desktop_executions)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('submit_marked_at')) db.exec(`ALTER TABLE desktop_executions ADD COLUMN submit_marked_at TEXT`);
  if (!have.has('submitted_at')) db.exec(`ALTER TABLE desktop_executions ADD COLUMN submitted_at TEXT`);
  if (!have.has('boot_id')) db.exec(`ALTER TABLE desktop_executions ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''`);
}

export interface DesktopSubmitAuthorization {
  ok: boolean;
  code?: 'SUBMIT_DISABLED' | 'ALREADY_SUBMITTED' | 'PRIOR_SUBMISSION_UNVERIFIED' | 'SUBMIT_ALREADY_MARKED' | 'UNKNOWN_EXECUTION';
  userId?: string;
  attemptId?: string;
  jobId?: string;
}

/**
 * Single-use submit authorization (server CAS). The desktop clicks ONLY after
 * this returns ok — so a second click is impossible even across app restarts.
 */
export function markDesktopSubmitting(db: Database, statusToken: string): DesktopSubmitAuthorization {
  ensureTables(db);
  const tokenHash = sha256Hex(statusToken);
  const row = db.prepare(`SELECT * FROM desktop_executions WHERE status_token_hash = ?`).get(tokenHash) as any;
  if (!row) return { ok: false, code: 'UNKNOWN_EXECUTION' };
  const userId = String(row.user_id);
  const attemptId = String(row.attempt_id);
  const jobId = String(row.job_id);

  // Duplicate protection FIRST: a verified receipt ends the story.
  const receipt = getReceiptByAttempt(db, attemptId);
  if (receipt && receipt.submissionVerified) return { ok: false, code: 'ALREADY_SUBMITTED', userId, attemptId, jobId };
  try {
    const attempt = getAttempt(db, userId, attemptId) as { status?: string } | null;
    const status = String((attempt && attempt.status) || '');
    if (status === 'SUBMITTED') return { ok: false, code: 'ALREADY_SUBMITTED', userId, attemptId, jobId };
    if (status === 'SUCCESS_UNCONFIRMED') return { ok: false, code: 'PRIOR_SUBMISSION_UNVERIFIED', userId, attemptId, jobId };
  } catch { /* best-effort; the CAS below still guarantees once-only */ }

  const nowIso = new Date().toISOString();
  const cas = db
    .prepare(`UPDATE desktop_executions SET submit_marked_at = ?, updated_at = ? WHERE status_token_hash = ? AND submit_marked_at IS NULL`)
    .run(nowIso, nowIso, tokenHash);
  if (cas.changes !== 1) return { ok: false, code: 'SUBMIT_ALREADY_MARKED', userId, attemptId, jobId };
  return { ok: true, userId, attemptId, jobId };
}

export interface DesktopSubmitConfirmation {
  ok: boolean;
  code?: string;
  receiptId?: string;
  jobApplied?: boolean;
  duplicate?: boolean;
}

/** Confirmation is the ONLY path to a receipt + Applied (idempotent). */
export function confirmDesktopSubmit(
  db: Database,
  statusToken: string,
  evidence: { confirmationType?: string; fingerprintHex?: string },
  deps: { updateJobFn?: (job: unknown) => unknown; getJobFn?: (id: string) => unknown } = {}
): DesktopSubmitConfirmation {
  ensureTables(db);
  const tokenHash = sha256Hex(statusToken);
  const row = db.prepare(`SELECT * FROM desktop_executions WHERE status_token_hash = ?`).get(tokenHash) as any;
  if (!row) return { ok: false, code: 'UNKNOWN_EXECUTION' };
  const userId = String(row.user_id);
  const attemptId = String(row.attempt_id);
  const jobId = String(row.job_id);

  const existing = getReceiptByAttempt(db, attemptId);
  if (existing) return { ok: true, receiptId: existing.id, duplicate: true, jobApplied: existing.submissionVerified };

  const submittedAt = new Date().toISOString();
  const rawFp = String(evidence.fingerprintHex || '');
  const confirmationFingerprint = /^[0-9a-f]{8,64}$/i.test(rawFp) ? rawFp.toLowerCase() : sha256Hex(`${attemptId}:${submittedAt}`);
  const confirmationType = ['THANK_YOU_PAGE', 'SUCCESS_MESSAGE', 'CONFIRMATION_ROUTE', 'USER_ASSERTED'].includes(String(evidence.confirmationType))
    ? (String(evidence.confirmationType) as 'THANK_YOU_PAGE' | 'SUCCESS_MESSAGE' | 'CONFIRMATION_ROUTE' | 'USER_ASSERTED')
    : 'SUCCESS_MESSAGE';
  let postingId = '';
  try {
    const attempt = getAttempt(db, userId, attemptId) as { externalJobId?: string } | null;
    postingId = String((attempt && attempt.externalJobId) || '').replace(/^lev-/, '');
  } catch { /* informational only */ }

  const receiptId = `rcpt-${randomToken().slice(0, 24)}`;
  // Receipts record the REAL provider (Lever or Greenhouse) of the submission.
  let providerName = 'lever';
  try {
    const jobForProvider = (deps.getJobFn ? (deps.getJobFn as (id: string) => unknown)(jobId) : runWithUser(userId, () => (getJobById as (id: string) => unknown)(jobId))) as { atsPlatform?: string } | undefined;
    providerName = String(jobForProvider?.atsPlatform || 'lever');
  } catch { /* default to lever when the job can't be read */ }
  saveSubmissionReceipt(db, {
    id: receiptId,
    attemptId,
    userId,
    jobId,
    provider: providerName,
    postingId,
    submittedAt,
    confirmationType,
    confirmationFingerprint,
    resumeHash: '',
    submissionVerified: true,
    createdAt: submittedAt,
  });
  db.prepare(
    `UPDATE desktop_executions SET submitted_at = ?, state = 'SUBMITTED_VERIFIED', last_event = 'SUBMISSION_CONFIRMED', updated_at = ? WHERE status_token_hash = ?`
  ).run(submittedAt, submittedAt, tokenHash);

  // Job → Applied ONLY here: verified confirmation + persisted receipt.
  // The bridge confirm route has NO web session, so the user-scoped storage
  // helpers must run inside the execution owner's context.
  let jobApplied = false;
  try {
    const apply = () => {
      const job = (deps.getJobFn || (getJobById as (id: string) => unknown))(jobId) as { state?: string } | undefined;
      if (job && String(job.state || '') !== 'applied') {
        (deps.updateJobFn || (updateJobInStorage as (job: unknown) => unknown))({ ...(job as object), state: 'applied' });
        return true;
      }
      return false;
    };
    jobApplied = deps.getJobFn || deps.updateJobFn ? apply() : runWithUser(userId, apply);
  } catch { /* receipt stands; job update best-effort */ }

  // Attempt audit state (phase-1-enterable only) — the receipt stays the
  // authoritative submission record.
  try {
    const attempt = getAttempt(db, userId, attemptId) as { status?: string } | null;
    if (String(attempt?.status || '') === 'READY_FOR_USER_SUBMISSION') {
      transitionAttempt(db, userId, attemptId, 'SUBMISSION_OBSERVED');
    }
  } catch { /* best-effort */ }
  return { ok: true, receiptId, jobApplied };
}

/** Authed step: the job MUST belong to the caller — no arbitrary jobs, no arbitrary URLs. */
export function createHandoffToken(
  db: Database,
  userId: string,
  jobId: string,
  deps: { getJobByIdFn?: (id: string) => unknown } = {}
): HandoffTokenRecord | null {
  ensureTables(db);
  let owner: string | null = null;
  if (deps.getJobByIdFn) {
    const job = deps.getJobByIdFn(jobId) as { userId?: string } | undefined;
    owner = job ? String(job.userId || '') : null;
  } else {
    // Ownership lives in the jobs table column, not the JSON blob.
    try {
      const row = db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(jobId) as { user_id?: string } | undefined;
      owner = row ? String(row.user_id) : null;
    } catch {
      owner = null;
    }
  }
  if (!owner || owner !== userId) return null;
  const token = randomToken();
  const record: HandoffTokenRecord = {
    token,
    userId,
    jobId,
    nonce: randomToken().slice(0, 16),
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS).toISOString(),
  };
  db.prepare(
    `INSERT INTO desktop_handoff_tokens (token, user_id, job_id, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, userId, jobId, record.nonce, record.expiresAt, new Date().toISOString());
  return record;
}

export interface ClaimResult {
  userId: string;
  jobId: string;
}

/**
 * Loopback step: validate + consume the token (single-use CAS) with job binding.
 * Returns the bound user/job or a refusal code.
 */
export function claimHandoffToken(
  db: Database,
  token: string,
  jobId: string
): { ok: true; claim: ClaimResult } | { ok: false; code: 'UNKNOWN_TOKEN' | 'TOKEN_EXPIRED' | 'ALREADY_CLAIMED' | 'JOB_MISMATCH' } {
  ensureTables(db);
  const row = db.prepare(`SELECT * FROM desktop_handoff_tokens WHERE token = ?`).get(token) as any;
  if (!row) return { ok: false, code: 'UNKNOWN_TOKEN' };
  if (row.job_id !== jobId) return { ok: false, code: 'JOB_MISMATCH' };
  if (Date.parse(String(row.expires_at)) < Date.now()) return { ok: false, code: 'TOKEN_EXPIRED' };
  const cas = db
    .prepare(`UPDATE desktop_handoff_tokens SET claimed_at = ? WHERE token = ? AND claimed_at IS NULL`)
    .run(new Date().toISOString(), token);
  if (cas.changes !== 1) return { ok: false, code: 'ALREADY_CLAIMED' };
  return { ok: true, claim: { userId: String(row.user_id), jobId: String(row.job_id) } };
}

export interface ExecutionRecord {
  executionId: string;
  attemptId: string;
  userId: string;
  jobId: string;
  state: ExecutionState;
  lastEvent: string;
  updatedAt: string;
}

/** Executions from an OLDER app boot are dead: supersede so they never block. */
export function supersedeOtherBootExecutions(db: Database, userId: string, currentBootId: string): number {
  ensureTables(db);
  if (!currentBootId) return 0;
  const r = db
    .prepare(
      `UPDATE desktop_executions SET state = 'FAILED', last_event = 'SUPERSEDED_NEW_APP_BOOT', updated_at = ?
       WHERE user_id = ? AND boot_id != ? AND state NOT IN ('FAILED', 'READY_FOR_REVIEW', 'SUBMITTED_VERIFIED')`
    )
    .run(new Date().toISOString(), userId, currentBootId);
  return r.changes;
}

export function createExecution(db: Database, userId: string, jobId: string, attemptId: string, bootId = ''): { executionId: string; statusToken: string } {
  ensureTables(db);
  const executionId = `dx-${randomToken().slice(0, 24)}`;
  const statusToken = randomToken();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO desktop_executions (execution_id, attempt_id, user_id, job_id, status_token_hash, state, last_event, created_at, updated_at, boot_id)
     VALUES (?, ?, ?, ?, ?, 'DESKTOP_STARTING', '', ?, ?, ?)`
  ).run(executionId, attemptId, userId, jobId, sha256Hex(statusToken), nowIso, nowIso, String(bootId || '').slice(0, 40));
  return { executionId, statusToken };
}

const ACTIVE_STATES = new Set<string>(['DESKTOP_STARTING', 'DESKTOP_CONNECTED', 'NAVIGATING', 'INSPECTING', 'FILLING', 'ATTACHING_RESUME', 'WAITING_FOR_USER', 'VERIFYING', 'SUBMITTING']);

export function postExecutionStatus(
  db: Database,
  statusToken: string,
  state: string,
  event: string
): { ok: boolean; code?: string } {
  ensureTables(db);
  if (!(EXECUTION_STATES as readonly string[]).includes(state)) return { ok: false, code: 'BAD_STATE' };
  const row = db.prepare(`SELECT execution_id FROM desktop_executions WHERE status_token_hash = ?`).get(sha256Hex(statusToken)) as any;
  if (!row) return { ok: false, code: 'UNKNOWN_EXECUTION' };
  db.prepare(`UPDATE desktop_executions SET state = ?, last_event = ?, updated_at = ? WHERE execution_id = ?`).run(
    state,
    String(event || '').slice(0, 64),
    new Date().toISOString(),
    String(row.execution_id)
  );
  return { ok: true };
}

export function getExecutionForAttempt(db: Database, userId: string, attemptId: string): ExecutionRecord | null {
  ensureTables(db);
  const row = db
    .prepare(`SELECT * FROM desktop_executions WHERE attempt_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(attemptId, userId) as any;
  if (!row) return null;
  return {
    executionId: String(row.execution_id),
    attemptId: String(row.attempt_id),
    userId: String(row.user_id),
    jobId: String(row.job_id),
    state: String(row.state) as ExecutionState,
    lastEvent: String(row.last_event || ''),
    updatedAt: String(row.updated_at),
  };
}

export function maxConcurrencyFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AUTO_APPLY_MAX_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : 3; // hard maximum: 5
}

/** ALL fresh active executions for the user (parallel orchestrator view). */
export function getActiveExecutionsForUser(db: Database, userId: string): ExecutionRecord[] {
  ensureTables(db);
  const rows = db
    .prepare(`SELECT * FROM desktop_executions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`)
    .all(userId) as any[];
  const out: ExecutionRecord[] = [];
  for (const row of rows) {
    if (ACTIVE_STATES.has(String(row.state)) && Date.now() - Date.parse(String(row.updated_at)) < 10 * 60 * 1000) {
      out.push({
        executionId: String(row.execution_id),
        attemptId: String(row.attempt_id),
        userId: String(row.user_id),
        jobId: String(row.job_id),
        state: String(row.state) as ExecutionState,
        lastEvent: String(row.last_event || ''),
        updatedAt: String(row.updated_at),
      });
    }
  }
  return out;
}

export function getActiveExecutionForUser(db: Database, userId: string): ExecutionRecord | null {
  ensureTables(db);
  const rows = db
    .prepare(`SELECT * FROM desktop_executions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`)
    .all(userId) as any[];
  for (const row of rows) {
    if (ACTIVE_STATES.has(String(row.state))) {
      // An execution abandoned on a checkpoint for 10+ minutes no longer blocks new runs.
      const fresh = Date.now() - Date.parse(String(row.updated_at)) < 10 * 60 * 1000;
      if (fresh) {
        return {
          executionId: String(row.execution_id),
          attemptId: String(row.attempt_id),
          userId: String(row.user_id),
          jobId: String(row.job_id),
          state: String(row.state) as ExecutionState,
          lastEvent: String(row.last_event || ''),
          updatedAt: String(row.updated_at),
        };
      }
    }
  }
  return null;
}

/** Loopback resume stream token = the execution's statusToken (bound to the attempt). */
export function getExecutionByStatusToken(db: Database, statusToken: string): ExecutionRecord | null {
  ensureTables(db);
  const row = db.prepare(`SELECT * FROM desktop_executions WHERE status_token_hash = ?`).get(sha256Hex(statusToken)) as any;
  if (!row) return null;
  return {
    executionId: String(row.execution_id),
    attemptId: String(row.attempt_id),
    userId: String(row.user_id),
    jobId: String(row.job_id),
    state: String(row.state) as ExecutionState,
    lastEvent: String(row.last_event || ''),
    updatedAt: String(row.updated_at),
  };
}

/** Shared plan payload builder (same shape the embedded desktop flow consumes). */
export function buildPlanPayload(
  userId: string,
  attemptId: string,
  plan: SubmissionPlan,
  pkg: Pick<ApplicationPackage, 'resumeSnapshot' | 'answers' | 'jobSnapshot' | 'applicantSnapshot'>
): {
  provider: 'lever' | 'greenhouse' | 'ashby';
  attemptId: string;
  url: string;
  postingId: string;
  company: string;
  title: string;
  requirementsFingerprint: string;
  fields: Array<{ providerFieldId: string; label: string; type: string; required: boolean; approvedValue: string | boolean | string[] }>;
  resume: { sha256: string; filename: string; mimeType: string } | null;
} | null {
  const rawUrl = String((plan as { inspection?: { url?: string } }).inspection?.url || plan.target?.applyUrl || '');
  // Lever needs the /apply form route; Ashby needs /application; Greenhouse
  // URLs ARE the application page.
  const isLever = plan.provider === 'lever';
  const isAshby = plan.provider === 'ashby';
  const base = rawUrl.replace(/\/+$/, '');
  const applyUrl = isLever
    ? (/^https:\/\/jobs\.lever\.co\/.+\/apply$/.test(rawUrl) ? rawUrl : base + '/apply')
    : isAshby
      ? (/\/application$/.test(base) ? base : base + '/application')
      : base;
  const fields = (plan.mappedFields || [])
    .filter((f) => f.value !== undefined && f.value !== null)
    .map((f) => ({
      providerFieldId: f.providerFieldId,
      label: f.label,
      type: f.type,
      required: !!f.required,
      approvedValue: typeof f.value === 'number' ? String(f.value) : (f.value as string | boolean | string[]),
    }))
    .slice(0, 120);
  void userId;
  void attemptId;
  const resume = pkg.resumeSnapshot?.pdfHash
    ? { sha256: pkg.resumeSnapshot.pdfHash, filename: resumeAttachmentFilename(pkg as ApplicationPackage), mimeType: 'application/pdf' }
    : null;
  return {
    provider: isLever ? 'lever' : isAshby ? 'ashby' : 'greenhouse',
    attemptId,
    url: applyUrl,
    postingId: String(plan.target?.externalJobId || '').replace(/^(lev|ash)-/, ''),
    company: plan.target?.company || '',
    title: plan.target?.title || '',
    requirementsFingerprint: plan.requirementsFingerprint || '',
    fields,
    resume,
  };
}
