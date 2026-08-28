// ATS local index repository — market-data storage, completely separate
// from the durable user `jobs` table.
//
//   ats_jobs   = "what jobs currently exist in the market" (discovered data)
//   jobs       = "what jobs is this user working with" (workflow data)
//
// A job enters the user workflow only through the existing product logic
// (search survivors / user interaction) — never through this module.
//
// Identity: canonical fingerprint (same scheme as the providers, e.g.
// `gh-{externalId}`). first_seen_at is NEVER reset; last_seen_at advances on
// every successful observation. Lifecycle is conservative: a job is
// deactivated only after it has been ABSENT from successful board refreshes
// for ATS_ABSENCE_GRACE_HOURS — a failed board fetch never touches state.
//
// FTS5 (verified available in the runtime): ats_jobs_fts mirrors title/
// company/location for lookup + benchmarking. The search path deliberately
// does NOT use FTS as a candidate prefilter: FTS token matching would drop
// abbreviation/related candidates the generic relevance engine accepts
// (e.g. "SRE" vs "Site Reliability Engineer", "platform" for a DevOps
// query). Correctness first — measured in the benchmark report.

import { getDb } from '../storage/fileStorage.js';
import { statSync } from 'node:fs';

export interface AtsJobRow {
  fingerprint: string;
  ats_platform: string;
  external_id: string;
  company: string;
  company_slug: string;
  title: string;
  location?: string | null;
  employment_type?: string | null;
  work_mode?: string | null;
  posted_date?: string | null;
  posted_date_semantics?: string | null;
  apply_url?: string | null;
  job_url?: string | null;
  description?: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_fetched_at: string;
  is_active: number;
}

export interface BoardRefreshRow {
  id: string;
  companyName: string;
  careerUrl: string;
  atsPlatform: string;
  atsCompanySlug?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  failureCount: number;
  nextRefreshAt?: string | null;
  lastJobCount?: number | null;
}

export interface CandidateQuery {
  platform: string;
  activeOnly?: boolean;
  /** SQL-level optimization only: the orchestrator re-validates the window. */
  minPostedDate?: string;
}

const BOARD_STATE_COLUMNS: Array<[string, string]> = [
  ['last_attempt_at', 'TEXT'],
  ['last_success_at', 'TEXT'],
  ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_refresh_at', 'TEXT'],
  ['last_job_count', 'INTEGER'],
];

export function ensureAtsIndexSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ats_jobs (
      fingerprint TEXT PRIMARY KEY,
      ats_platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      company TEXT NOT NULL,
      company_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      employment_type TEXT,
      work_mode TEXT,
      posted_date TEXT,
      posted_date_semantics TEXT,
      apply_url TEXT,
      job_url TEXT,
      description TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_ats_jobs_platform_active ON ats_jobs (ats_platform, is_active);
    CREATE INDEX IF NOT EXISTS idx_ats_jobs_posted ON ats_jobs (posted_date);
    CREATE INDEX IF NOT EXISTS idx_ats_jobs_slug_active ON ats_jobs (company_slug, is_active);
    CREATE VIRTUAL TABLE IF NOT EXISTS ats_jobs_fts USING fts5(title, company, location, content='ats_jobs', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS ats_jobs_ai AFTER INSERT ON ats_jobs BEGIN
      INSERT INTO ats_jobs_fts(rowid, title, company, location) VALUES (new.rowid, new.title, new.company, new.location);
    END;
    CREATE TRIGGER IF NOT EXISTS ats_jobs_ad AFTER DELETE ON ats_jobs BEGIN
      INSERT INTO ats_jobs_fts(ats_jobs_fts, rowid, title, company, location) VALUES ('delete', old.rowid, old.title, old.company, old.location);
    END;
    CREATE TRIGGER IF NOT EXISTS ats_jobs_au AFTER UPDATE ON ats_jobs BEGIN
      INSERT INTO ats_jobs_fts(ats_jobs_fts, rowid, title, company, location) VALUES ('delete', old.rowid, old.title, old.company, old.location);
      INSERT INTO ats_jobs_fts(rowid, title, company, location) VALUES (new.rowid, new.title, new.company, new.location);
    END;
  `);
  // Non-destructive refresh-state columns on the single board registry.
  // ALTER ADD COLUMN is idempotent-guarded — never rewrites the table.
  const existing = new Set((db.prepare('PRAGMA table_info(company_career_sites)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, decl] of BOARD_STATE_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE company_career_sites ADD COLUMN ${name} ${decl}`);
    }
  }
  backfillBoardSlugs();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Board slug derived from the registry careerUrl (per ATS platform). */
