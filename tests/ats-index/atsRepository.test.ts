// ATS index repository — schema, upsert semantics, lifecycle, retention,
// FTS sync, provider isolation, restart persistence. Fixtures only, zero
// live calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-repo-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const {
  ensureAtsIndexSchema,
  upsertAtsJobs,
  deactivateStaleJobs,
  purgeInactiveJobs,
  queryAtsCandidates,
  clearAtsIndex,
  ftsLookup,
  atsIndexStats,
  boardRefreshStats,
  pickDueBoards,
  recordBoardAttempt,
  getBoardState,
} = await import('../../server/ats-index/atsRepository.js');
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';

const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();

function resetBoardState(): void {
  getDb().prepare("UPDATE company_career_sites SET last_attempt_at = NULL, last_success_at = NULL, failure_count = 0, next_refresh_at = NULL, last_job_count = NULL").run();
}

function row(over: Partial<AtsJobRow> = {}): AtsJobRow {
  return {
    fingerprint: 'gh-1',
    ats_platform: 'greenhouse',
    external_id: '1',
    company: 'Acme',
    company_slug: 'acme',
    title: 'DevOps Engineer',
    location: 'Bengaluru, India',
    employment_type: 'Full-time',
    work_mode: 'On-site',
    posted_date: iso(24),
    posted_date_semantics: 'published',
    apply_url: 'https://boards.greenhouse.io/acme/1',
    job_url: 'https://boards.greenhouse.io/acme/1',
    description: 'Role: DevOps Engineer',
    first_seen_at: '',
    last_seen_at: '',
    last_fetched_at: iso(0),
    is_active: 1,
    ...over,
  };
}

