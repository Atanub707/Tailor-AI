// Execution persistence — approvals + attempts. Durable idempotency via a
// unique execution key. No multipart bodies, no resume bytes, no secrets.
import type { Database } from 'better-sqlite3';
import { sha256 } from './contract.js';
import type { ApplicationApproval, ApplicationAttempt, AttemptStatus, ConsentApproval } from './executionContract.js';

export function ensureExecutionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_user_plan ON application_approvals (user_id, plan_id);
    CREATE TABLE IF NOT EXISTS application_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_job_id TEXT NOT NULL,
      execution_key TEXT NOT NULL UNIQUE,
      plan_fingerprint TEXT NOT NULL,
      package_snapshot_hash TEXT NOT NULL,
      requirements_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      transport_attempt_count INTEGER NOT NULL DEFAULT 0,
      verification_json TEXT,
      failure_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_user_status ON application_attempts (user_id, status);
  `);
}

/** Deterministic execution identity: userId + provider + externalJobId +
 *  packageSnapshotHash + planFingerprint. */
export function executionKey(input: {
  userId: string; provider: string; externalJobId: string;
  packageSnapshotHash: string; planFingerprint: string;
}): string {
  return sha256([
    input.userId, input.provider, input.externalJobId,
    input.packageSnapshotHash, input.planFingerprint,
  ].join('|')).slice(0, 40);
}

export function storeApproval(db: Database, approval: ApplicationApproval): void {
  db.prepare('INSERT INTO application_approvals (id, user_id, plan_id, package_id, data, created_at) VALUES (?,?,?,?,?,?)')
    .run(approval.id, approval.userId, approval.planId, approval.packageId, JSON.stringify(approval), approval.createdAt);
}

export function getApproval(db: Database, userId: string, approvalId: string): ApplicationApproval | null {
  const row = db.prepare('SELECT data FROM application_approvals WHERE id = ? AND user_id = ?').get(approvalId, userId) as any;
  return row ? JSON.parse(row.data) : null;
}

export function storeAttempt(db: Database, attempt: ApplicationAttempt): { duplicate: boolean } {
  try {
    db.prepare('INSERT INTO application_attempts (id, user_id, plan_id, package_id, approval_id, provider, external_job_id, execution_key, plan_fingerprint, package_snapshot_hash, requirements_fingerprint, status, transport_attempt_count, verification_json, failure_json, started_at, finished_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        attempt.id, attempt.userId, attempt.planId, attempt.packageId, attempt.approvalId,
        attempt.provider, attempt.externalJobId, attempt.executionKey, attempt.planFingerprint,
        attempt.packageSnapshotHash, attempt.requirementsFingerprint, attempt.status,
        attempt.transportAttemptCount, attempt.verification ? JSON.stringify(attempt.verification) : null,
        attempt.failure ? JSON.stringify(attempt.failure) : null,
        attempt.startedAt, attempt.finishedAt ?? null, attempt.createdAt, attempt.updatedAt,
      );
    return { duplicate: false };
  } catch (e: any) {
    if (String(e?.code || '').includes('UNIQUE')) return { duplicate: true };
    throw e;
  }
}

export function getAttempt(db: Database, userId: string, attemptId: string): ApplicationAttempt | null {
  const row = db.prepare('SELECT * FROM application_attempts WHERE id = ? AND user_id = ?').get(attemptId, userId) as any;
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, planId: row.plan_id, packageId: row.package_id,
    approvalId: row.approval_id, provider: row.provider, externalJobId: row.external_job_id,
    executionKey: row.execution_key, planFingerprint: row.plan_fingerprint,
    packageSnapshotHash: row.package_snapshot_hash, requirementsFingerprint: row.requirements_fingerprint,
    status: row.status as AttemptStatus, transportAttemptCount: row.transport_attempt_count,
    verification: row.verification_json ? JSON.parse(row.verification_json) : undefined,
    failure: row.failure_json ? JSON.parse(row.failure_json) : undefined,
    startedAt: row.started_at, finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getAttemptsByExecutionKey(db: Database, executionKey: string): ApplicationAttempt[] {
  const rows = db.prepare('SELECT * FROM application_attempts WHERE execution_key = ?').all(executionKey) as any[];
  return rows.map(attemptFromRow);
}

export function updateAttemptStatus(db: Database, userId: string, attemptId: string, status: AttemptStatus): void {
  db.prepare('UPDATE application_attempts SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(status, new Date().toISOString(), attemptId, userId);
}

function attemptFromRow(row: any): ApplicationAttempt {
  return {
    id: row.id, userId: row.user_id, planId: row.plan_id, packageId: row.package_id,
    approvalId: row.approval_id, provider: row.provider, externalJobId: row.external_job_id,
    executionKey: row.execution_key, planFingerprint: row.plan_fingerprint,
    packageSnapshotHash: row.package_snapshot_hash, requirementsFingerprint: row.requirements_fingerprint,
    status: row.status as AttemptStatus, transportAttemptCount: row.transport_attempt_count,
    verification: row.verification_json ? JSON.parse(row.verification_json) : undefined,
    failure: row.failure_json ? JSON.parse(row.failure_json) : undefined,
    startedAt: row.started_at, finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export { ConsentApproval };