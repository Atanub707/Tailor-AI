/**
 * Application Queue — SQLite-backed, local only.
 * States follow §12 state machine.
 */
import { getDb } from '../storage/fileStorage.js';
import type { ApplicationState } from './types.js';

export interface QueuedApplication {
  id: string;
  jobId: string;
  company: string;
  role: string;
  ats: string;
  url: string;
  state: ApplicationState;
  resumePath?: string;
  error?: string;
  receipt?: string; // JSON stringified ApplicationReceipt
  createdAt: string;
  updatedAt: string;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ats_queue (
      id TEXT PRIMARY KEY,
      jobId TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      ats TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      resumePath TEXT,
      error TEXT,
      receipt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

export function enqueue(app: Omit<QueuedApplication, 'createdAt' | 'updatedAt'>): QueuedApplication {
  ensureTable();
  const now = new Date().toISOString();
  const row: QueuedApplication = { ...app, createdAt: now, updatedAt: now };
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO ats_queue (id, jobId, company, role, ats, url, state, resumePath, error, receipt, createdAt, updatedAt)
     VALUES (@id, @jobId, @company, @role, @ats, @url, @state, @resumePath, @error, @receipt, @createdAt, @updatedAt)`
  ).run(row as any);
  return row;
}

export function updateState(id: string, state: ApplicationState, extra?: Partial<QueuedApplication>): void {
  ensureTable();
  const db = getDb();
  const sets = ['state = ?', 'updatedAt = ?'];
  const vals: unknown[] = [state, new Date().toISOString()];
  if (extra?.error !== undefined) { sets.push('error = ?'); vals.push(extra.error); }
  if (extra?.receipt !== undefined) { sets.push('receipt = ?'); vals.push(extra.receipt); }
  if (extra?.resumePath !== undefined) { sets.push('resumePath = ?'); vals.push(extra.resumePath); }
  vals.push(id);
  db.prepare(`UPDATE ats_queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function getQueued(id: string): QueuedApplication | undefined {
  ensureTable();
  return getDb().prepare('SELECT * FROM ats_queue WHERE id = ?').get(id) as QueuedApplication | undefined;
}

export function listQueued(): QueuedApplication[] {
  ensureTable();
  return getDb().prepare('SELECT * FROM ats_queue ORDER BY updatedAt DESC').all() as QueuedApplication[];
}
