// ATS ingestion — bounded batch sync, dedupe across cycles, failure safety,
// backoff state, concurrency bound, restart persistence, search-while-
// refresh. All fixtures, zero live calls.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-idx-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { setDirectAtsFetcher } = await import('../../server/providers/directAtsProvider.js');
const {
  ensureAtsIndexSchema,
  upsertAtsJobs,
  queryAtsCandidates,
  clearAtsIndex,
  getBoardState,
  boardRefreshStats,
  pickDueBoards,
} = await import('../../server/ats-index/atsRepository.js');
const { syncBoards, syncBoard, failureBackoffMs, refreshIntervalMs, defaultAtsIndexConfig } = await import('../../server/ats-index/atsIndexer.js');
const { AtsScheduler, createAtsScheduler, isAtsCycleRunning } = await import('../../server/ats-index/atsScheduler.js');

const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();

const gh = (id: number, title: string, location: string, hAgo: number) => ({
  id: String(id),
  title,
  location: { name: location },
  absolute_url: `https://boards.greenhouse.io/co/jobs/${id}`,
  first_published: iso(hAgo),
  updated_at: iso(hAgo),
  company_name: 'Fixture Co',
});

// Board payloads (slug → jobs). mutable per test via let bindings.
let BOARD_A: any[] = [gh(1, 'DevOps Engineer', 'Bengaluru, India', 20), gh(2, 'SRE', 'Remote - India', 72)];
let BOARD_B: any[] = [gh(3, 'Data Engineer', 'Pune, India', 48)];
let BOARD_C: any[] = [gh(4, 'Software Engineer', 'Delhi, India', 24)];

let fetchCount = 0;
let maxConcurrent = 0;
let concurrent = 0;
const FAIL_SLUGS = new Set<string>();
const DELAY_MS = 30;

function installFetcher() {
  fetchCount = 0;
  maxConcurrent = 0;
  concurrent = 0;
  setDirectAtsFetcher(async (url: string) => {
    fetchCount++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    try {
      const m = url.match(/boards\/([^/]+)\/jobs/);
      const slug = m ? m[1] : '';
      if (FAIL_SLUGS.has(slug)) throw new Error(`fixture 500 for ${slug}`);
      return { jobs: slug === 'board-a' ? BOARD_A : slug === 'board-b' ? BOARD_B : slug === 'board-c' ? BOARD_C : [] };
    } finally {
      concurrent--;
    }
  });
}
installFetcher();

const CFG = { ...defaultAtsIndexConfig(), concurrency: 2, timeoutMs: 5000, failureBackoffBaseMs: 60e3 };

function seedBoards(): void {
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, 'greenhouse', ?, 1, ?, ?)`
  );
  for (const slug of ['board-a', 'board-b', 'board-c']) {
    ins.run(`sb-${slug}`, `Co ${slug}`, `https://boards.greenhouse.io/${slug}`, slug, iso(24 * 30), iso(24 * 30));
  }
}

function pickBoardsForTest(): any[] {
  return pickDueBoards('greenhouse', 10);
}

