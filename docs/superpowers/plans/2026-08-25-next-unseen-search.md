# Next Unseen Batch Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each search for the same query show the NEXT unseen batch of jobs (newest first), walking the market pool progressively until exhausted, with DB-first $0 hits and budget-bounded provider advances.

**Architecture:** Add `search_seen` (per user+query, marks jobs returned to the user) and `provider_cursors` (per user+query+provider, tracks LinkedIn `start` / next-page position). STEP 1 filters the local DB to unseen fresh jobs; if enough → return $0. STEP 2 advances provider cursors within the global budget (`missing × 1.5`) when unseen runs dry; merge → dedupe → persist → mark seen → return; one bounded top-up; exhaustion message.

**Tech Stack:** TypeScript, Express, better-sqlite3, Vitest (mocked providers — NO live Apify calls).

## Global Constraints

- `POST /api/jobs/scrape` (V1) untouched; `POST /api/jobs/search` is the V2 path.
- Budget: `TOTAL_RAW_BUDGET = ceil(missing × 1.5)`; sum of provider allocations ≤ budget; reserve 15% for top-up; `ATS_MAX_RAW_RESULTS = 50`.
- Seen scope: per (user, query_fp) — same job may appear in different query walks.
- Freshness: `isJobFresh(scrapedAt, ttlHours=24)`; `isActive` must be true.
- No live Apify calls in tests — mock `routeProvider` / providers. Never use a real `APIFY_API_TOKEN` in tests.
- All planning docs are gitignored — never push specs/plans to the public repo.
- Gate after every task: `npx tsc --noEmit && npx vitest run && npx vite build`.

---

### Task 1: `search_seen` + `provider_cursors` tables and helpers

**Files:**
- Modify: `server/storage/v2Tables.ts` (append after `isJobFresh`, line ~143)
- Test: `tests/providers/unseenSearch.test.ts` (create)

**Interfaces:**
- Consumes: `getDb()` from `../storage/fileStorage.js` (existing)
- Produces:
  - `markSeen(userId: string, queryFp: string, fingerprints: string[]): void`
  - `getSeenFingerprints(userId: string, queryFp: string): Set<string>`
  - `getProviderCursor(userId: string, queryFp: string, provider: string): { cursor?: string; fetchedCount: number }`
  - `saveProviderCursor(userId: string, queryFp: string, provider: string, cursor: string | undefined, fetchedCount: number): void`
  - `ensureV2Tables()` already creates both tables (extend it)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureV2Tables, markSeen, getSeenFingerprints, getProviderCursor, saveProviderCursor } from '../../server/storage/v2Tables.js';
import { getDb } from '../../server/storage/fileStorage.js';

beforeEach(() => { ensureV2Tables(); const db = getDb(); db.prepare('DELETE FROM search_seen').run(); db.prepare('DELETE FROM provider_cursors').run(); });

