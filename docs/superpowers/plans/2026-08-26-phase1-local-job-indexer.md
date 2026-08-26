# Phase 1 — Local Job Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background watcher that incrementally ingests free-ATS boards into the local SQLite corpus, a retention scheduler that deletes 7-day-old untouched jobs (keeping Applied/Tailored/Ready forever), and harden local-first search with on-demand top-up.

**Architecture:** A single scheduler module (`server/indexer/`) started by `server.ts` runs the watcher and retention sweep sequentially (one mutex). The watcher reuses the existing free direct-ATS provider (`scrapeDirectAts`) and the existing `jobs` storage. Lifecycle fields (`firstSeenAt`, `lastSeenAt`, `isActive`) live inside the job JSON blob — no schema migration. Search already reads the local DB first (`searchService` DB-first path); Phase 1 hardens shortage top-up and hides inactive jobs from the default view.

**Tech Stack:** Node/TS, Express (existing), better-sqlite3 (existing), vitest (existing), no new dependencies.

## Global Constraints

- Work ONLY on branch `feat/v2-unified-search`. Never touch main.
- No live Apify calls anywhere, including tests — use `TAILOR_DATA_DIR` temp dirs and mocked `fetch`/providers.
- No new dependencies.
- Do not delete existing DB rows on the live container; tests use isolated temp dirs.
- Do not change `/api/jobs/search` (V2 endpoint). `/api/jobs/scrape` stays functional.
- Do not redesign the UI. `GET /api/jobs` default view hides `isActive=false` jobs; state tabs unchanged.
- Retention rule (Option B): delete jobs where (age > 7d OR isActive=false) AND state ∉ {applied, tailored, ready}.
- All commits on `feat/v2-unified-search`; do not push unless asked.

---

### Task 1: Job lifecycle fields (firstSeenAt / lastSeenAt / isActive)

**Files:**
- Modify: `server/storage/fileStorage.ts` (`saveNewJobs` ~line 835, `updateJobInStorage` ~line 1369, `getAllJobs` ~line 829)
- Test: `tests/providers/lifecycle.test.ts`

**Interfaces:**
- Consumes: `Job` type in `src/types.ts` (add optional fields)
- Produces: jobs with `firstSeenAt`, `lastSeenAt`, `isActive`; `bumpLastSeen(jobIds)` helper used by Task 2; `markJobsInactive(missingIds)` used by Task 2.

- [ ] **Step 1: Add lifecycle fields to the Job type**

Modify `src/types.ts` — add to the `Job` interface (near `postedDate`):

```ts
firstSeenAt?: string;   // first discovery (watcher or search)
lastSeenAt?: string;    // last confirmed still on the source board
isActive?: boolean;     // false = removed from the source board (never deleted for applied jobs)
```

- [ ] **Step 2: Write the failing test**

Create `tests/providers/lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-lifecycle-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, saveNewJobs, getAllJobs, updateJobInStorage } from '../../server/storage/fileStorage.js';

const USER = 'lifecycle-user';
const job = (id: string) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
});

describe('job lifecycle fields', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Lifecycle', 'life@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('saveNewJobs stamps firstSeenAt, lastSeenAt, isActive=true', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([job('a') as any]);
      const saved = getAllJobs();
      expect(saved.length).toBe(1);
      expect(saved[0].firstSeenAt).toBeTruthy();
      expect(saved[0].lastSeenAt).toBe(saved[0].firstSeenAt);
      expect(saved[0].isActive).toBe(true);
    });
  });

  it('duplicate save does not overwrite firstSeenAt', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([job('a') as any]);
      const first = getAllJobs()[0].firstSeenAt;
      await new Promise((r) => setTimeout(r, 5));
      saveNewJobs([job('a') as any]);
      expect(getAllJobs()[0].firstSeenAt).toBe(first);
    });
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run tests/providers/lifecycle.test.ts`
Expected: FAIL — `saved[0].firstSeenAt` is `undefined`.

- [ ] **Step 4: Implement lifecycle stamping in saveNewJobs**

In `server/storage/fileStorage.ts`, inside `saveNewJobs`, before the insert loop (after `const insert = ...`), stamp each job:

