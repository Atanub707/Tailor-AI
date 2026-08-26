import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-watcher-'));
process.env.TAILOR_DATA_DIR = tmpDir;

// Vitest hoists static imports above the TAILOR_DATA_DIR assignment, so the
// storage module would be evaluated against the REAL data dir. Dynamic import
// after the env var is set keeps this test hermetic (Task 1 pattern).
const { getDb, runWithUser, saveNewJobs, getAllJobs } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const providerModule = await import('../../server/providers/directAtsProvider.js');
const { watchOnce, setSearchInFlight, isSearchInFlight, startWatcher } = await import('../../server/indexer/watcher.js');

const USER = 'watcher-user';
const mk = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, title: 'DevOps Engineer', company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
  ...overrides,
} as any);

const seedBoards = (n: number, prefix = 'w') => {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)'
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`${prefix}-${i}`, `BoardCo${i}`, `https://boards.greenhouse.io/${prefix}co${i}`, 'greenhouse', now, now);
  }
};

describe('background watcher', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Watcher', 'w@test.local');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setSearchInFlight(false);
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('watchOnce with no boards returns zero stats without throwing', async () => {
    await runWithUser(USER, async () => {
      const stats = await watchOnce();
      expect(stats).toHaveProperty('boardsChecked');
      expect(stats.boardsChecked).toBeGreaterThanOrEqual(0);
      expect(stats.skipped).toBe(false);
    });
  });

  it('skips a cycle when a search is in flight', async () => {
    setSearchInFlight(true);
    expect(isSearchInFlight()).toBe(true);
    const stats = await watchOnce();
    expect(stats.skipped).toBe(true);
    setSearchInFlight(false);
    expect(isSearchInFlight()).toBe(false);
  });

  it('board failure is isolated — one failing board does not abort the cycle (mocked, zero live calls)', async () => {
    seedBoards(8, 'iso');
    vi.spyOn(providerModule, 'fetchBoard').mockImplementation(async (_source, _platform, companyName, careerUrl) => {
      if (careerUrl.includes('isoco3')) throw new Error('board down');
      return [];
    });
    const stats = await watchOnce();
    expect(stats).toHaveProperty('errors');
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain('BoardCo3');
    expect(stats.boardsChecked).toBe(7);
    expect(stats.skipped).toBe(false);
  });

  it('diffs fresh jobs against stored jobs and persists added/bumped/missing per user', async () => {
    const db = getDb();
    // Only one board returns fresh jobs; the rest are empty (deterministic totals).
    db.prepare("UPDATE company_career_sites SET isActive = 0 WHERE id LIKE 'iso-%'").run();
    db.prepare('DELETE FROM jobs').run(); // hermetic per-user state (temp DB)
    seedBoards(1, 'persist');
    // Stored jobs must carry the board's identity (hostname + path): the
    // watcher scopes the diff to the refreshed board, not the whole platform.
    const onBoard = (id: string) => ({
      company: 'BoardCo0',
      url: `https://boards.greenhouse.io/persistco0/${id}`,
      applyUrl: `https://boards.greenhouse.io/persistco0/${id}`,
    });
    const spy = vi.spyOn(providerModule, 'fetchBoard').mockImplementation(async (_source, _platform, _companyName, careerUrl) => {
      if (careerUrl.includes('persistco0')) return [mk('a', onBoard('a')), mk('b', onBoard('b'))];
      return [];
    });

    await runWithUser(USER, async () => {
      saveNewJobs([mk('a', onBoard('a')), mk('stale', onBoard('stale'))]);
    });

    const stats = await watchOnce();
    expect(spy).toHaveBeenCalled();
    expect(stats.boardsChecked).toBe(1);
    expect(stats.errors).toEqual([]);
    // The watcher refreshes EVERY user (fileStorage auto-creates an admin
    // user, so the global counts include that user's first-time additions).
    // Per-user behavior is asserted exactly below; stats are asserted robustly.
    expect(stats.added).toBeGreaterThanOrEqual(1); // b is new
    expect(stats.updated).toBeGreaterThanOrEqual(1); // a is still present → bumped
    expect(stats.missing).toBeGreaterThanOrEqual(1); // stale is gone from the board → inactive

    await runWithUser(USER, async () => {
      const jobs = getAllJobs();
      expect(jobs.map((j: any) => j.id).sort()).toEqual(['a', 'b', 'stale']);
      expect(jobs.find((j: any) => j.id === 'b')).toBeTruthy();
      expect((jobs.find((j: any) => j.id === 'stale') as any).isActive).toBe(false);
      expect((jobs.find((j: any) => j.id === 'a') as any).isActive).not.toBe(false);
    });
  });

  it('multi-company: refreshing one board never marks another company\u2019s same-platform jobs inactive', async () => {
    const db = getDb();
    // Only this test's two boards are active — deterministic slice.
    db.prepare('UPDATE company_career_sites SET isActive = 0').run();
    db.prepare('DELETE FROM jobs').run(); // hermetic per-user state (temp DB)
    seedBoards(2, 'multi'); // multico0 (BoardCo0) + multico1 (BoardCo1), both greenhouse
    const a = mk('mc-a', { company: 'BoardCo0', url: 'https://boards.greenhouse.io/multico0/jobs/111', applyUrl: 'https://boards.greenhouse.io/multico0/jobs/111' });
    const b = mk('mc-b', { company: 'BoardCo1', url: 'https://boards.greenhouse.io/multico1/jobs/222', applyUrl: 'https://boards.greenhouse.io/multico1/jobs/222' });
    const spy = vi.spyOn(providerModule, 'fetchBoard').mockImplementation(async (_source, _platform, _companyName, careerUrl) => {
      if (careerUrl.includes('multico0')) return [a];
      if (careerUrl.includes('multico1')) return [b];
      return [];
    });

    await runWithUser(USER, async () => {
      saveNewJobs([a, b]);
    });

    const stats = await watchOnce();
    expect(spy).toHaveBeenCalled();
    expect(stats.boardsChecked).toBe(2);
    expect(stats.errors).toEqual([]);
    // Regression: platform-wide scoping would put the OTHER company's job in
    // `missing` on the first real cycle and deactivate it.
    expect(stats.missing).toBe(0);

    await runWithUser(USER, async () => {
      const jobs = getAllJobs();
      expect(jobs.map((j: any) => j.id).sort()).toEqual(['mc-a', 'mc-b']);
      expect((jobs.find((j: any) => j.id === 'mc-a') as any).isActive).not.toBe(false);
      expect((jobs.find((j: any) => j.id === 'mc-b') as any).isActive).not.toBe(false);
    });
  });

  it('cap guard: a full-slice fetch (25 jobs = the cap) never marks stored board jobs missing', async () => {
    const db = getDb();
    // Only this test's board is active — deterministic cycle.
    db.prepare('UPDATE company_career_sites SET isActive = 0').run();
    db.prepare('DELETE FROM jobs').run(); // hermetic per-user state (temp DB)
    seedBoards(1, 'cap'); // capco0 (BoardCo0)
    // Stored job belongs to the board (hostname + path) but is NOT part of the
    // 25-job fetch — without the cap guard its absence would be read as
    // "removed from the board" and it would be deactivated.
    const stored = mk('cap-stored', {
      company: 'BoardCo0',
      url: 'https://boards.greenhouse.io/capco0/jobs/999',
      applyUrl: 'https://boards.greenhouse.io/capco0/jobs/999',
    });
    // fetchBoard slices at MAX_JOBS_PER_BOARD (25), so 25 fresh jobs means the
    // board may have MORE live jobs than were fetched — absence is
    // untrustworthy and must not drive the missing diff.
    const fresh = Array.from({ length: 25 }, (_, i) => mk(`cap-${i}`, {
      company: 'BoardCo0',
      url: `https://boards.greenhouse.io/capco0/jobs/${i}`,
      applyUrl: `https://boards.greenhouse.io/capco0/jobs/${i}`,
    }));
    const spy = vi.spyOn(providerModule, 'fetchBoard').mockImplementation(async (_source, _platform, _companyName, careerUrl) => {
      if (careerUrl.includes('capco0')) return fresh;
      return [];
    });

    await runWithUser(USER, async () => {
      saveNewJobs([stored]);
    });

    const stats = await watchOnce();
    expect(spy).toHaveBeenCalled();
    expect(stats.boardsChecked).toBe(1);
    expect(stats.errors).toEqual([]);
    expect(stats.missing).toBe(0); // cap guard clears the false-missing set
    expect(stats.added).toBeGreaterThanOrEqual(25); // the 25 fetched jobs are new

    await runWithUser(USER, async () => {
      const jobs = getAllJobs();
      expect(jobs.map((j: any) => j.id).sort()).toContain('cap-stored');
      expect((jobs.find((j: any) => j.id === 'cap-stored') as any).isActive).toBe(true);
    });
  });

  it('company fallback: stored job with a non-matching URL but the board\u2019s company name stays active', async () => {
    const db = getDb();
    // Only this test's board is active — deterministic cycle.
    db.prepare('UPDATE company_career_sites SET isActive = 0').run();
    db.prepare('DELETE FROM jobs').run(); // hermetic per-user state (temp DB)
    seedBoards(1, 'cmp'); // cmpco0 (BoardCo0)
    // Stored with a URL that does NOT extend the board's identity (hostname +
    // pathname) — only the company name ties this job to the refreshed board.
    const stored = mk('cmp-stored', {
      company: 'BoardCo0',
      url: 'https://jobs.example.org/redirect/777',
      applyUrl: 'https://jobs.example.org/redirect/777',
    });
    // The board's live set carries the same job id under the canonical board
    // URL (the stored record itself is not returned as stored): the diff
    // matches on id, so the fallback-matched stored job is bumped, never
    // reported missing and never re-added.
    const fresh = mk('cmp-stored', {
      company: 'BoardCo0',
      url: 'https://boards.greenhouse.io/cmpco0/jobs/777',
      applyUrl: 'https://boards.greenhouse.io/cmpco0/jobs/777',
    });
    const spy = vi.spyOn(providerModule, 'fetchBoard').mockImplementation(async (_source, _platform, _companyName, careerUrl) => {
      if (careerUrl.includes('cmpco0')) return [fresh];
      return [];
    });

    await runWithUser(USER, async () => {
      saveNewJobs([stored]);
    });

    const stats = await watchOnce();
    expect(spy).toHaveBeenCalled();
    expect(stats.boardsChecked).toBe(1);
    expect(stats.errors).toEqual([]);
    expect(stats.missing).toBe(0); // company fallback keeps it in `existing` → bumped, not missing
    expect(stats.updated).toBeGreaterThanOrEqual(1); // fallback match → bumped

    await runWithUser(USER, async () => {
      const jobs = getAllJobs();
      expect((jobs.find((j: any) => j.id === 'cmp-stored') as any).isActive).toBe(true);
    });
  });

  it('startWatcher returns a stop handle and stops without throwing', async () => {
    vi.spyOn(providerModule, 'fetchBoard').mockResolvedValue([] as any);
    const w = startWatcher(50);
    expect(typeof w.stop).toBe('function');
    await new Promise((r) => setTimeout(r, 120));
    w.stop();
    expect(isSearchInFlight()).toBe(false);
  });
});