describe('V2 unseen-search storage', () => {
  it('markSeen + getSeenFingerprints round-trips per (user, queryFp)', () => {
    markSeen('u1', 'q1', ['fp-a', 'fp-b']);
    markSeen('u1', 'q2', ['fp-a']);
    expect([...getSeenFingerprints('u1', 'q1')].sort()).toEqual(['fp-a', 'fp-b']);
    expect([...getSeenFingerprints('u1', 'q2')]).toEqual(['fp-a']);
    expect(getSeenFingerprints('u2', 'q1').size).toBe(0); // user isolation
  });

  it('markSeen is idempotent', () => {
    markSeen('u1', 'q1', ['fp-a']);
    markSeen('u1', 'q1', ['fp-a']);
    expect(getSeenFingerprints('u1', 'q1').size).toBe(1);
  });

  it('provider cursor round-trips per (user, queryFp, provider)', () => {
    expect(getProviderCursor('u1', 'q1', 'linkedin')).toEqual({ cursor: undefined, fetchedCount: 0 });
    saveProviderCursor('u1', 'q1', 'linkedin', '25', 25);
    expect(getProviderCursor('u1', 'q1', 'linkedin')).toEqual({ cursor: '25', fetchedCount: 25 });
    expect(getProviderCursor('u1', 'q2', 'linkedin').fetchedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: FAIL — `markSeen is not a function`

- [ ] **Step 3: Add tables to `ensureV2Tables()` and implement helpers**

In `server/storage/v2Tables.ts`, inside `ensureV2Tables()` after the existing `CREATE TABLE provider_runs` block:

```ts
    CREATE TABLE IF NOT EXISTS search_seen (
      user_id TEXT NOT NULL,
      query_fp TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (user_id, query_fp, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS provider_cursors (
      user_id TEXT NOT NULL,
      query_fp TEXT NOT NULL,
      provider TEXT NOT NULL,
      cursor TEXT,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, query_fp, provider)
    );
```

Then append after `isJobFresh` (end of file):

```ts
export function markSeen(userId: string, queryFp: string, fingerprints: string[]): void {
  if (!userId || !queryFp || fingerprints.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO search_seen (user_id, query_fp, fingerprint, seen_at) VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const fp of fingerprints) stmt.run(userId, queryFp, fp, now);
  });
  tx();
}

export function getSeenFingerprints(userId: string, queryFp: string): Set<string> {
  if (!userId || !queryFp) return new Set();
  const db = getDb();
  const rows = db.prepare('SELECT fingerprint FROM search_seen WHERE user_id = ? AND query_fp = ?').all(userId, queryFp) as { fingerprint: string }[];
  return new Set(rows.map((r) => r.fingerprint));
}

export function getProviderCursor(userId: string, queryFp: string, provider: string): { cursor?: string; fetchedCount: number } {
  const db = getDb();
  const row = db.prepare('SELECT cursor, fetched_count FROM provider_cursors WHERE user_id = ? AND query_fp = ? AND provider = ?')
    .get(userId, queryFp, provider) as { cursor: string | null; fetched_count: number } | undefined;
  return { cursor: row?.cursor ?? undefined, fetchedCount: row?.fetched_count ?? 0 };
}

export function saveProviderCursor(userId: string, queryFp: string, provider: string, cursor: string | undefined, fetchedCount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO provider_cursors (user_id, query_fp, provider, cursor, fetched_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, query_fp, provider) DO UPDATE SET cursor = excluded.cursor, fetched_count = excluded.fetched_count, updated_at = excluded.updated_at`
  ).run(userId, queryFp, provider, cursor ?? null, fetchedCount, new Date().toISOString());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run && npx vite build
git add server/storage/v2Tables.ts tests/providers/unseenSearch.test.ts
git commit -m "feat(v2-search): search_seen + provider_cursors tables and helpers"
```

---

### Task 2: STEP 1 — unseen-only DB-first in `searchService.ts`

**Files:**
- Modify: `server/services/searchService.ts` (the `freshJobs` filter at lines 42-55, the cache-hit return at 57-71, and the persist block)
- Test: `tests/providers/unseenSearch.test.ts` (append)

**Interfaces:**
- Consumes: `getSeenFingerprints` (Task 1), `getSearchFingerprint` (existing local fn), `isJobFresh`, `fingerprintJob`
- Produces: `searchWithCache(req, fetchFn)` returns `{ jobs, providersCalled, cacheHit, providerResults, queryFp, seenCount, totalStored }` — later tasks use `queryFp` + `seenCount`

- [ ] **Step 1: Write the failing test (append to the same file)**

```ts
import { searchWithCache } from '../../server/services/searchService.js';
import { markSeen } from '../../server/storage/v2Tables.js';
import { vi, afterEach } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });

describe('searchWithCache — unseen-first', () => {
  const job = (i: number) => ({
    id: `j${i}`, title: 'DevOps Engineer', company: `C${i}`,
    description: 'DevOps engineer role', url: `https://x.com/j${i}`,
    applyUrl: `https://x.com/j${i}`, source: 'Custom', state: 'pending',
    fingerprint: `fp-${i}`, scrapedAt: new Date().toISOString(), isActive: true,
    postedDate: new Date(Date.now() - i * 60000).toISOString(), createdAt: '', updatedAt: '',
  });

  it('returns unseen first: 30 fresh, 10 seen, LIMIT 25 → the unseen 20 + missing top-up', async () => {
    const all = Array.from({ length: 30 }, (_, i) => job(i));
    const { getAllJobs, getCurrentUserId } = await import('../../server/storage/fileStorage.js');
    vi.spyOn({ getAllJobs } as any, 'getAllJobs').mockReturnValue(all);
    // Simulate: user u-seen has already seen fp-0..fp-9 in the default query walk
    markSeen('u-seen', 'devops-engineer|any|24h|any|any', all.slice(0, 10).map(j => j.fingerprint));

    const fetchFn = vi.fn().mockResolvedValue({ jobs: [job(30), job(31)] }); // 2 new
    const result = await searchWithCache(
      { query: 'DevOps Engineer', postedWithin: '24h', limit: 25 },
      fetchFn
    );
    const titles = result.jobs.map((j: any) => j.id);
    expect(titles).not.toContain('j0'); // seen job excluded
    expect(titles).not.toContain('j9');
    expect(result.jobs.length).toBeLessThanOrEqual(25);
  });

  it('cache hit: 25 fresh unseen exist → 0 provider calls, cacheHit true', async () => {
    const all = Array.from({ length: 25 }, (_, i) => job(i));
    const { getAllJobs } = await import('../../server/storage/fileStorage.js');
    vi.spyOn({ getAllJobs } as any, 'getAllJobs').mockReturnValue(all);
    const fetchFn = vi.fn();
    const result = await searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect(result.jobs.length).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: FAIL — first test returns seen jobs (no exclusion yet)

- [ ] **Step 3: Implement unseen filter + mark-seen + cursor in `searchWithCache`**

In `server/services/searchService.ts`:

1. At top imports add: `import { isJobFresh, fingerprintJob, markSeen, getSeenFingerprints } from '../storage/v2Tables.js';` (keep existing imports)

2. Replace the `freshJobs` filter block (lines 42-55) with an unseen-aware version:

```ts
  const allJobs = getAllJobs() as any[];
  const queryFp = getSearchFingerprint(req);
  const seenSet = getSeenFingerprints(getCurrentUserId(), queryFp);
  const freshJobs = allJobs.filter((j) => {
    if ((j as any).isActive === false) return false;
    if (!isJobFresh((j as any).scrapedAt)) return false;
    const fp = (j as any).fingerprint || fingerprintJob(j);
    if (seenSet.has(fp)) return false; // seen in this walk → skip
    const hay = `${j.title} ${j.company} ${j.description || ''}`.toLowerCase();
    const terms = req.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length > 0 && !terms.some((t) => hay.includes(t))) return false;
    return true;
  });
```

3. In the cache-hit return (line 65-70), mark seen before returning and add the new fields:

```ts
    const ranked = [...freshJobs].sort((a, b) => { /* unchanged */ });
    markSeen(getCurrentUserId(), queryFp, ranked.slice(0, req.limit).map((j: any) => (j as any).fingerprint || fingerprintJob(j)));
    return {
      jobs: ranked.slice(0, req.limit),
      providersCalled: [],
      cacheHit: true,
      providerResults: [],
      queryFp,
      seenCount: ranked.length,
      totalStored: allJobs.length,
    };
```

4. In the final return (line ~139), add `queryFp, seenCount: deduped.length, totalStored: allJobs.length` and call `markSeen` with the returned slice's fingerprints before returning.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run && npx vite build
git add server/services/searchService.ts tests/providers/unseenSearch.test.ts
git commit -m "feat(v2-search): unseen-only DB-first + mark-seen on return"
```

---

### Task 3: Provider cursor advance in `providerRouter.ts`

**Files:**
- Modify: `server/services/providerRouter.ts`
- Test: `tests/providers/unseenSearch.test.ts` (append)

**Interfaces:**
- Consumes: `getProviderCursor`, `saveProviderCursor` (Task 1); `SearchRequest`
- Produces: `routeProvider(req, providerId, limit)` unchanged signature, but LinkedIn now reads/writes its cursor (start offset); Santa Maria unchanged (skip-list handled at merge in Task 4)

- [ ] **Step 1: Write the failing test**

```ts
import { routeProvider } from '../../server/services/providerRouter.js';

describe('providerRouter — cursor advance (mocked providers)', () => {
  it('LinkedIn receives start = fetchedCount from the cursor', async () => {
    // Mock the ApifyLinkedInScraper to capture its input.
    const { ApifyLinkedInScraper } = await import('../../server/scraper/apifyScraper.js');
    let captured: any = null;
    vi.spyOn(ApifyLinkedInScraper.prototype, 'scrape').mockImplementation(async function (this: any, params: any) {
      captured = params;
      return [];
    });
    saveProviderCursor('u-c', 'q-c', 'linkedin', '25', 25);
    await routeProvider({ query: 'DevOps', postedWithin: '24h', limit: 25 } as any, 'linkedin', 8);
    expect(captured).not.toBeNull();
    expect(captured.skipJobId ?? captured.start ?? captured.offset).toBeDefined();
    expect(Number(captured.start ?? captured.offset ?? 0)).toBeGreaterThanOrEqual(25);
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: FAIL — captured.start is undefined (no cursor wiring)

- [ ] **Step 3: Implement cursor read/advance**

In `server/services/providerRouter.ts`:

1. Add imports: `import { getProviderCursor, saveProviderCursor } from '../storage/v2Tables.js';` and `import { getCurrentUserId } from '../storage/fileStorage.js';`

2. In the `linkedin` case, before building input:

```ts
      case 'linkedin': {
        const scraper = new ApifyLinkedInScraper();
        const cursor = getProviderCursor(getCurrentUserId(), getSearchFingerprintLocal(req), 'linkedin');
        const jobs = await scraper.scrape({
          keywords: req.query,
          location: req.location,
          datePostedFilter: req.postedWithin || 'all',
          jobType: (req.remote ? 'remote' : undefined) as any,
          maxJobsPerSource: providerLimit,
          skipJobId: undefined, // LinkedIn actor accepts 'start' via this input
          start: cursor.fetchedCount, // page offset = jobs already fetched in this walk
        } as any);
        saveProviderCursor(getCurrentUserId(), getSearchFingerprintLocal(req), 'linkedin', String(cursor.fetchedCount + jobs.length), cursor.fetchedCount + jobs.length);
        return { jobs, requested: providerLimit, returned: jobs.length };
      }
```

3. Add a small local helper at the top of the file (mirror of `getSearchFingerprint` — keep it local, not exported):

```ts
function getSearchFingerprintLocal(req: SearchRequest): string {
  const q = req.query.toLowerCase().trim().replace(/\s+/g, '-');
  const loc = (req.location || 'any').toLowerCase().trim().replace(/\s+/g, '-');
  const posted = req.postedWithin || 'all';
  const remote = req.remote ? 'remote' : 'any';
  const jobType = req.jobType || 'any';
  return `${q}|${loc}|${posted}|${remote}|${jobType}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: PASS

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run && npx vite build
git add server/services/providerRouter.ts tests/providers/unseenSearch.test.ts
git commit -m "feat(v2-search): LinkedIn cursor advance (start = fetchedCount)"
```

---

### Task 4: Merge pipeline — exclude seen, persist, top-up, exhaustion message

**Files:**
- Modify: `server/services/searchService.ts` (progressive loop + persist block)
- Test: `tests/providers/unseenSearch.test.ts` (append)

**Interfaces:**
- Consumes: `markSeen`, `getSeenFingerprints` (Task 1); `routeProvider` cursor (Task 3)
- Produces: final `searchWithCache` response includes `exhausted: boolean`

- [ ] **Step 1: Write the failing test**

```ts
it('exhausted: providers return only seen jobs → exhausted true, no crash', async () => {
  const all = Array.from({ length: 25 }, (_, i) => job(i));
  const { getAllJobs } = await import('../../server/storage/fileStorage.js');
  vi.spyOn({ getAllJobs } as any, 'getAllJobs').mockReturnValue(all);
  markSeen('u-x', 'devops-engineer|any|24h|any|any', all.map(j => j.fingerprint));
  const fetchFn = vi.fn().mockResolvedValue({ jobs: all.slice(0, 5) }); // all already seen
  const result = await searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn);
  expect(result.jobs.length).toBe(0);
  expect((result as any).exhausted).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: FAIL — exhausted is undefined

- [ ] **Step 3: Implement exclusion + top-up + exhausted flag**

In `searchWithCache`:

1. In the progressive loop, after a provider returns, filter out seen fingerprints before adding to `collected`:

```ts
      const unique = jobs.filter((j: any) => {
        const fp = (j as any).fingerprint || fingerprintJob(j);
        if (seenSet.has(fp)) return false;      // seen in this walk
        if (seenFinal.has(fp)) return false;    // already collected
        seenFinal.add(fp);
        return true;
      });
```

(Replace the existing dedupe-only block with this seen-aware version.)

2. After the loop, when still short (`deduped.length < req.limit`), attempt one bounded top-up against the next provider not yet called:

```ts
  if (deduped.length < req.limit && providersCalled.length < providerOrder.length) {
    const next = providerOrder.find((p) => !providersCalled.includes(p));
    if (next) {
      const remaining = req.limit - deduped.length;
      const topUpLimit = Math.min(Math.ceil(remaining * 1.2), budget.maxPerProvider);
      try {
        const { jobs } = await fetchFn(next, topUpLimit);
        const fresh = jobs.filter((j: any) => {
          const fp = (j as any).fingerprint || fingerprintJob(j);
          if (seenSet.has(fp) || seenFinal.has(fp)) return false;
          seenFinal.add(fp);
          return true;
        });
        deduped.push(...fresh);
        providersCalled.push(next);
      } catch { /* top-up failure is non-fatal */ }
    }
  }
```

3. At the final return, compute `exhausted` and mark seen:

```ts
  const returned = ranked.slice(0, req.limit);
  markSeen(getCurrentUserId(), queryFp, returned.map((j: any) => (j as any).fingerprint || fingerprintJob(j)));
  const exhausted = returned.length < req.limit && seenFinal.size >= (allJobs.length + collected.length);
  return {
    jobs: returned,
    providersCalled,
    cacheHit: false,
    providerResults,
    queryFp,
    seenCount: returned.length,
    totalStored: allJobs.length,
    exhausted,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/unseenSearch.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npx vitest run && npx vite build
git add server/services/searchService.ts tests/providers/unseenSearch.test.ts
git commit -m "feat(v2-search): exclude-seen in merge, bounded top-up, exhausted flag"
```

---

### Task 5: Route + UI — "next N unseen" + exhaustion message

**Files:**
- Modify: `server.ts` (V2 search route, ~line 1480), `src/components/ScraperBar.tsx` (result banner), `src/App.tsx` (handleScrape return shape)
- Test: existing `tests/providers/optimizedSearch.test.ts` still passes; no new unit test (UI)

**Interfaces:**
- Consumes: `searchWithCache` response fields `queryFp`, `seenCount`, `totalStored`, `exhausted` (Tasks 2, 4)
- Produces: UI shows "Showing next N unseen · X of ~Y in the last 24h" or the exhaustion message

- [ ] **Step 1: Route — pass through the new fields**

In `server.ts`, in the `POST /api/jobs/search` route, change the response to include the new fields (they're already in the service return — just pass them through):

```ts
      res.json({
        ...result,
        jobs: result.jobs,
        providersCalled: result.providersCalled,
        cacheHit: result.cacheHit,
        exhausted: (result as any).exhausted === true,
        seenCount: (result as any).seenCount ?? 0,
        totalStored: (result as any).totalStored ?? 0,
      });
```

- [ ] **Step 2: App.tsx — surface fields to ScraperBar**

In `handleScrape`, return the new fields (extend the return object):

```ts
        return {
          jobs: data.jobs?.length || 0,
          cacheHit: data.cacheHit === true,
          providersCalled: data.providersCalled || [],
          exhausted: data.exhausted === true,
          seenCount: data.seenCount || 0,
          totalStored: data.totalStored || 0,
        };
```

- [ ] **Step 3: ScraperBar — banner text**

In `src/components/ScraperBar.tsx`, extend `onScrape`'s return type and the success-message logic:

```ts
  onScrape: (params: {...}) => Promise<{ jobs: number; cacheHit: boolean; providersCalled: string[]; exhausted?: boolean; seenCount?: number; totalStored?: number } | void>;
```

Replace the success-message block:

```ts
    if (result && result.jobs > 0) {
      const cacheNote = result.cacheHit ? ' — from cache, 0 credits' : '';
      const providers = result.providersCalled.length > 0 ? ` (${result.providersCalled.join(' + ')})` : '';
      const unseen = result.seenCount && result.totalStored
        ? ` · showing next ${result.seenCount} unseen · ${result.totalStored} stored in the last 24h`
        : '';
      setScrapeSuccessMsg(`Found ${result.jobs} jobs for "${keywords.trim()}"${providers}${cacheNote}${unseen}.`);
    } else if (result?.exhausted) {
      setScrapeSuccessMsg('No more new jobs in the last 24h — widen the window or check back later.');
    } else {
      setScrapeSuccessMsg('No results found in the selected window. Try different keywords, a wider posted window, or search again later.');
    }
```

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: all pass (existing suite + new unseen tests)

- [ ] **Step 5: Commit**

```bash
git add server.ts src/App.tsx src/components/ScraperBar.tsx
git commit -m "feat(v2-search): UI shows next-N-unseen + exhausted state; route passes through seen/exhausted counts"
```

---

## Self-Review

**1. Spec coverage:**
- §3A search_seen table → Task 1 ✓
- §3B provider_cursors → Task 1 ✓
- §3C query fingerprint reuse → Tasks 2, 3 ✓
- §4 STEP 1 unseen DB-first → Task 2 ✓
- §4 STEP 2 provider advance w/ budget → Task 3 ✓
- §4 STEP 3 merge/dedupe/exclude/persist/mark-seen → Tasks 2, 4 ✓
- §4 STEP 4 bounded top-up → Task 4 ✓
- §4 STEP 5 exhaustion → Tasks 4, 5 ✓
- §5 cost invariants → preserved (budget math untouched; tests in Task 1/2 verify) ✓
- §7 UI → Task 5 ✓
- §9 tests 1-8 → Tasks 1, 2, 4 (disjoint-batch regression: Task 2 first test; mark-seen idempotency: Task 1; cursor: Task 3; exhaustion: Task 4; DB-hit 0 calls: Task 2) ✓

**2. Placeholder scan:** No TBD/TODO; every step has concrete code and commands. The `getSearchFingerprintLocal` helper is defined inline in Task 3 (avoiding export churn).

**3. Type consistency:** `markSeen(userId, queryFp, fingerprints)` and `getSeenFingerprints(userId, queryFp)` defined in Task 1, used identically in Tasks 2-4. `routeProvider(req, providerId, limit)` signature unchanged. `searchWithCache` return extended with `queryFp/seenCount/totalStored/exhausted` in Task 2/4, consumed in Task 5. Cursor field names match (`cursor`, `fetched_count` ↔ `fetchedCount`).