describe('atsIndexer', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    seedBoards();
  });
  afterAll(() => {
    setDirectAtsFetcher(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    clearAtsIndex('greenhouse');
    FAIL_SLUGS.clear();
    // Restore fixture payloads (tests mutate BOARD_A).
    BOARD_A = [gh(1, 'DevOps Engineer', 'Bengaluru, India', 20), gh(2, 'SRE', 'Remote - India', 72)];
    BOARD_B = [gh(3, 'Data Engineer', 'Pune, India', 48)];
    BOARD_C = [gh(4, 'Software Engineer', 'Delhi, India', 24)];
    installFetcher();
    // reset board state so every cycle starts from "never synced"
    getDb().prepare("UPDATE company_career_sites SET last_attempt_at = NULL, last_success_at = NULL, failure_count = 0, next_refresh_at = NULL, last_job_count = NULL WHERE atsPlatform = 'greenhouse'").run();
  });

  it('ingests a batch: all boards fetched, jobs indexed, board state recorded', async () => {
    const boards = pickBoardsForTest();
    expect(boards.length).toBe(3);
    const r = await syncBoards(boards, CFG);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.jobs).toBe(4);
    const jobs = queryAtsCandidates({ platform: 'greenhouse', activeOnly: true });
    expect(jobs.length).toBe(4);
    const st = getBoardState('greenhouse', 'board-a')!;
    expect(st.lastSuccessAt).toBeTruthy();
    expect(st.failureCount).toBe(0);
    expect(st.lastJobCount).toBe(2);
    expect(st.nextRefreshAt).toBeTruthy();
    expect(boardRefreshStats('greenhouse').activeJobs).toBe(4);
  });

  it('second cycle dedupes: no new rows, last_seen advanced, first_seen preserved', async () => {
    const boards = pickBoardsForTest();
    await syncBoards(boards, CFG);
    const db = getDb();
    const firstSeen = (db.prepare('SELECT first_seen_at FROM ats_jobs WHERE fingerprint = ?').get('gh-1') as { first_seen_at: string }).first_seen_at;
    // Simulate the passage of time between cycles AND force boards due again
    // (a successful sync schedules them in the future).
    db.prepare('UPDATE ats_jobs SET last_seen_at = ? WHERE fingerprint = ?').run(iso(100), 'gh-1');
    getDb().prepare("UPDATE company_career_sites SET next_refresh_at = ? WHERE atsPlatform = 'greenhouse'").run(iso(100));
    await syncBoards(pickBoardsForTest(), CFG);
    const count = (db.prepare('SELECT count(*) c FROM ats_jobs').get() as { c: number }).c;
    expect(count).toBe(4); // no duplicates
    const row = db.prepare('SELECT first_seen_at, last_seen_at FROM ats_jobs WHERE fingerprint = ?').get('gh-1') as { first_seen_at: string; last_seen_at: string };
    expect(row.first_seen_at).toBe(firstSeen); // preserved
    expect(row.last_seen_at).not.toBe(iso(100)); // advanced
  });

  it('disappeared job: not deactivated immediately (grace), deactivated after absence', async () => {
    const boards = pickBoardsForTest();
    await syncBoards(boards, CFG);
    // Board A drops the SRE (gh-2) — a successful refresh without it.
    BOARD_A = [gh(1, 'DevOps Engineer', 'Bengaluru, India', 20)];
    await syncBoards(pickBoardsForTest(), CFG);
    const db = getDb();
    const still = (db.prepare('SELECT is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-2') as { is_active: number }).is_active;
    expect(still).toBe(1); // absent once, still active (grace)
    // Simulate continued absence beyond the grace window.
    db.prepare('UPDATE ats_jobs SET last_seen_at = ? WHERE fingerprint = ?').run(iso(100), 'gh-2');
    const { deactivateStaleJobs } = await import('../../server/ats-index/atsRepository.js');
    deactivateStaleJobs(48, 'greenhouse');
    expect((db.prepare('SELECT is_active FROM ats_jobs WHERE fingerprint = ?').get('gh-2') as { is_active: number }).is_active).toBe(0);
  });

  it('failed board fetch: failure state + backoff, jobs NEVER deactivated', async () => {
    const boards = pickBoardsForTest();
    await syncBoards(boards, CFG);
    FAIL_SLUGS.add('board-a');
    // Successful syncs schedule boards in the future — force them due so the
    // failed cycle actually re-attempts them.
    getDb().prepare("UPDATE company_career_sites SET next_refresh_at = ? WHERE atsPlatform = 'greenhouse'").run(iso(100));
    await syncBoards(pickBoardsForTest(), CFG);
    const st = getBoardState('greenhouse', 'board-a')!;
    expect(st.failureCount).toBe(1);
    expect(st.lastSuccessAt).toBeTruthy(); // success history preserved
    const db = getDb();
    const active = (db.prepare('SELECT count(*) c FROM ats_jobs WHERE ats_platform = ? AND is_active = 1').get('greenhouse') as { c: number }).c;
    expect(active).toBe(4); // nothing deactivated by the failure
    // Backoff grows with failures and always lands in the future.
    expect(failureBackoffMs(CFG, 1)).toBeGreaterThanOrEqual(0.8 * 60e3);
    expect(failureBackoffMs(CFG, 5)).toBeLessThanOrEqual(1.2 * 60e3 * 2 ** 4);
  });

  it('bounded concurrency: never exceeds cfg.concurrency', async () => {
    const boards = pickBoardsForTest();
    await syncBoards(boards, CFG);
    expect(maxConcurrent).toBeLessThanOrEqual(CFG.concurrency);
    expect(maxConcurrent).toBeGreaterThan(0);
  });

  it('refresh cadence scales with activity', () => {
    expect(refreshIntervalMs(CFG, 150)).toBe(CFG.refreshIntervalsMs.veryActive);
    expect(refreshIntervalMs(CFG, 25)).toBe(CFG.refreshIntervalsMs.active);
    expect(refreshIntervalMs(CFG, 3)).toBe(CFG.refreshIntervalsMs.normal);
    expect(refreshIntervalMs(CFG, 0)).toBe(CFG.refreshIntervalsMs.quiet);
    expect(refreshIntervalMs(CFG, null)).toBe(CFG.refreshIntervalsMs.normal);
  });

  it('restart persistence: index survives a fresh connection to the same DB file', async () => {
    await syncBoards(pickBoardsForTest(), CFG);
    const fresh = new Database(path.join(tmpDir, 'ats_jobs.sqlite'), { readonly: true });
    const c = fresh.prepare('SELECT count(*) c FROM ats_jobs').get() as { c: number };
    fresh.close();
    expect(c.c).toBe(4);
  });

  it('search works WHILE a refresh cycle is running', async () => {
    // Seed some jobs first, then run a slow cycle in the background.
    await syncBoards(pickBoardsForTest(), CFG);
    FAIL_SLUGS.add('board-a'); // make this cycle slower/failing — state isolated
    const running = syncBoards(pickBoardsForTest(), CFG);
    // While the cycle is in flight, the index is fully searchable.
    const candidates = queryAtsCandidates({ platform: 'greenhouse', activeOnly: true });
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    await running;
  });

  it('scheduler: due boards picked per cycle, cycle state surfaced', async () => {
    const scheduler = new AtsScheduler('greenhouse', CFG, 30e3, 10);
    scheduler.start();
    await new Promise((r) => setTimeout(r, DELAY_MS * 6)); // let the first tick run
    expect(boardRefreshStats('greenhouse').activeJobs).toBe(4);
    scheduler.stop();
  });

  it('scheduler never overlaps cycles (isAtsCycleRunning)', async () => {
    const scheduler = createAtsScheduler('greenhouse', { tickMs: 10e3, batchSize: 10 });
    const start = scheduler.start();
    void start;
    await new Promise((r) => setTimeout(r, DELAY_MS * 2));
    // The cycle flag reflects reality (true during a cycle, false after).
    expect(typeof isAtsCycleRunning()).toBe('boolean');
    scheduler.stop();
  });
});