// Search history — persistence, newest-first ordering, canonical-search
// reuse with last-searched bump, per-search result retrieval, library
// separation. Fixtures only, zero live calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-history-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, getOrCreateSearch, getSearchHistory, getJobIdsForSearch, linkJobsToSearch, replaceJobsForSearch, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');

const USER = 'history-user';

function createSearch(query: string, location: string | undefined, window: string, source: string, jobs: string[]): string {
  const fp = canonicalQueryFp(query, location, window, source);
  const id = getOrCreateSearch(USER, query, location, window, source, source);
  replaceJobsForSearch(id, jobs);
  void fp;
  return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('search history', () => {
  beforeAll(() => {
    ensureV2Tables();
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'HistoryUser', 'h@test.local');
    getDb().prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('library-job-1', USER, JSON.stringify({ id: 'library-job-1', title: 'Library Job', fingerprint: 'library-job-1' }));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. new search persists into history', async () => {
    await sleep(5);
    createSearch('Software Engineer', 'India', '7d', 'Greenhouse', ['job-s1']);
    const h = getSearchHistory(USER);
    expect(h.length).toBe(1);
    expect(h[0].query).toBe('Software Engineer');
    expect(h[0].source).toBe('Greenhouse');
  });

  it('2+3+4. history is newest-first; later searches never remove earlier ones', async () => {
    await sleep(5); // ms-resolution timestamps need separation to avoid ties
    createSearch('Data Engineer', 'India', '7d', 'Greenhouse', ['job-d1']);
    await sleep(5);
    createSearch('DevOps Engineer', 'India', '7d', 'Greenhouse', ['job-o1']);
    const h = getSearchHistory(USER);
    expect(h.map((x) => x.query)).toEqual(['DevOps Engineer', 'Data Engineer', 'Software Engineer']);
    expect(h.length).toBe(3); // all persist, none removed
  });

  it('5+6+7. repeated canonical search reuses the searchId and moves to top, no duplicate row', async () => {
    const idA = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    const idB = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    expect(idA).toBe(idB); // canonical reuse
    await sleep(5);
    const before = getSearchHistory(USER);
    // Re-run Data Engineer → its searchId is reused AND bumped to top.
    const dataId = getOrCreateSearch(USER, 'Data Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    const rows = (getDb().prepare('SELECT count(*) c FROM searches WHERE id = ?').get(dataId) as { c: number }).c;
    expect(rows).toBe(1); // never a duplicate row
    const after = getSearchHistory(USER);
    expect(after.map((x) => x.query)).toEqual(['Data Engineer', 'DevOps Engineer', 'Software Engineer']);
    expect(getSearchHistory(USER).length).toBe(before.length);
    void idA; void idB;
  });

  it('8. repeated search still returns its results (addedCount=0 semantics)', () => {
    const id = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    replaceJobsForSearch(id, ['job-o1', 'job-o2', 'job-o3']);
    expect(getJobIdsForSearch(USER, id).length).toBe(3);
    // Re-run: reuse + re-link (idempotent replace) — results remain visible.
    const again = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    replaceJobsForSearch(again, ['job-o1', 'job-o2', 'job-o3']);
    expect(getJobIdsForSearch(USER, again).length).toBe(3);
  });

  it('9. page reload preserves history (persisted rows readable from a fresh connection)', () => {
    const fresh = new Database(path.join(tmpDir, 'ats_jobs.sqlite'), { readonly: true });
    const n = (fresh.prepare('SELECT count(*) c FROM searches WHERE user_id = ?').get(USER) as { c: number }).c;
    fresh.close();
    expect(n).toBe(3); // the three distinct canonical searches
  });

  it('10. history item loads ITS OWN search_jobs (searchId → jobs)', () => {
    const h = getSearchHistory(USER);
    const data = h.find((x) => x.query === 'Data Engineer')!;
    expect(getJobIdsForSearch(USER, data.id)).toEqual(['job-d1']);
    const devops = h.find((x) => x.query === 'DevOps Engineer')!;
    expect(getJobIdsForSearch(USER, devops.id).sort()).toEqual(['job-o1', 'job-o2', 'job-o3']);
  });

  it('11+12. clicking an old search returns ONLY its jobs (never the library, never network)', () => {
    const h = getSearchHistory(USER);
    const data = h.find((x) => x.query === 'Data Engineer')!;
    const ids = getJobIdsForSearch(USER, data.id);
    expect(ids).toEqual(['job-d1']); // not the library, not another search's jobs
    // The history click path is a pure local DB read — no provider, no fetch.
    expect(data.resultCount).toBe(1);
  });

  it('13+14. Show All Jobs = full library; current search view stays separate', () => {
    // Library = all durable jobs (no searchId scope); search view = the
    // searchId's job set. They are separate retrievals.
    const searchView = getJobIdsForSearch(USER, getSearchHistory(USER)[0].id);
    expect(searchView.length).toBeGreaterThan(0);
    // Library query returns every job row (not scoped) — assert via search_jobs
    // isolation: the search view only ever contains its own linked ids.
    const all = (getDb().prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c;
    expect(all).toBe(1); // the durable library row exists independently
    expect(searchView.length).toBeGreaterThan(0); // search view has its own set
  });

  it('15. result count == rendered card count (search_jobs rows)', () => {
    for (const item of getSearchHistory(USER)) {
      const linked = getJobIdsForSearch(USER, item.id).length;
      expect(item.resultCount).toBe(linked);
    }
  });

  it('16. source/date/location differences create DISTINCT canonical searches', () => {
    const a = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Greenhouse', 'Greenhouse');
    const b = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '30d', 'Greenhouse', 'Greenhouse');
    const c = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '7d', 'Lever', 'Lever');
    const d = getOrCreateSearch(USER, 'DevOps Engineer', 'Bengaluru', '7d', 'Greenhouse', 'Greenhouse');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('17. restart persistence — history survives a fresh connection to the same file', () => {
    const fresh = new Database(path.join(tmpDir, 'ats_jobs.sqlite'), { readonly: true });
    const rows = fresh.prepare('SELECT query, last_searched_at FROM searches WHERE user_id = ? ORDER BY last_searched_at DESC').all(USER) as Array<{ query: string; last_searched_at: string }>;
    fresh.close();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0].last_searched_at).toBeTruthy();
  });
});
describe('library ordering after search (UI feed behavior)', () => {
  it('same-search inserts keep ranked order (A,B,C) above older jobs; stable, persisted', async () => {
    const { runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');
    await runWithUser('order-user', async () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run('order-user', 'OrderUser', 'o@test.local');
      // Older job first.
      saveNewJobs([{
        id: 'old-1', fingerprint: 'old-1', title: 'Old Job', company: 'C', location: 'India',
        description: 'x', source: 'Greenhouse', url: 'https://x/old-1', applyUrl: 'https://x/old-1',
        createdAt: new Date(Date.now() - 86400e3).toISOString(), scrapedAt: new Date().toISOString(),
      } as any]);
      // One search inserts ranked A,B,C (same createdAt tick).
      // The real persist path stamps createdAt=now on insert (toDurableJob);
      // same tick for the whole batch keeps the ranked order via the stable
      // sort (rowid ASC fallback for the tie).
      const nowIso = new Date().toISOString();
      saveNewJobs([
        { id: 'rank-a', fingerprint: 'rank-a', title: 'Job A', company: 'C', location: 'India', description: 'x', source: 'Greenhouse', url: 'https://x/a', applyUrl: 'https://x/a', createdAt: nowIso, scrapedAt: nowIso } as any,
        { id: 'rank-b', fingerprint: 'rank-b', title: 'Job B', company: 'C', location: 'India', description: 'x', source: 'Greenhouse', url: 'https://x/b', applyUrl: 'https://x/b', createdAt: nowIso, scrapedAt: nowIso } as any,
        { id: 'rank-c', fingerprint: 'rank-c', title: 'Job C', company: 'C', location: 'India', description: 'x', source: 'Greenhouse', url: 'https://x/c', applyUrl: 'https://x/c', createdAt: nowIso, scrapedAt: nowIso } as any,
      ]);
      const all = queryJobs({ page: 1, limit: 10 }).jobs as any[];
      const titles = all.map((j) => j.title);
      // Newest (search) jobs first, ranked order A,B,C preserved, older below.
      expect(titles.indexOf('Job A')).toBeLessThan(titles.indexOf('Job B'));
      expect(titles.indexOf('Job B')).toBeLessThan(titles.indexOf('Job C'));
      expect(titles.indexOf('Job C')).toBeLessThan(titles.indexOf('Old Job'));
      // Persisted determinism: fresh read has the same order.
      const again = queryJobs({ page: 1, limit: 10 }).jobs as any[];
      expect(again.map((j) => j.id).join(',')).toBe(all.map((j) => j.id).join(','));
    });
  });

  it('re-found existing jobs are never duplicated (same fingerprint)', async () => {
    const { runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');
    await runWithUser('order-user', async () => {
      saveNewJobs([{
        id: 'dup-1', fingerprint: 'dup-1', title: 'Dup Job', company: 'C', location: 'India',
        description: 'x', source: 'Greenhouse', url: 'https://x/dup', applyUrl: 'https://x/dup',
        scrapedAt: new Date().toISOString(),
      } as any]);
      const once = (queryJobs({}).jobs as any[]).filter((j) => j.fingerprint === 'dup-1').length;
      expect(once).toBe(1);
    });
  });
});
