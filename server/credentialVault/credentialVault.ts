// Local Credential Vault — encrypted at rest, local-only, AEAD (AES-256-GCM
// via node:crypto — no invented crypto). Plaintext is never persisted, never
// logged, never returned by web APIs; it is released ONLY through a
// short-lived single-use grant for an explicitly authorized workflow
// (ATS_NEW_ACCOUNT_CREATION).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

export const CRYPTO_VERSION = 'v1';
export const MASTER_KEY_BYTES = 32;

export interface CredentialGrant {
  grantId: string;
  userId: string;
  attemptId: string;
  provider: string;
  externalJobId: string;
  purpose: 'ATS_NEW_ACCOUNT_CREATION';
  expiresAt: number;
}

// ── Envelope: v1:nonce:tag:ciphertext (base64url) ────────────────────────

export function encryptAes256Gcm(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CRYPTO_VERSION, nonce.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypt with tamper detection (GCM tag) and version check. Fails closed. */
export function decryptAes256Gcm(envelope: string, key: Buffer): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== CRYPTO_VERSION) throw new Error('INVALID_ENVELOPE');
  const [, nonceB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
  return pt.toString('utf8');
}

// ── Master key: local installation key, 0o600 file ────────────────────────
// Platform notes (documented in docs/adr/credential-vault-v1.md):
// macOS/Linux: chmod 600 enforced; Windows: NTFS ACLs via the user profile
// (fs mode is best-effort); Docker: lives in the named data volume. A local
// key file is the pragmatic local-first choice (no OS-keychain dependency in
// this runtime; keytar is unmaintained, safeStorage is Electron-only).

export function ensureMasterKey(dataDir: string): Buffer {
  const dir = path.join(dataDir, 'keys');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'master.key');
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length !== MASTER_KEY_BYTES) throw new Error('MASTER_KEY_CORRUPT');
    return buf;
  }
  const key = randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(file, key, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return key;
}

// ── Vault ─────────────────────────────────────────────────────────────────

export interface VaultConfig {
  db: Database;
  dataDir: string;
  masterKey?: Buffer; // tests may inject a key
}

export class LocalCredentialVault {
  private readonly key: Buffer;
  private readonly db: Database;
  private readonly grants = new Map<string, CredentialGrant>();

  constructor(config: VaultConfig) {
    this.db = config.db;
    this.key = config.masterKey ?? ensureMasterKey(config.dataDir);
    ensureVaultSchema(this.db);
  }

  hasApplicationPassword(userId: string): boolean {
    const row = this.db.prepare('SELECT ciphertext FROM credential_vault WHERE user_id = ? AND credential_type = ? AND provider_scope = ?')
      .get(userId, 'application_password', 'GLOBAL_APPLICATION_ACCOUNT') as any;
    return !!row;
  }

  setApplicationPassword(userId: string, plaintext: string): void {
    if (typeof plaintext !== 'string' || plaintext.length < 12) {
      throw new Error('PASSWORD_TOO_SHORT');
    }
    const ciphertext = encryptAes256Gcm(plaintext, this.key);
    this.db.prepare(`INSERT INTO credential_vault (credential_id, user_id, credential_type, provider_scope, ciphertext, crypto_version, created_at, updated_at, last_used_at)
      VALUES (?, ?, 'application_password', 'GLOBAL_APPLICATION_ACCOUNT', ?, ?, ?, ?, NULL)
      ON CONFLICT(user_id, credential_type, provider_scope) DO UPDATE SET ciphertext = excluded.ciphertext, crypto_version = excluded.crypto_version, updated_at = excluded.updated_at`)
      .run(`cred-${userId.slice(-6)}-${Date.now().toString(36)}`, userId, ciphertext, CRYPTO_VERSION, new Date().toISOString(), new Date().toISOString());
  }

  deleteApplicationPassword(userId: string): void {
    this.db.prepare('DELETE FROM credential_vault WHERE user_id = ? AND credential_type = ? AND provider_scope = ?')
      .run(userId, 'application_password', 'GLOBAL_APPLICATION_ACCOUNT');
  }

  /** Explicitly authorized, short-lived, single-use grant for a workflow.
   *  Only ATS_NEW_ACCOUNT_CREATION is supported in V1. */
  authorizeCredentialUse(input: {
    userId: string;
    attemptId: string;
    provider: string;
    externalJobId: string;
    purpose: 'ATS_NEW_ACCOUNT_CREATION';
    ttlMs?: number;
  }): CredentialGrant {
    const grant: CredentialGrant = {
      grantId: `grant-${randomBytes(12).toString('hex')}`,
      userId: input.userId,
      attemptId: input.attemptId,
      provider: input.provider,
      externalJobId: input.externalJobId,
      purpose: input.purpose,
      expiresAt: Date.now() + (input.ttlMs ?? 5 * 60 * 1000),
    };
    this.grants.set(grant.grantId, grant);
    return grant;
  }

  /** Single-use: returns the plaintext once, then invalidates the grant. */
  getCredentialForGrant(grant: CredentialGrant, expected: { userId: string; attemptId: string; provider: string; externalJobId: string }): string {
    const live = this.grants.get(grant.grantId);
    if (!live) throw new Error('GRANT_UNKNOWN');
    if (live.userId !== expected.userId || live.attemptId !== expected.attemptId || live.provider !== expected.provider || live.externalJobId !== expected.externalJobId) {
      this.grants.delete(grant.grantId);
      throw new Error('GRANT_BINDING_MISMATCH');
    }
    if (live.expiresAt <= Date.now()) {
      this.grants.delete(grant.grantId);
      throw new Error('GRANT_EXPIRED');
    }
    this.grants.delete(grant.grantId); // single use
    const row = this.db.prepare('SELECT ciphertext FROM credential_vault WHERE user_id = ? AND credential_type = ? AND provider_scope = ?')
      .get(expected.userId, 'application_password', 'GLOBAL_APPLICATION_ACCOUNT') as any;
    if (!row) throw new Error('CREDENTIAL_NOT_CONFIGURED');
    this.db.prepare('UPDATE credential_vault SET last_used_at = ? WHERE user_id = ? AND credential_type = ?').run(new Date().toISOString(), expected.userId, 'application_password');
    return decryptAes256Gcm(row.ciphertext, this.key);
  }
}

export function ensureVaultSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_vault (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      provider_scope TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      crypto_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      UNIQUE (user_id, credential_type, provider_scope)
    );
  `);
}