export function boardSlug(careerUrl: string, platform: string): string | null {
  const re =
    platform === 'greenhouse'
      ? /boards\.greenhouse\.io\/([^/]+)/
      : platform === 'lever'
        ? /jobs\.lever\.co\/([^/]+)/
        : /jobs\.ashbyhq\.com\/([^/]+)/;
  return careerUrl.match(re)?.[1] ?? null;
}

/**
 * Backfill atsCompanySlug on rows the registry never populated. The
 * refresh-state mechanism keys on this column; a NULL slug silently loses
 * every board state (failures/backoff/success) and would re-sync ALL boards
 * on every scheduler tick. Idempotent, non-destructive.
 */
function backfillBoardSlugs(): void {
  const db = getDb();
  const rows = db.prepare("SELECT id, careerUrl, atsPlatform FROM company_career_sites WHERE atsCompanySlug IS NULL OR atsCompanySlug = ''").all() as Array<{ id: string; careerUrl: string; atsPlatform: string }>;
  if (rows.length === 0) return;
  const upd = db.prepare('UPDATE company_career_sites SET atsCompanySlug = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const slug = boardSlug(r.careerUrl, String(r.atsPlatform).toLowerCase());
      if (slug) upd.run(slug, r.id);
    }
  });
  tx();
}

// ── Upsert ──────────────────────────────────────────────────────────────

/**
 * Upsert a batch of observed jobs (one board refresh). Single transaction.
 * New fingerprint → INSERT with first_seen_at=now. Existing → update mutable
 * metadata + last_seen_at, is_active=1. first_seen_at never resets. FTS rows
 * stay in sync.
 */
export function upsertAtsJobs(jobs: AtsJobRow[]): { inserted: number; updated: number } {
  const db = getDb();
  ensureAtsIndexSchema();
  let inserted = 0;
  let updated = 0;
  const tx = db.transaction(() => {
    for (const j of jobs) {
      const existing = db.prepare('SELECT rowid, first_seen_at, is_active FROM ats_jobs WHERE fingerprint = ?').get(j.fingerprint) as { rowid: number; first_seen_at: string; is_active: number } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO ats_jobs (fingerprint, ats_platform, external_id, company, company_slug, title, location, employment_type, work_mode, posted_date, posted_date_semantics, apply_url, job_url, description, first_seen_at, last_seen_at, last_fetched_at, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          j.fingerprint, j.ats_platform, j.external_id, j.company, j.company_slug, j.title,
          j.location ?? null, j.employment_type ?? null, j.work_mode ?? null, j.posted_date ?? null,
          j.posted_date_semantics ?? null, j.apply_url ?? null, j.job_url ?? null, j.description ?? null,
          nowIso(), nowIso(), j.last_fetched_at || nowIso()
        );
        inserted++;
      } else {
        // Never downgrade a trustworthy publication date to an inferior
        // timestamp (e.g. updated_at over first_published).
        const current = db.prepare('SELECT posted_date, posted_date_semantics FROM ats_jobs WHERE fingerprint = ?').get(j.fingerprint) as { posted_date: string | null; posted_date_semantics: string | null };
        const dateWins = (!current.posted_date && j.posted_date) || (current.posted_date && j.posted_date && current.posted_date_semantics === 'updated' && j.posted_date_semantics !== 'updated');
        const postedDate = dateWins ? j.posted_date : current.posted_date;
        const postedSemantics = dateWins ? j.posted_date_semantics : current.posted_date_semantics;
        db.prepare(
          `UPDATE ats_jobs SET title = ?, company = ?, location = ?, employment_type = ?, work_mode = ?,
            posted_date = ?, posted_date_semantics = ?, apply_url = ?, job_url = ?, description = ?,
            last_seen_at = ?, last_fetched_at = ?, is_active = 1
           WHERE fingerprint = ?`
        ).run(
          j.title, j.company, j.location ?? null, j.employment_type ?? null, j.work_mode ?? null,
          postedDate, postedSemantics, j.apply_url ?? null, j.job_url ?? null, j.description ?? null,
          nowIso(), j.last_fetched_at || nowIso(), j.fingerprint
        );
        updated++;
      }
    }
  });
  tx();
  return { inserted, updated };
}

// ── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Deactivate jobs that have been ABSENT from successful board refreshes for
 * longer than the grace period. Conservative: absence from one failed fetch
 * never deactivates; only the passage of time after repeated successful
 * refreshes that no longer observed the job does.
 */
export function deactivateStaleJobs(graceHours: number, platform?: string): number {
  const db = getDb();
  ensureAtsIndexSchema();
  const cutoff = new Date(Date.now() - graceHours * 3600e3).toISOString();
  const r = platform
    ? db.prepare('UPDATE ats_jobs SET is_active = 0 WHERE is_active = 1 AND ats_platform = ? AND last_seen_at < ?').run(platform, cutoff)
    : db.prepare('UPDATE ats_jobs SET is_active = 0 WHERE is_active = 1 AND last_seen_at < ?').run(cutoff);
  return r.changes;
}

