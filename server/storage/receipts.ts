import { getDb } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';

/**
 * Application Receipt History — local SQLite, per user.
 * Stores every submitted application with confirmation reference.
 */

export interface ReceiptRecord {
  id: string;
  userId: string;
  jobId: string;
  company: string;
  jobTitle: string;
  atsPlatform: string;
  applyUrl: string;
  status: 'prepared' | 'confirmed' | 'submitted' | 'failed' | 'manual_required';
  submittedAt?: string;
  confirmationReference?: string;
  screenshotPath?: string;
  error?: string;
  createdAt: string;
}

function ensureReceiptTable(): void {
  ensureV2Tables();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_receipts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      jobId TEXT NOT NULL,
      company TEXT NOT NULL,
      jobTitle TEXT NOT NULL,
      atsPlatform TEXT NOT NULL,
      applyUrl TEXT NOT NULL,
      status TEXT NOT NULL,
      submittedAt TEXT,
      confirmationReference TEXT,
      screenshotPath TEXT,
      error TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_user ON application_receipts(userId);
    CREATE INDEX IF NOT EXISTS idx_receipts_job ON application_receipts(jobId);
  `);
}

export function saveReceipt(receipt: ReceiptRecord): void {
  ensureReceiptTable();
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO application_receipts
     (id, userId, jobId, company, jobTitle, atsPlatform, applyUrl, status, submittedAt, confirmationReference, screenshotPath, error, createdAt)
     VALUES (@id, @userId, @jobId, @company, @jobTitle, @atsPlatform, @applyUrl, @status, @submittedAt, @confirmationReference, @screenshotPath, @error, @createdAt)`
  ).run(receipt as any);
}

export function listReceipts(userId: string): ReceiptRecord[] {
  ensureReceiptTable();
  const db = getDb();
  return db.prepare('SELECT * FROM application_receipts WHERE userId = ? ORDER BY createdAt DESC').all(userId) as ReceiptRecord[];
}

export function getReceiptByJobId(jobId: string, userId: string): ReceiptRecord | undefined {
  ensureReceiptTable();
  const db = getDb();
  return db.prepare('SELECT * FROM application_receipts WHERE jobId = ? AND userId = ? ORDER BY createdAt DESC LIMIT 1').get(jobId, userId) as ReceiptRecord | undefined;
}
