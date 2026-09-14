// Per-user "models I have already seen" store — powers the honest
// "N new models" badge in Settings.
//
// Why: the provider's `created` timestamp marks nearly every model as recent
// (all 37 opencode-go models currently qualify), so a created-based "NEW"
// badge is noise. "New" should mean "appeared in the catalog since YOU last
// looked" — that is a per-user diff against this table.
//
// Semantics:
//   * First ever sight for a user (empty table): the whole catalog is
//     baselined silently — a first-time user is not told that everything
//     is new, because to them it isn't.
//   * unseenModelIds(allIds) = ids present now but not previously seen —
//     WITHOUT mutating state (read-only diff for the API response).
//   * markModelsSeen(ids) = acknowledge (badge clears; "· New" per-option
//     markers clear on the next response).

import type { Database } from 'better-sqlite3';
import { getDb, getCurrentUserId } from './fileStorage.js';

export function ensureModelSeenSchema(db: Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_catalog_seen (
      user_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (user_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_seen_user ON model_catalog_seen (user_id);
  `);
}

function seenIds(db: Database, userId: string): Set<string> {
  ensureModelSeenSchema(db);
  const rows = db.prepare('SELECT model_id FROM model_catalog_seen WHERE user_id = ?').all(userId) as Array<{ model_id: string }>;
  return new Set(rows.map((r) => r.model_id));
}

/** Ack: record every given id as seen for this user (idempotent). */
export function markModelsSeen(db: Database, userId: string, ids: string[]): number {
  ensureModelSeenSchema(db);
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO model_catalog_seen (user_id, model_id, first_seen_at) VALUES (?, ?, ?)');
  let added = 0;
  const tx = db.transaction((modelIds: string[]) => {
    for (const id of modelIds) {
      if (!id) continue;
      added += ins.run(userId, id, now).changes;
    }
  });
  tx(ids);
  return added;
}

/**
 * Diff: which of `allIds` this user has never seen.
 * First-ever sight (empty seen set) baselines the whole catalog silently and
 * returns [] — a first run must not shout "37 new models".
 */
export function unseenModelIds(db: Database, userId: string, allIds: string[]): string[] {
  const seen = seenIds(db, userId);
  if (seen.size === 0) {
    markModelsSeen(db, userId, allIds);
    return [];
  }
  return [...new Set(allIds)].filter((id) => id && !seen.has(id));
}

// Current-user convenience wrappers (used by the HTTP routes).
export function markCurrentUserModelsSeen(ids: string[]): number {
  const userId = getCurrentUserId();
  if (!userId) return 0;
  return markModelsSeen(getDb(), userId, ids);
}

export function currentUserUnseenModelIds(allIds: string[]): string[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  return unseenModelIds(getDb(), userId, allIds);
}
