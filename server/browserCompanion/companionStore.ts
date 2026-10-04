// Execution binding sessions for Auto Apply attempts (formerly "Browser
// Companion" sessions). Single active session per attempt; bearer tokens are
// stored HASHED. The pairing/transport surface was removed with the Chrome
// extension — only the binding record (which gates SESSION_STALE in the
// submission policy) remains.
import type { Database } from 'better-sqlite3';

export function ensureCompanionSchema(db: Database): void {
  // Safe idempotent migration for Phase-2 session schema (user_id column;
  // pairing_id became nullable). Existing rows keep pairing_id as their user
  // scoping value; new rows carry the real user.
  const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_companion_sessions'").get();
  if (hasSessions) {
    const cols = (db.prepare('PRAGMA table_info(browser_companion_sessions)').all() as any[]).map((c) => c.name);
    if (!cols.includes('user_id')) {
      db.exec(`BEGIN;
        ALTER TABLE browser_companion_sessions RENAME TO browser_companion_sessions_old;
        CREATE TABLE browser_companion_sessions (
          session_id TEXT PRIMARY KEY,
          pairing_id TEXT,
          user_id TEXT NOT NULL,
          application_attempt_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          nonce TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_job_id TEXT NOT NULL,
          canonical_action_url TEXT NOT NULL,
          package_snapshot_hash TEXT NOT NULL,
          plan_fingerprint TEXT NOT NULL,
          approval_fingerprint TEXT NOT NULL,
          resume_artifact_hash TEXT NOT NULL,
          protocol_version INTEGER NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          terminal TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_attempt ON browser_companion_sessions (application_attempt_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_pairing ON browser_companion_sessions (pairing_id);
        INSERT INTO browser_companion_sessions (session_id, pairing_id, user_id, application_attempt_id, token_hash, nonce, provider, external_job_id, canonical_action_url, package_snapshot_hash, plan_fingerprint, approval_fingerprint, resume_artifact_hash, protocol_version, issued_at, expires_at, terminal, created_at)
          SELECT session_id, pairing_id, pairing_id, application_attempt_id, token_hash, nonce, provider, external_job_id, canonical_action_url, package_snapshot_hash, plan_fingerprint, approval_fingerprint, resume_artifact_hash, protocol_version, issued_at, expires_at, terminal, created_at FROM browser_companion_sessions_old;
        DROP TABLE browser_companion_sessions_old;
        COMMIT;`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_companion_sessions (
      session_id TEXT PRIMARY KEY,
      pairing_id TEXT,
      user_id TEXT NOT NULL,
      application_attempt_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      nonce TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_job_id TEXT NOT NULL,
      canonical_action_url TEXT NOT NULL,
      package_snapshot_hash TEXT NOT NULL,
      plan_fingerprint TEXT NOT NULL,
      approval_fingerprint TEXT NOT NULL,
      resume_artifact_hash TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      terminal TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_attempt ON browser_companion_sessions (application_attempt_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_pairing ON browser_companion_sessions (pairing_id);
  `);
}

export interface CompanionSessionRecord {
  sessionId: string;
  pairingId?: string;
  userId: string;
  applicationAttemptId: string;
  tokenHash: string;
  nonce: string;
  provider: string;
  externalJobId: string;
  canonicalActionUrl: string;
  packageSnapshotHash: string;
  planFingerprint: string;
  approvalFingerprint: string;
  resumeArtifactHash: string;
  protocolVersion: number;
  issuedAt: string;
  expiresAt: string;
  terminal?: string;
  createdAt: string;
}

export function storeSession(db: Database, session: CompanionSessionRecord): void {
  ensureCompanionSchema(db);
  db.prepare('INSERT INTO browser_companion_sessions (session_id, pairing_id, user_id, application_attempt_id, token_hash, nonce, provider, external_job_id, canonical_action_url, package_snapshot_hash, plan_fingerprint, approval_fingerprint, resume_artifact_hash, protocol_version, issued_at, expires_at, terminal, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(session.sessionId, session.pairingId ?? null, session.userId, session.applicationAttemptId, session.tokenHash, session.nonce, session.provider, session.externalJobId, session.canonicalActionUrl, session.packageSnapshotHash, session.planFingerprint, session.approvalFingerprint, session.resumeArtifactHash, session.protocolVersion, session.issuedAt, session.expiresAt, session.terminal ?? null, session.createdAt);
}

export function setSessionTerminal(db: Database, sessionId: string, reason: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_sessions SET terminal = ? WHERE session_id = ?').run(reason, sessionId);
}

export function getActiveSessionForAttempt(db: Database, attemptId: string): CompanionSessionRecord | null {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_sessions WHERE application_attempt_id = ? AND terminal IS NULL ORDER BY created_at DESC LIMIT 1').get(attemptId) as any;
  return row ? sessionFromRow(row) : null;
}

function sessionFromRow(row: any): CompanionSessionRecord {
  return {
    sessionId: row.session_id, pairingId: row.pairing_id ?? undefined, userId: row.user_id,
    applicationAttemptId: row.application_attempt_id, tokenHash: row.token_hash,
    nonce: row.nonce, provider: row.provider, externalJobId: row.external_job_id,
    canonicalActionUrl: row.canonical_action_url, packageSnapshotHash: row.package_snapshot_hash,
    planFingerprint: row.plan_fingerprint, approvalFingerprint: row.approval_fingerprint,
    resumeArtifactHash: row.resume_artifact_hash, protocolVersion: row.protocol_version,
    issuedAt: row.issued_at, expiresAt: row.expires_at, terminal: row.terminal ?? undefined,
    createdAt: row.created_at,
  };
}