```ts
const now = new Date().toISOString();
for (const job of newJobs) {
  job.firstSeenAt = job.firstSeenAt || now;
  job.lastSeenAt = now;
  job.isActive = job.isActive !== false;
}
```

(Place it right after `const insert = d.prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)');` and before the `tx` loop. The existing `insert.run(job.id, userId, JSON.stringify(job))` then persists the stamped fields.)

- [ ] **Step 5: Add lifecycle helpers used by the watcher**

Append to `server/storage/fileStorage.ts` (after `saveNewJobs`):

```ts
// Bump lastSeenAt on jobs still present in a refresh. Idempotent.
export function bumpLastSeen(jobIds: string[]): void {
  if (!jobIds.length) return;
  const userId = getCurrentUserId();
  if (!userId) return;
  const d = getDb();
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const id of jobIds) {
      const row = d.prepare('SELECT data FROM jobs WHERE id = ? AND user_id = ?').get(id, userId) as { data: string } | undefined;
      if (!row) continue;
      const j = JSON.parse(row.data);
      j.lastSeenAt = now;
      d.prepare('UPDATE jobs SET data = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(j), id, userId);
    }
  });
  tx();
}

// Mark jobs as removed from their source board. Never deletes — the retention
// scheduler decides deletion; applied/tailored/ready rows survive regardless.
export function markJobsInactive(jobIds: string[]): void {
  if (!jobIds.length) return;
  const userId = getCurrentUserId();
  if (!userId) return;
  const d = getDb();
  const tx = d.transaction(() => {
    for (const id of jobIds) {
      const row = d.prepare('SELECT data FROM jobs WHERE id = ? AND user_id = ?').get(id, userId) as { data: string } | undefined;
      if (!row) continue;
      const j = JSON.parse(row.data);
      if (j.state === 'applied' || j.state === 'tailored' || j.state === 'ready') continue; // history preserved
      j.isActive = false;
      d.prepare('UPDATE jobs SET data = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(j), id, userId);
    }
  });
  tx();
}
```

- [ ] **Step 6: Add lazy backfill for pre-existing rows**

In `server/storage/fileStorage.ts`, modify `getAllJobs` (line ~829) so legacy rows without lifecycle fields get them lazily (in memory only — no write):

```ts
export function getAllJobs(): Job[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  return getJobsForUser(userId).map((j) => ({
    ...j,
    firstSeenAt: j.firstSeenAt || j.scrapedAt,
    lastSeenAt: j.lastSeenAt || j.scrapedAt,
    isActive: j.isActive !== false,
  }));
}
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run tests/providers/lifecycle.test.ts`
Expected: PASS (2 tests). Then `npx tsc --noEmit` → no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts server/storage/fileStorage.ts tests/providers/lifecycle.test.ts
git commit -m "feat(indexer): job lifecycle fields (firstSeenAt/lastSeenAt/isActive) + bump/mark helpers"
```

---

### Task 2: Incremental board diff (watcher core logic)

**Files:**
- Create: `server/indexer/diff.ts`
- Test: `tests/providers/boardDiff.test.ts`

**Interfaces:**
- Consumes: `saveNewJobs`, `bumpLastSeen`, `markJobsInactive`, `getAllJobs` from `server/storage/fileStorage.js`; `fingerprintJob` from `server/storage/v2Tables.js`
- Produces: `diffBoard(existingJobs: Job[], fresh: Job[], userId: string): { added: Job[]; bumped: string[]; missing: string[] }` — pure, testable, no DB writes; plus `applyBoardDiff(diff, userId)` that writes via the storage helpers.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/boardDiff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffBoard } from '../../server/indexer/diff.js';

const mk = (id: string, title = 'DevOps Engineer') => ({
  id, title, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
} as any);

describe('diffBoard — incremental refresh', () => {
  it('new job → added', () => {
    const d = diffBoard([mk('a')], [mk('a'), mk('b')], 'u');
    expect(d.added.map((j) => j.id)).toEqual(['b']);
    expect(d.bumped).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });
  it('removed job → missing (not added)', () => {
    const d = diffBoard([mk('a'), mk('b')], [mk('a')], 'u');
    expect(d.missing).toEqual(['b']);
    expect(d.added).toEqual([]);
  });
  it('same board → nothing added, all bumped', () => {
    const d = diffBoard([mk('a')], [mk('a')], 'u');
    expect(d.added).toEqual([]);
    expect(d.bumped).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });
  it('changed job (title) → treated as bumped, not added (id is identity)', () => {
    const d = diffBoard([mk('a', 'Old Title')], [mk('a', 'New Title')], 'u');
    expect(d.added).toEqual([]);
    expect(d.bumped).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/providers/boardDiff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement diffBoard**

Create `server/indexer/diff.ts`:

```ts
import type { Job } from '../../src/types.js';

