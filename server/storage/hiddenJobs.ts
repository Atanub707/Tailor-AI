// Per-user "hidden jobs" store — deleted jobs never reappear in searches.
//
// Remove on a job deletes the user's row AND records the job here; every
// search persist filters these out (dedupe happens on normalized URL, so
// the same job cannot re-enter the list). Undo removes the marker (the job
// may return on a FUTURE search). Clear All wipes both the list and hidden.

import type { Database } from 'better-sqlite3';
import { getDb, getCurrentUserId } from './fileStorage.js';

export function ensureHiddenJobsSchema(db: Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hidden_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      source TEXT,
      hidden_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hidden_user_url ON hidden_jobs (user_id, url);
  `);
}

export function hideJob(db: Database, userId: string, job: { id: string; url?: string; title?: string; source?: string }): void {
  const url = (job.url || '').toLowerCase().trim();
  if (!url) return;
  ensureHiddenJobsSchema(db);
  db.prepare('INSERT OR IGNORE INTO hidden_jobs (id, user_id, url, title, source, hidden_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(job.id, userId, url, job.title ?? null, job.source ?? null, new Date().toISOString());
}

export function unhideJob(db: Database, userId: string, jobId: string): boolean {
  ensureHiddenJobsSchema(db);
  const r = db.prepare('DELETE FROM hidden_jobs WHERE id = ? AND user_id = ?').run(jobId, userId);
  return r.changes > 0;
}

/** URLs hidden by this user (lowercased set) — checked before every persist. */
export function hiddenUrls(db: Database, userId: string): Set<string> {
  ensureHiddenJobsSchema(db);
  const rows = db.prepare('SELECT url FROM hidden_jobs WHERE user_id = ?').all(userId) as Array<{ url: string }>;
  return new Set(rows.map((r) => r.url));
}

export function clearHidden(db: Database, userId: string): number {
  ensureHiddenJobsSchema(db);
  return db.prepare('DELETE FROM hidden_jobs WHERE user_id = ?').run(userId).changes;
}
// Current-user convenience wrappers (used by the HTTP routes).
export function hideCurrentUserJob(job: { id: string; url?: string; title?: string; source?: string }): void {
  const userId = getCurrentUserId();
  if (!userId) return;
  hideJob(getDb(), userId, job);
}

export function unhideCurrentUserJob(jobId: string): boolean {
  const userId = getCurrentUserId();
  if (!userId) return false;
  return unhideJob(getDb(), userId, jobId);
}

export function clearCurrentUserHidden(): number {
  const userId = getCurrentUserId();
  if (!userId) return 0;
  return clearHidden(getDb(), userId);
}