/** Purge old inactive rows after the retention period (never touches durable user jobs). */
export function purgeInactiveJobs(retentionDays: number, platform?: string): number {
  const db = getDb();
  ensureAtsIndexSchema();
  const cutoff = new Date(Date.now() - retentionDays * 86400e3).toISOString();
  const rows = (platform
    ? db.prepare('SELECT rowid FROM ats_jobs WHERE is_active = 0 AND ats_platform = ? AND last_seen_at < ?').all(platform, cutoff)
    : db.prepare('SELECT rowid FROM ats_jobs WHERE is_active = 0 AND last_seen_at < ?').all(cutoff)) as Array<{ rowid: number }>;
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.rowid);
  db.prepare(`DELETE FROM ats_jobs WHERE rowid IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return rows.length;
}

// ── Board refresh state (single registry, non-destructive columns) ──────

function toBoardRefreshRow(r: Record<string, unknown>): BoardRefreshRow {
  return {
    id: String(r.id),
    companyName: String(r.companyName),
    careerUrl: String(r.careerUrl),
    atsPlatform: String(r.atsPlatform),
    atsCompanySlug: (r.atsCompanySlug as string | null) ?? null,
    lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
    lastSuccessAt: (r.last_success_at as string | null) ?? null,
    failureCount: Number(r.failure_count ?? 0),
    nextRefreshAt: (r.next_refresh_at as string | null) ?? null,
    lastJobCount: (r.last_job_count as number | null) ?? null,
  };
}

// Match by atsCompanySlug OR the careerUrl-derived slug — self-healing for
// any registry row that still carries a NULL slug.
function boardMatchWhere(): string {
  return `(atsCompanySlug = ? OR careerUrl LIKE '%/' || ?)`;
}

export function getBoardState(platform: string, slug: string): BoardRefreshRow | undefined {
  const db = getDb();
  ensureAtsIndexSchema();
  const r = db.prepare(
    `SELECT id, companyName, careerUrl, atsPlatform, atsCompanySlug, last_attempt_at, last_success_at, failure_count, next_refresh_at, last_job_count
     FROM company_career_sites WHERE LOWER(atsPlatform) = ? AND ${boardMatchWhere()}`
  ).get(platform, slug, slug) as Record<string, unknown> | undefined;
  return r ? toBoardRefreshRow(r) : undefined;
}

export function recordBoardAttempt(platform: string, slug: string, ok: boolean, jobCount: number, nextRefreshAt: string): void {
  const db = getDb();
  ensureAtsIndexSchema();
  const now = nowIso();
  if (ok) {
    db.prepare(
      `UPDATE company_career_sites SET last_attempt_at = ?, last_success_at = ?, failure_count = 0, last_job_count = ?, next_refresh_at = ? WHERE LOWER(atsPlatform) = ? AND ${boardMatchWhere()}`
    ).run(now, now, jobCount, nextRefreshAt, platform, slug, slug);
  } else {
    db.prepare(
      `UPDATE company_career_sites SET last_attempt_at = ?, failure_count = failure_count + 1, next_refresh_at = ? WHERE LOWER(atsPlatform) = ? AND ${boardMatchWhere()}`
    ).run(now, nextRefreshAt, platform, slug, slug);
  }
}

/**
 * Boards due for refresh (never synced OR next_refresh_at passed), newest
 * boards first — a fresh installation starts with recent additions before
 * the long tail. Bounded by `limit`.
 */
export function pickDueBoards(platform: string, limit: number): BoardRefreshRow[] {
  const db = getDb();
  ensureAtsIndexSchema();
  const rows = db.prepare(
    `SELECT id, companyName, careerUrl, atsPlatform, atsCompanySlug, last_attempt_at, last_success_at, failure_count, next_refresh_at, last_job_count
     FROM company_career_sites
     WHERE LOWER(atsPlatform) = ? AND isActive = 1 AND (next_refresh_at IS NULL OR next_refresh_at <= ?)
     ORDER BY CASE WHEN next_refresh_at IS NULL THEN 0 ELSE 1 END, rowid DESC
     LIMIT ?`
  ).all(platform, nowIso(), limit) as Array<Record<string, unknown>>;
  return rows.map(toBoardRefreshRow);
}

export type IndexReadinessState = 'uninitialized' | 'building' | 'ready' | 'stale';

export interface BoardRefreshStats {
  boardsTotal: number;
  boardsSynced: number;
  activeJobs: number;
  lastRefreshAt: string | null;
  refreshInProgress: boolean;
  /** Honest coverage state — synced>0 is NOT "ready": 4,000 indexed jobs ≠
   *  complete 6,032-board ingestion. */
  indexState: IndexReadinessState;
  coveragePercent: number;
}

const READY_THRESHOLD = 0.98;
const STALE_AFTER_DAYS = 7;

export function boardRefreshStats(platform: string): BoardRefreshStats {
  const db = getDb();
  ensureAtsIndexSchema();
  const total = (db.prepare('SELECT count(*) c FROM company_career_sites WHERE LOWER(atsPlatform) = ? AND isActive = 1').get(platform) as { c: number }).c;
  const synced = (db.prepare('SELECT count(*) c FROM company_career_sites WHERE LOWER(atsPlatform) = ? AND last_success_at IS NOT NULL').get(platform) as { c: number }).c;
  // Boards that failed at least once with NO successful sync are dead —
  // they count as "resolved" (a full crawl visits every registry row once,
  // including the dead ones).
  const failedDead = (db.prepare('SELECT count(*) c FROM company_career_sites WHERE LOWER(atsPlatform) = ? AND last_success_at IS NULL AND failure_count > 0').get(platform) as { c: number }).c;
  const active = (db.prepare('SELECT count(*) c FROM ats_jobs WHERE ats_platform = ? AND is_active = 1').get(platform) as { c: number }).c;
  const last = db.prepare('SELECT MAX(last_success_at) m FROM company_career_sites WHERE LOWER(atsPlatform) = ?').get(platform) as { m: string | null };
  const resolved = synced + failedDead;
  let indexState: IndexReadinessState = 'uninitialized';
  if (resolved > 0) {
    indexState = resolved >= total * READY_THRESHOLD ? 'ready' : 'building';
    if (indexState === 'ready' && last.m && Date.now() - new Date(last.m).getTime() > STALE_AFTER_DAYS * 86400e3) {
      indexState = 'stale';
    }
  }
  return {
    boardsTotal: total,
    boardsSynced: synced,
    activeJobs: active,
    lastRefreshAt: last.m,
    refreshInProgress: false,
    indexState,
    coveragePercent: total ? Math.round((resolved / total) * 100) : 0,
  };
}

// ── Candidate retrieval (search side) ───────────────────────────────────

/**
 * SQL candidate retrieval for the LOCAL index provider. Deliberately minimal:
 * platform (+ active) and an optional SQL-side min-posted-date optimization.
 * Date/location/work-mode/relevance filters stay in the ORCHESTRATOR — the
 * single filtering pipeline, never duplicated here.
 */
export function queryAtsCandidates(q: CandidateQuery): AtsJobRow[] {
  const db = getDb();
  ensureAtsIndexSchema();
  const where: string[] = ['ats_platform = ?'];
  const args: unknown[] = [q.platform];
  if (q.activeOnly) {
    where.push('is_active = 1');
  }
  if (q.minPostedDate) {
    where.push('posted_date >= ?');
    args.push(q.minPostedDate);
  }
  return db.prepare(`SELECT fingerprint, ats_platform, external_id, company, company_slug, title, location, employment_type, work_mode, posted_date, posted_date_semantics, apply_url, job_url, description, first_seen_at, last_seen_at, last_fetched_at, is_active FROM ats_jobs WHERE ${where.join(' AND ')}`).all(...args) as AtsJobRow[];
}

export function atsIndexStats(): { tables: string[]; ftsCount: number; jobsCount: number } {
  const db = getDb();
  ensureAtsIndexSchema();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ats_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  const fts = (db.prepare('SELECT count(*) c FROM ats_jobs_fts').get() as { c: number }).c;
  const jobs = (db.prepare('SELECT count(*) c FROM ats_jobs').get() as { c: number }).c;
  return { tables, ftsCount: fts, jobsCount: jobs };
}

// FTS sync is owned by the ats_jobs triggers; clearing ats_jobs clears FTS.
export function clearAtsIndex(platform?: string): void {
  const db = getDb();
  ensureAtsIndexSchema();
  if (platform) {
    db.prepare('DELETE FROM ats_jobs WHERE ats_platform = ?').run(platform);
  } else {
    db.exec('DELETE FROM ats_jobs;');
  }
}

/** FTS5 lookup — used by tests/benchmarks, NOT the search path (see header). */
export function ftsLookup(platform: string, match: string): AtsJobRow[] {
  const db = getDb();
  ensureAtsIndexSchema();
  const rows = db.prepare(
    `SELECT j.* FROM ats_jobs_fts f JOIN ats_jobs j ON j.rowid = f.rowid
     WHERE ats_jobs_fts MATCH ? AND j.ats_platform = ?`
  ).all(match, platform) as AtsJobRow[];
  return rows;
}

export function dbSizeBytes(): number {
  const db = getDb();
  const path = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}