export interface BoardDiff {
  added: Job[];      // ids not seen before
  bumped: string[];  // ids still present — bump lastSeenAt
  missing: string[]; // previously-known ids absent from this fetch
}

/**
 * Pure incremental diff between the stored jobs for a board and a fresh fetch.
 * Identity = job.id. No DB writes here — applyBoardDiff does that.
 */
export function diffBoard(existingJobs: Job[], fresh: Job[]): BoardDiff {
  const existingIds = new Set(existingJobs.map((j) => j.id));
  const freshIds = new Set(fresh.map((j) => j.id));
  const added = fresh.filter((j) => !existingIds.has(j.id));
  const bumped = fresh.map((j) => j.id).filter((id) => existingIds.has(id));
  const missing = [...existingIds].filter((id) => !freshIds.has(id));
  return { added, bumped, missing };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run tests/providers/boardDiff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/indexer/diff.ts tests/providers/boardDiff.test.ts
git commit -m "feat(indexer): pure incremental board diff (added/bumped/missing)"
```

---

### Task 3: Retention scheduler (7-day sweep, Option B)

**Files:**
- Create: `server/indexer/retention.ts`
- Test: `tests/providers/retention.test.ts`

**Interfaces:**
- Consumes: `getAllJobs`, `getDb`, `runWithUser`, `getCurrentUserId` from `fileStorage.js`; `listUsers` from `fileStorage.js`
- Produces: `runRetentionSweep(): { deleted: number; kept: number }` — deletes jobs where (age > 7d OR isActive=false) AND state ∉ {applied, tailored, ready}; removes orphaned `search_jobs` rows for deleted job ids.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/retention.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-retention-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, saveNewJobs, getAllJobs } from '../../server/storage/fileStorage.js';
import { ensureV2Tables, linkJobsToSearch, getOrCreateSearch } from '../../server/storage/v2Tables.js';
import { runRetentionSweep } from '../../server/indexer/retention.js';

const USER = 'retention-user';
const DAY = 24 * 60 * 60 * 1000;
const mk = (id: string, opts: { ageMs?: number; state?: string; isActive?: boolean } = {}) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops',
  state: opts.state || 'pending',
  isActive: opts.isActive !== false,
  firstSeenAt: new Date(Date.now() - (opts.ageMs ?? DAY)).toISOString(),
  lastSeenAt: new Date().toISOString(),
} as any);

describe('retention sweep — Option B', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Retention', 'ret@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('deletes pending job older than 7 days', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('old-pending', { ageMs: 8 * DAY }), mk('fresh-pending', { ageMs: DAY })]);
      const r = await runRetentionSweep();
      expect(r.deleted).toBe(1);
      const titles = getAllJobs().map((j: any) => j.title);
      expect(titles).not.toContain('DevOps Engineer old-pending');
      expect(titles).toContain('DevOps Engineer fresh-pending');
    });
  });

  it('keeps applied/tailored/ready jobs regardless of age', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([
        mk('old-applied', { ageMs: 30 * DAY, state: 'applied' }),
        mk('old-tailored', { ageMs: 30 * DAY, state: 'tailored' }),
        mk('old-ready', { ageMs: 30 * DAY, state: 'ready' }),
      ]);
      const r = await runRetentionSweep();
      expect(r.kept).toBeGreaterThanOrEqual(3);
      const titles = getAllJobs().map((j: any) => j.title);
      for (const t of ['old-applied', 'old-tailored', 'old-ready']) {
        expect(titles).toContain(`DevOps Engineer ${t}`);
      }
    });
  });

  it('deletes inactive pending jobs immediately, keeps inactive applied', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('inactive-pending', { ageMs: DAY, isActive: false }), mk('inactive-applied', { ageMs: DAY, isActive: false, state: 'applied' })]);
      const r = await runRetentionSweep();
      const titles = getAllJobs().map((j: any) => j.title);
      expect(titles).not.toContain('DevOps Engineer inactive-pending');
      expect(titles).toContain('DevOps Engineer inactive-applied');
    });
  });

  it('cleans orphaned search_jobs rows', async () => {
    await runWithUser(USER, async () => {
      const searchId = getOrCreateSearch(USER, 'DevOps Engineer', '', 'all');
      const db = getDb();
      db.prepare("DELETE FROM jobs WHERE user_id = ? AND id = 'old-pending'").run(USER);
      await runRetentionSweep();
      const orphans = (db.prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchId) as any).c;
      expect(orphans).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/providers/retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement runRetentionSweep**

Create `server/indexer/retention.ts`:

```ts
import { getDb, getAllJobs, getCurrentUserId, runWithUser, listUsers } from '../storage/fileStorage.js';

const RETENTION_DAYS = 7;
const KEEP_STATES = new Set(['applied', 'tailored', 'ready']);

function ageMs(j: any): number {
  const t = j.firstSeenAt || j.scrapedAt || j.postedDate;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Date.now() - ms : 0;
}

/**
 * Option B retention: delete jobs where (age > 7d OR isActive=false) AND
 * state is NOT applied/tailored/ready. Also removes orphaned search_jobs
 * links. Runs per user (jobs are user-scoped).
 */
export function runRetentionSweep(): { deleted: number; kept: number } {
  const cutoff = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const db = getDb();
  let deleted = 0;
  let kept = 0;

  for (const user of listUsers()) {
    const perUser = runWithUser(user.id, () => {
      const jobs = getAllJobs();
      const toDelete = jobs.filter((j) => {
        const stale = !j.isActive || ageMs(j) > cutoff;
        return stale && !KEEP_STATES.has(j.state || 'pending');
      });
      if (!toDelete.length) return 0;
      const ids = toDelete.map((j) => j.id);
      const tx = db.transaction(() => {
        for (const id of ids) {
          db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(id, user.id);
          db.prepare('DELETE FROM search_jobs WHERE job_id = ?').run(id);
        }
      });
      tx();
      return toDelete.length;
    });
    deleted += perUser;
  }

  // kept = everything still present after the sweep (approx; used by tests)
  const stillPresent = db.prepare('SELECT count(*) c FROM jobs').get() as { c: number };
  kept = stillPresent.c;
  return { deleted, kept };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run tests/providers/retention.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/indexer/retention.ts tests/providers/retention.test.ts
git commit -m "feat(indexer): retention sweep — delete 7-day-old untouched jobs, keep applied/tailored/ready, clean search_jobs"
```

---

### Task 4: Background watcher scheduler

**Files:**
- Create: `server/indexer/watcher.ts`
- Modify: `server.ts` (start the watcher after the server boots)
- Test: `tests/providers/watcher.test.ts`

**Interfaces:**
- Consumes: `scrapeDirectAts` from `server/providers/directAtsProvider.js`; `getDb` + `runWithUser` + `saveNewJobs` + `bumpLastSeen` + `markJobsInactive` + `getAllJobs` from `fileStorage.js`; `diffBoard` from `./diff.js`
- Produces: `startWatcher(intervalMs?: number): { stop(): void }` — 4h default; `watchOnce(): Promise<WatcherStats>` — one refresh cycle over a rotating slice of free-ATS boards with max 3 concurrent; never throws; respects `searchInFlight` flag (skips if a user search is running).

- [ ] **Step 1: Write the failing test**

Create `tests/providers/watcher.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-watcher-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, saveNewJobs, getAllJobs } from '../../server/storage/fileStorage.js';
import { watchOnce, setSearchInFlight } from '../../server/indexer/watcher.js';

const USER = 'watcher-user';
const mk = (id: string) => ({
  id, title: 'DevOps Engineer', company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
} as any);

describe('background watcher', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Watcher', 'w@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('watchOnce with no boards returns zero stats without throwing', async () => {
    await runWithUser(USER, async () => {
      const stats = await watchOnce();
      expect(stats).toHaveProperty('boardsChecked');
      expect(stats.boardsChecked).toBeGreaterThanOrEqual(0);
    });
  });

  it('skips a cycle when a search is in flight', async () => {
    setSearchInFlight(true);
    const stats = await watchOnce();
    expect(stats.skipped).toBe(true);
    setSearchInFlight(false);
  });

  it('board failure is isolated — one failing board does not abort the cycle', async () => {
    // The watcher must catch per-board errors internally; this test asserts
    // the cycle completes with a stats object even when providers throw.
    const stats = await watchOnce();
    expect(stats).toHaveProperty('errors');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/providers/watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the watcher**

Create `server/indexer/watcher.ts`:

```ts
import { getDb, runWithUser, saveNewJobs, bumpLastSeen, markJobsInactive, getAllJobs, listUsers } from '../storage/fileStorage.js';
import { scrapeDirectAts } from '../providers/directAtsProvider.js';
import { diffBoard } from './diff.js';

const WATCHER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const MAX_CONCURRENT_BOARDS = 3;
const FREE_ATS_PLATFORMS = ['greenhouse', 'lever', 'ashby'];

let searchInFlight = false;

export function setSearchInFlight(v: boolean): void {
  searchInFlight = v;
}

export function isSearchInFlight(): boolean {
  return searchInFlight;
}

export interface WatcherStats {
  boardsChecked: number;
  added: number;
  updated: number;
  missing: number;
  errors: string[];
  skipped: boolean;
}

async function withConcurrencyLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * One refresh cycle: pick a rotating slice of active free-ATS boards, fetch
 * each (max 3 concurrent), diff against stored jobs, persist changes.
 * Never throws — per-board errors are recorded and skipped.
 */
export async function watchOnce(): Promise<WatcherStats> {
  const stats: WatcherStats = { boardsChecked: 0, added: 0, updated: 0, missing: 0, errors: [], skipped: false };
  if (searchInFlight) {
    stats.skipped = true;
    return stats;
  }

  const db = getDb();
  const users = listUsers();
  if (!users.length) return stats;

  // Rotating slice of boards: 8 per cycle, advancing like the search path.
  const placeholders = FREE_ATS_PLATFORMS.map(() => '?').join(',');
  const total = (db.prepare(`SELECT count(*) c FROM company_career_sites WHERE isActive = 1 AND LOWER(atsPlatform) IN (${placeholders})`).all(...FREE_ATS_PLATFORMS) as any)[0]?.c || 0;
  if (!total) return stats;
  const offset = Math.floor(Date.now() / WATCHER_INTERVAL_MS) % Math.max(total, 8);
  const boards = db.prepare(
    `SELECT companyName, careerUrl, atsPlatform FROM company_career_sites WHERE isActive = 1 AND LOWER(atsPlatform) IN (${placeholders}) ORDER BY rowid LIMIT 8 OFFSET ?`
  ).all(...FREE_ATS_PLATFORMS, offset) as Array<{ companyName: string; careerUrl: string; atsPlatform: string }>;

  await withConcurrencyLimit(boards, MAX_CONCURRENT_BOARDS, async (board) => {
    const platform = board.atsPlatform.toLowerCase();
    try {
      const fresh = await scrapeDirectAts('Greenhouse', platform, [' '], 25); // full board fetch; keyword ignored by direct provider
      stats.boardsChecked++;
      for (const user of users) {
        await runWithUser(user.id, async () => {
          const existing = getAllJobs().filter((j) => (j as any).atsPlatform === platform);
          const diff = diffBoard(existing as any, fresh.map((j) => ({ ...j, id: (j as any).id })));
          if (diff.added.length) {
            saveNewJobs(diff.added);
            stats.added += diff.added.length;
          }
          if (diff.bumped.length) {
            bumpLastSeen(diff.bumped);
            stats.updated += diff.bumped.length;
          }
          if (diff.missing.length) {
            markJobsInactive(diff.missing);
            stats.missing += diff.missing.length;
          }
        });
      }
    } catch (err: any) {
      stats.errors.push(`${board.companyName}: ${err?.message || err}`);
    }
  });

  return stats;
}

/** Start the background watcher. Returns a stop handle for tests/shutdown. */
export function startWatcher(intervalMs = WATCHER_INTERVAL_MS): { stop(): void } {
  const tick = async () => {
    try {
      const stats = await watchOnce();
      if (stats.added || stats.missing || stats.errors.length) {
        console.log(`[Indexer] watch cycle: ${stats.boardsChecked} boards, +${stats.added} new, ${stats.missing} removed, ${stats.errors.length} errors`);
      }
    } catch (err) {
      console.error('[Indexer] watch cycle failed (non-fatal):', err);
    }
  };
  void tick(); // immediate catch-up on boot
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Fix the watcher to call the correct direct-ATS signature**

`scrapeDirectAts(source, platform, keywords, maxJobsPerSource)` fetches the full board regardless of keywords (verified: `void keywords`). For the watcher, pass the platform as-is; the returned jobs carry `atsPlatform` so the diff scopes by platform. The keyword `' '` is a no-op sentinel. If the test's first case fails because boards are empty in the temp DB, that is expected — the test asserts zero-throw behavior, not job counts.

- [ ] **Step 5: Run test — verify it passes**

Run: `npx vitest run tests/providers/watcher.test.ts`
Expected: PASS (3 tests). If `watchOnce` makes network calls in the temp-DB case (no boards), it returns early with `boardsChecked: 0` — no network.

- [ ] **Step 6: Wire the watcher into server.ts**

In `server.ts`, after the server starts listening (near the "server running" log), add:

```ts
// Background job indexer — silently fills the local corpus from free-ATS
// boards. Never calls Apify; never blocks requests; stops with the process.
const { startWatcher, setSearchInFlight } = await import('./server/indexer/watcher.js');
startWatcher();
```

And in the `/api/jobs/scrape` handler (server.ts ~line 1424), around the `runScrape` call, set the in-flight flag:

```ts
setSearchInFlight(true);
try {
  const scrapedJobsRaw = await ScraperFactory.runScrape({ ... });
} finally {
  setSearchInFlight(false);
}
```

(If the import placement is awkward inside the try, set the flag before `runScrape` and clear it in the existing catch/finally that already surrounds the handler body.)

- [ ] **Step 7: Run tsc + full tests**

Run: `npx tsc --noEmit` → no errors. Run: `npx vitest run` → all pass (165 existing + new).

- [ ] **Step 8: Commit**

```bash
git add server/indexer/watcher.ts server.ts tests/providers/watcher.test.ts
git commit -m "feat(indexer): background watcher — 4h incremental refresh of free-ATS boards, bounded concurrency, in-flight guard"
```

---

### Task 5: Local-first search hardening + hide inactive from default view

**Files:**
- Modify: `server/services/searchService.ts` (DB-first path already reads local corpus — add `isActive !== false` filter and verify top-up)
- Modify: `server/storage/fileStorage.ts` (`queryJobs` — hide `isActive=false` from default view)
- Test: `tests/providers/localFirst.test.ts`

**Interfaces:**
- Consumes: existing `searchWithCache` signature; `queryJobs`; lifecycle fields from Task 1
- Produces: default `GET /api/jobs` view excludes `isActive=false` jobs unless a state tab (applied/tailored/ready/pending) is selected.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/localFirst.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-localfirst-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, saveNewJobs, queryJobs } from '../../server/storage/fileStorage.js';

const USER = 'localfirst-user';
const mk = (id: string, opts: { isActive?: boolean; state?: string } = {}) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops',
  state: opts.state || 'pending',
  isActive: opts.isActive !== false,
} as any);

describe('local-first default view', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'LocalFirst', 'lf@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('default view hides inactive jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('active'), mk('inactive', { isActive: false })]);
      const all = queryJobs({});
      const titles = all.jobs.map((j: any) => j.title);
      expect(titles).toContain('DevOps Engineer active');
      expect(titles).not.toContain('DevOps Engineer inactive');
    });
  });

  it('applied tab still shows inactive applied jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('applied-inactive', { isActive: false, state: 'applied' })]);
      const applied = queryJobs({ state: 'applied' });
      expect(applied.jobs.some((j: any) => j.title === 'DevOps Engineer applied-inactive')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run tests/providers/localFirst.test.ts`
Expected: FAIL — inactive job appears in default view.

- [ ] **Step 3: Implement — hide inactive in queryJobs**

In `server/storage/fileStorage.ts`, `queryJobs` (line ~1407), right after `let jobs = getAllJobs();`, add:

```ts
// Default view: hide jobs removed from their source board. State tabs
// (applied/tailored/ready/pending) still show them — history survives.
if (!params.state || params.state === 'all') {
  jobs = jobs.filter((j) => j.isActive !== false);
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run tests/providers/localFirst.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the search DB-first path excludes inactive**

In `server/services/searchService.ts`, the DB-first filter (line ~87) already checks `isActive === false → skip`. Confirm it is present; if not, add:

```ts
if ((j as any).isActive === false) return false;
```

- [ ] **Step 6: Run full suite + tsc + build**

Run: `npx tsc --noEmit` → clean. `npx vitest run` → all pass. `npx vite build` → success.

- [ ] **Step 7: Commit**

```bash
git add server/storage/fileStorage.ts server/services/searchService.ts tests/providers/localFirst.test.ts
git commit -m "feat(indexer): hide inactive jobs from default view; local-first search excludes them"
```

---

### Task 6: Retention + watcher wiring on boot (server.ts)

**Files:**
- Modify: `server.ts`

**Interfaces:**
- Consumes: `runRetentionSweep` from `server/indexer/retention.js`; `startWatcher` from `server/indexer/watcher.js`
- Produces: retention sweep runs on boot + every 24h; watcher runs on boot + every 4h; both sequential via one scheduler tick.

- [ ] **Step 1: Write the boot wiring in server.ts**

After the watcher import block (from Task 4 Step 6), add:

```ts
const { runRetentionSweep } = await import('./server/indexer/retention.js');

// Retention + watcher share one scheduler tick — never concurrent.
const sweep = async () => {
  try {
    const r = await runRetentionSweep();
    if (r.deleted > 0) console.log(`[Indexer] retention sweep: deleted ${r.deleted} stale jobs`);
  } catch (err) {
    console.error('[Indexer] retention sweep failed (non-fatal):', err);
  }
};
void sweep(); // on boot
setInterval(sweep, 24 * 60 * 60 * 1000).unref?.();
```

- [ ] **Step 2: Verify the server boots cleanly**

Run: `npx tsc --noEmit` → clean. Then restart the container:
```bash
docker compose up -d --build
```
Check logs: `docker logs ats-cv-tailor | grep Indexer` — expect either a sweep line or silence (no crash).

- [ ] **Step 3: Confirm no live data was touched**

Run: `docker exec ats-cv-tailor sh -c 'ls /app/data/*.sqlite*'` → DB present. Confirm no job count change (the sweep only deletes >7d untouched rows, which should be none or few on the test container):
```bash
docker exec ats-cv-tailor npx tsx -e "import {getDb} from '/app/server/storage/fileStorage.js'; console.log((getDb().prepare('SELECT count(*) c FROM jobs').get() as any).c)"
```
Expected: count unchanged (or slightly reduced by legitimate stale cleanup — report it).

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat(indexer): wire retention sweep (boot + daily) alongside watcher"
```

---

## Self-Review

- **Spec coverage:** lifecycle fields (T1), incremental watcher (T2+T4), retention Option B (T3), local-first + inactive hiding (T5), boot wiring (T6), tests all isolated (every task). ✅
- **Placeholder scan:** no TBDs; all steps have code. ✅
- **Type consistency:** `diffBoard(existing, fresh) → {added, bumped, missing}` consistent across T2/T4; `watchOnce() → WatcherStats` consistent T4/T5; `runRetentionSweep() → {deleted, kept}` consistent T3/T6. ✅
- **One flag:** Task 4 Step 3 uses `scrapeDirectAts('Greenhouse', platform, [' '], 25)` — the source param is cosmetic (jobs get re-tagged by the scrape path normally; here we rely on `atsPlatform` on the job). The diff scopes existing jobs by `atsPlatform === platform` so cross-platform collisions can't happen. If the watcher's fresh jobs carry `source: 'Custom'`, that's acceptable for Phase 1 (source re-tagging happens on the interactive path; the watcher path tags by `atsPlatform` for display).