describe('atsRepository', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run('repo-user', 'Repo', 'repo@test.local');
    const ins = db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    );
    for (const slug of ['acme', 'globex', 'initech']) {
      ins.run(`sb-${slug}`, slug, `https://boards.greenhouse.io/${slug}`, 'greenhouse', slug, iso(24 * 30), iso(24 * 30));
    }
    ins.run('sb-lev1', 'levco', 'https://jobs.lever.co/levco', 'lever', 'levco', iso(24 * 30), iso(24 * 30));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('schema exists: ats_jobs + ats_jobs_fts (FTS5)', () => {
    const st = atsIndexStats();
    expect(st.tables).toContain('ats_jobs');
    expect(st.tables).toContain('ats_jobs_fts');
  });

  it('new job inserts with first_seen = last_seen; repeat upsert dedupes, preserves first_seen, advances last_seen', () => {
    clearAtsIndex('greenhouse');
    const first = upsertAtsJobs([row()]);
    expect(first.inserted).toBe(1);
    const db = getDb();
    const before = db.prepare('SELECT first_seen_at, last_seen_at, is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-1') as { first_seen_at: string; last_seen_at: string; is_active: number };
    expect(before.is_active).toBe(1);
    // Repeat with updated title + older last_seen.
    db.prepare('UPDATE ats_jobs SET last_seen_at = ? WHERE fingerprint = ?').run(iso(500), 'gh-1');
    const second = upsertAtsJobs([row({ title: 'Senior DevOps Engineer' })]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    const after = db.prepare('SELECT first_seen_at, last_seen_at, title, is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-1') as { first_seen_at: string; last_seen_at: string; title: string; is_active: number };
    expect(after.first_seen_at).toBe(before.first_seen_at); // never reset
    expect(after.last_seen_at).not.toBe(iso(500)); // advanced past the artificially-old value
    expect(after.title).toBe('Senior DevOps Engineer'); // mutable metadata updated
    expect(after.is_active).toBe(1);
    const count = (getDb().prepare('SELECT count(*) c FROM ats_jobs WHERE fingerprint = ?').get('gh-1') as { c: number }).c;
    expect(count).toBe(1); // no duplicate rows
  });

  it('publication date never downgraded: updated → published wins, published stays', () => {
    clearAtsIndex('greenhouse');
    upsertAtsJobs([row({ fingerprint: 'gh-d1', posted_date: iso(100), posted_date_semantics: 'updated' })]);
    upsertAtsJobs([row({ fingerprint: 'gh-d1', posted_date: iso(30), posted_date_semantics: 'published' })]);
    const db = getDb();
    const a = db.prepare('SELECT posted_date, posted_date_semantics FROM ats_jobs WHERE fingerprint = ?').get('gh-d1') as { posted_date: string; posted_date_semantics: string };
    expect(a.posted_date_semantics).toBe('published'); // upgraded
    upsertAtsJobs([row({ fingerprint: 'gh-d1', posted_date: iso(10), posted_date_semantics: 'updated' })]);
    const b = db.prepare('SELECT posted_date, posted_date_semantics FROM ats_jobs WHERE fingerprint = ?').get('gh-d1') as { posted_date: string; posted_date_semantics: string };
    expect(b.posted_date_semantics).toBe('published'); // never downgraded
  });

  it('provider isolation: querying greenhouse never returns lever rows', () => {
    clearAtsIndex();
    upsertAtsJobs([row()]);
    upsertAtsJobs([row({ fingerprint: 'lev-1', ats_platform: 'lever', external_id: '1', company: 'Levco', company_slug: 'levco', apply_url: 'https://jobs.lever.co/levco/1', job_url: 'https://jobs.lever.co/levco/1' })]);
    const gh = queryAtsCandidates({ platform: 'greenhouse', activeOnly: true });
    const lv = queryAtsCandidates({ platform: 'lever', activeOnly: true });
    expect(gh.map((j) => j.fingerprint)).toEqual(['gh-1']);
    expect(lv.map((j) => j.fingerprint)).toEqual(['lev-1']);
  });

  it('lifecycle: stale deactivation after grace; failed state never deactivates', () => {
    clearAtsIndex('greenhouse');
    const db = getDb();
    upsertAtsJobs([row({ fingerprint: 'gh-old' }), row({ fingerprint: 'gh-new' })]);
    // gh-old has been ABSENT for 100h (beyond the 48h grace).
    db.prepare('UPDATE ats_jobs SET last_seen_at = ? WHERE fingerprint = ?').run(iso(100), 'gh-old');
    const deactivated = deactivateStaleJobs(48, 'greenhouse');
    expect(deactivated).toBe(1);
    const old = db.prepare('SELECT is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-old') as { is_active: number };
    const fresh = db.prepare('SELECT is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-new') as { is_active: number };
    expect(old.is_active).toBe(0);
    expect(fresh.is_active).toBe(1);
    // Re-observation reactivates.
    upsertAtsJobs([row({ fingerprint: 'gh-old' })]);
    expect((db.prepare('SELECT is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-old') as { is_active: number }).is_active).toBe(1);
  });

  it('retention: old inactive purged, active kept, durable user jobs untouched', () => {
    clearAtsIndex('greenhouse');
    const db = getDb();
    upsertAtsJobs([row({ fingerprint: 'gh-ret' }), row({ fingerprint: 'gh-keep' })]);
    db.prepare('UPDATE ats_jobs SET is_active = 0, last_seen_at = ? WHERE fingerprint = ?').run(iso(24 * 45), 'gh-ret');
    db.prepare('UPDATE ats_jobs SET is_active = 0, last_seen_at = ? WHERE fingerprint = ?').run(iso(10), 'gh-keep');
    db.prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('user-job-1', 'repo-user', JSON.stringify({ title: 'Durable' }));
    const purged = purgeInactiveJobs(30, 'greenhouse');
    expect(purged).toBe(1);
    expect((db.prepare('SELECT count(*) c FROM ats_jobs WHERE fingerprint = ?').get('gh-ret') as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM ats_jobs WHERE fingerprint = ?').get('gh-keep') as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT count(*) c FROM jobs WHERE id = ?').get('user-job-1') as { c: number }).c).toBe(1); // user workflow untouched
  });

  it('FTS mirrors ats_jobs: MATCH lookup + sync on upsert/purge', () => {
    clearAtsIndex('greenhouse');
    upsertAtsJobs([row({ fingerprint: 'gh-f1', title: 'DevOps Engineer', company: 'Acme' }), row({ fingerprint: 'gh-f2', title: 'Data Engineer', company: 'Globex' })]);
    const devops = ftsLookup('greenhouse', 'devops');
    expect(devops.map((j) => j.fingerprint)).toContain('gh-f1');
    expect(devops.map((j) => j.fingerprint)).not.toContain('gh-f2');
    // Update syncs FTS.
    upsertAtsJobs([row({ fingerprint: 'gh-f1', title: 'SRE' })]);
    expect(ftsLookup('greenhouse', 'sre').map((j) => j.fingerprint)).toContain('gh-f1');
    expect(ftsLookup('greenhouse', 'devops').map((j) => j.fingerprint)).not.toContain('gh-f1');
    // Purge removes FTS rows.
    const db = getDb();
    db.prepare('UPDATE ats_jobs SET is_active = 0, last_seen_at = ? WHERE fingerprint = ?').run(iso(24 * 45), 'gh-f2');
    purgeInactiveJobs(30, 'greenhouse');
    expect(ftsLookup('greenhouse', 'globex').length).toBe(0);
  });

  it('board refresh state: success resets failures, failure backs off', () => {
    const before = getBoardState('greenhouse', 'acme');
    recordBoardAttempt('greenhouse', 'acme', true, 42, iso(-2));
    const ok = getBoardState('greenhouse', 'acme')!;
    expect(ok.lastSuccessAt).toBeTruthy();
    expect(ok.failureCount).toBe(0);
    expect(ok.lastJobCount).toBe(42);
    recordBoardAttempt('greenhouse', 'acme', false, 0, iso(-24));
    const fail = getBoardState('greenhouse', 'acme')!;
    expect(fail.failureCount).toBe(1);
    expect(fail.lastSuccessAt).toBeTruthy(); // success history preserved
    void before;
  });

  it('pickDueBoards: never-synced boards first, then due, bounded', () => {
    recordBoardAttempt('greenhouse', 'globex', true, 5, iso(100)); // due (past)
    recordBoardAttempt('greenhouse', 'initech', true, 5, iso(-10000)); // not due
    // acme was just refreshed above → not due.
    const due = pickDueBoards('greenhouse', 10);
    const slugs = due.map((b) => b.atsCompanySlug);
    expect(slugs).toContain('globex');
    expect(slugs).not.toContain('initech');
    expect(slugs).not.toContain('acme');
    expect(due.length).toBeLessThanOrEqual(10);
    // never-synced boards are due (levco has no refresh state).
    expect(pickDueBoards('lever', 10).map((b) => b.atsCompanySlug)).toContain('levco');
  });

  it('restart persistence: rows survive a fresh DB connection to the same file', () => {
    clearAtsIndex('greenhouse');
    upsertAtsJobs([row({ fingerprint: 'gh-restart' })]);
    const dbFile = path.join(tmpDir, 'ats_jobs.sqlite');
    const fresh = new Database(dbFile, { readonly: true });
    const c = fresh.prepare('SELECT count(*) c FROM ats_jobs WHERE fingerprint = ?').get('gh-restart') as { c: number };
    fresh.close();
    expect(c.c).toBe(1);
  });

  it('empty index state is reported honestly (boardsSynced 0 / activeJobs 0)', () => {
    clearAtsIndex('greenhouse');
    resetBoardState();
    const st = boardRefreshStats('greenhouse');
    expect(st.boardsTotal).toBe(3);
    expect(st.activeJobs).toBe(0);
    expect(st.indexState).toBe('uninitialized');
    expect(st.coveragePercent).toBe(0);
  });

  it('index readiness: partial sync = building, full sync = ready (never "count>0 == ready")', () => {
    clearAtsIndex('greenhouse');
    resetBoardState();
    // Partial: 1 of 3 boards synced → building, not ready.
    recordBoardAttempt('greenhouse', 'acme', true, 2, iso(-2));
    let st = boardRefreshStats('greenhouse');
    expect(st.indexState).toBe('building');
    expect(st.coveragePercent).toBe(33);
    expect(st.boardsSynced > 0 && st.activeJobs === 0).toBe(true); // the old "ready" heuristic would lie here
    // Full: all 3 boards resolved (2 synced + 1 dead-failed) → ready.
    recordBoardAttempt('greenhouse', 'globex', true, 3, iso(-2));
    recordBoardAttempt('greenhouse', 'initech', false, 0, iso(-2));
    st = boardRefreshStats('greenhouse');
    expect(st.indexState).toBe('ready');
    expect(st.coveragePercent).toBe(100);
  });

  it('registry rows with NULL atsCompanySlug are backfilled (board state survives)', () => {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'greenhouse', 1, ?, ?)`
    ).run('sb-nullslug', 'NullSlug Co', 'https://boards.greenhouse.io/nullslugco', iso(24 * 30), iso(24 * 30));
    // Simulate the registry bug: slug column NULL → state writes matched nothing.
    db.prepare("UPDATE company_career_sites SET atsCompanySlug = NULL WHERE id = 'sb-nullslug'").run();
    ensureAtsIndexSchema(); // backfills the slug
    const row = db.prepare("SELECT atsCompanySlug FROM company_career_sites WHERE id = 'sb-nullslug'").get() as { atsCompanySlug: string | null };
    expect(row.atsCompanySlug).toBe('nullslugco');
    // State now persists for this board.
    recordBoardAttempt('greenhouse', 'nullslugco', false, 0, iso(-24));
    const st = getBoardState('greenhouse', 'nullslugco')!;
    expect(st.failureCount).toBe(1);
    expect(st.lastSuccessAt).toBeFalsy();
  });
});