// SQLite connection resilience — withDbRecovery behavior:
//   A. corrupt → reconnect → quick_check ok → retry → success
//   B. corrupt → reconnect → quick_check fails → NO retry, original error
//   C. retry also corrupt → fail normally, NO second reconnect loop
//   D. non-corrupt error → NO reconnect
//   E. transaction retry starts clean and stays atomic
// Fixtures only (tmp DB), zero live calls.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-recovery-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, withDbRecovery, resetDbConnection } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, replaceJobsForSearch, getJobIdsForSearch } = await import('../../server/storage/v2Tables.js');

function corruptErr(msg = 'database disk image is malformed'): Error {
  const e = new Error(msg);
  (e as any).code = 'SQLITE_CORRUPT';
  return e;
}

describe('withDbRecovery', () => {
  beforeAll(() => {
    ensureV2Tables();
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('A. corrupt → reconnect → quick_check ok → retry once → success', () => {
    let calls = 0;
    const out = withDbRecovery(() => {
      calls++;
      if (calls === 1) throw corruptErr();
      return 'ok-result';
    });
    expect(out).toBe('ok-result');
    expect(calls).toBe(2); // exactly one retry
    // The connection was genuinely reopened and still works.
    expect((getDb().prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1);
  });

  it('B. corrupt → reconnect → quick_check fails → NO retry, original error surfaced', () => {
    const dbPath = path.join(tmpDir, 'ats_jobs.sqlite');
    // Wedge the on-disk file so the REOPENED connection cannot read it
    // (quick_check fails / open fails) — simulates genuinely bad disk state.
    const original = fs.readFileSync(dbPath);
    let calls = 0;
    try {
      fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database'.repeat(100)));
      withDbRecovery(() => {
        calls++;
        throw corruptErr();
      });
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect((err as { code?: string }).code).toBe('SQLITE_CORRUPT'); // original error
    }
    expect(calls).toBe(1); // NO retry after failed reopen/quick_check
    fs.writeFileSync(dbPath, original); // restore for subsequent tests
    resetDbConnection();
    expect((getDb().prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1);
  });

  it('C. retry also corrupt → fail normally, no second reconnect loop', () => {
    let calls = 0;
    expect(() =>
      withDbRecovery(() => {
        calls++;
        throw corruptErr();
      })
    ).toThrow(/malformed/);
    expect(calls).toBe(2); // initial + ONE retry — no loop
    // Connection is healthy again after the recovery cycle.
    expect((getDb().prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1);
  });

  it('D. non-corrupt error → NO reconnect, error passes through', () => {
    let calls = 0;
    expect(() =>
      withDbRecovery(() => {
        calls++;
        throw new Error('ordinary boom');
      })
    ).toThrow('ordinary boom');
    expect(calls).toBe(1);
  });

  it('E. transaction retry starts clean and remains atomic (replaceJobsForSearch)', () => {
    const db = getDb();
    const searchId = 'search-recovery-atomic';
    db.prepare('DELETE FROM search_jobs WHERE search_id = ?').run(searchId);
    const ids = ['job-a', 'job-b', 'job-c'];
    const idSet = new Set(ids);
    const origPrepare = db.prepare.bind(db);
    let firstDelete = true;
    // First attempt: the DELETE inside the transaction throws SQLITE_CORRUPT.
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM search_jobs') && firstDelete) {
        firstDelete = false;
        return { run: () => { throw corruptErr(); } } as any;
      }
      return origPrepare(sql);
    });
    try {
      replaceJobsForSearch(searchId, ids);
    } finally {
      vi.restoreAllMocks();
    }
    // The retry re-executed the WHOLE transaction on the fresh connection:
    // exactly the 3 rows, no leftovers from the failed attempt. (The JOIN
    // needs the parent searches row to exist.)
    // `db` above was the PRE-recovery connection (now closed) — always use
    // getDb() after a recovery cycle.
    getDb().prepare('INSERT OR IGNORE INTO searches (id, user_id, query_fp, query, location, posted_window, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(searchId, 'any-user', 'fp', 'q', 'India', '7d', new Date().toISOString());
    const rows = getJobIdsForSearch('any-user', searchId);
    expect(rows.length).toBe(3);
    for (const r of rows) expect(idSet.has(r)).toBe(true);
    // Re-running is idempotent (replace semantics, not accumulate).
    replaceJobsForSearch(searchId, ['job-d']);
    const rows2 = getJobIdsForSearch('any-user', searchId);
    expect(rows2).toEqual(['job-d']);
  });

  it('F. recovery path keeps existing Greenhouse search behavior identical', async () => {
    // The wrapped functions are pure supersets: no corrupt error → identical
    // behavior to the original implementation (covered by the full suite).
    const { getOrCreateSearch } = await import('../../server/storage/v2Tables.js');
    const searchId = getOrCreateSearch('recovery-user', 'DevOps Engineer', 'India', '7d', 'greenhouse');
    expect(searchId).toMatch(/^search-/);
    // Same fingerprint reuses the same context (idempotent).
    const again = getOrCreateSearch('recovery-user', 'DevOps Engineer', 'India', '7d', 'greenhouse');
    expect(again).toBe(searchId);
  });
});