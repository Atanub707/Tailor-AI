// Browser Companion Phase 1 — pairing + session persistence (minimal,
// idempotent, no PII in pairing records). Bearer tokens stored HASHED.
import type { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { BROWSER_COMPANION_PROTOCOL_VERSION } from './companionContract.js';

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
    CREATE TABLE IF NOT EXISTS browser_companion_pairings (
      pairing_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      code_hash TEXT,
      code_expires_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      protocol_version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pairings_code ON browser_companion_pairings (code_hash);
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

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface PairingRecord {
  pairingId: string;
  userId: string;
  secretHash: string;
  codeHash?: string;
  codeExpiresAt?: string;
  createdAt: string;
  revokedAt?: string;
  protocolVersion: number;
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

export function storePairingCode(db: Database, code: string, ttlMs: number, userId: string): string {
  const pairingId = `pair-${randomBytes(12).toString('hex')}`;
  ensureCompanionSchema(db);
  db.prepare('INSERT INTO browser_companion_pairings (pairing_id, user_id, secret_hash, code_hash, code_expires_at, created_at, protocol_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(pairingId, userId, '', sha256Hex(code), new Date(Date.now() + ttlMs).toISOString(), new Date().toISOString(), BROWSER_COMPANION_PROTOCOL_VERSION);
  return pairingId;
}

/** Single-use pairing code redemption: verifies the code, then installs the
 *  installation secret. The code is consumed regardless of outcome. */
export function redeemPairingCode(db: Database, code: string, ttlMs: number): { ok: true; pairingId: string; installSecret: string } | { ok: false; reason: 'INVALID_CODE' | 'EXPIRED' | 'REVOKED' } {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_pairings WHERE code_hash = ?').get(sha256Hex(code)) as any;
  if (!row) return { ok: false, reason: 'INVALID_CODE' };
  const now = new Date().toISOString();
  // consume the code regardless (single-use)
  db.prepare('UPDATE browser_companion_pairings SET code_hash = NULL, code_expires_at = NULL WHERE pairing_id = ?').run(row.pairing_id);
  if (row.code_expires_at && row.code_expires_at <= now) return { ok: false, reason: 'EXPIRED' };
  if (row.revoked_at) return { ok: false, reason: 'REVOKED' };
  const secret = randomToken();
  const secretHash = sha256Hex(secret);
  db.prepare('UPDATE browser_companion_pairings SET secret_hash = ? WHERE pairing_id = ?').run(secretHash, row.pairing_id);
  return { ok: true, pairingId: row.pairing_id, installSecret: secret };
}

export function verifyPairing(db: Database, pairingId: string, installSecret: string): PairingRecord | null {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_pairings WHERE pairing_id = ?').get(pairingId) as any;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.secret_hash || row.secret_hash !== sha256Hex(installSecret)) return null;
  return pairingFromRow(row);
}

export function revokePairing(db: Database, pairingId: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_pairings SET revoked_at = ? WHERE pairing_id = ?').run(new Date().toISOString(), pairingId);
}

export function storeSession(db: Database, session: CompanionSessionRecord): void {
  ensureCompanionSchema(db);
  db.prepare('INSERT INTO browser_companion_sessions (session_id, pairing_id, user_id, application_attempt_id, token_hash, nonce, provider, external_job_id, canonical_action_url, package_snapshot_hash, plan_fingerprint, approval_fingerprint, resume_artifact_hash, protocol_version, issued_at, expires_at, terminal, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(session.sessionId, session.pairingId ?? null, session.userId, session.applicationAttemptId, session.tokenHash, session.nonce, session.provider, session.externalJobId, session.canonicalActionUrl, session.packageSnapshotHash, session.planFingerprint, session.approvalFingerprint, session.resumeArtifactHash, session.protocolVersion, session.issuedAt, session.expiresAt, session.terminal ?? null, session.createdAt);
}

export function getSessionByToken(db: Database, token: string): CompanionSessionRecord | null {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_sessions WHERE token_hash = ?').get(sha256Hex(token)) as any;
  return row ? sessionFromRow(row) : null;
}

export function getSessionById(db: Database, sessionId: string): CompanionSessionRecord | null {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_sessions WHERE session_id = ?').get(sessionId) as any;
  return row ? sessionFromRow(row) : null;
}

export function invalidateSessionsForPairing(db: Database, pairingId: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_sessions SET terminal = ? WHERE pairing_id = ? AND terminal IS NULL').run('REVOKED', pairingId);
}

export function setSessionTerminal(db: Database, sessionId: string, reason: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_sessions SET terminal = ? WHERE session_id = ?').run(reason, sessionId);
}

export function setSessionToken(db: Database, sessionId: string, tokenHash: string, nonceMarker: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_sessions SET token_hash = ?, nonce = ? WHERE session_id = ?').run(tokenHash, nonceMarker, sessionId);
}

export function bindSessionPairing(db: Database, sessionId: string, pairingId: string): void {
  ensureCompanionSchema(db);
  db.prepare('UPDATE browser_companion_sessions SET pairing_id = ? WHERE session_id = ?').run(pairingId, sessionId);
}

export function getActiveSessionForAttempt(db: Database, attemptId: string): CompanionSessionRecord | null {
  ensureCompanionSchema(db);
  const row = db.prepare('SELECT * FROM browser_companion_sessions WHERE application_attempt_id = ? AND terminal IS NULL ORDER BY created_at DESC LIMIT 1').get(attemptId) as any;
  return row ? sessionFromRow(row) : null;
}

function pairingFromRow(row: any): PairingRecord {
  return {
    pairingId: row.pairing_id, userId: row.user_id, secretHash: row.secret_hash,
    codeHash: row.code_hash ?? undefined, codeExpiresAt: row.code_expires_at ?? undefined,
    createdAt: row.created_at, revokedAt: row.revoked_at ?? undefined,
    protocolVersion: row.protocol_version,
  };
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