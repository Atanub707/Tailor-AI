# Next Unseen Batch Search — Design (private, not pushed)

Date: 2026-08-25
Status: Approved (recommendation A — unseen-first, newest-first)
Repo: Tailor-AI (ATS-FREE-CVs), branch: main
Note: this spec is gitignored — never pushed to the public repo (user rule).

## 1. Problem

The market has ~1,000 fresh "DevOps Engineer" jobs in the last 24h. A user
searches LIMIT 25 → we fetch 25 → they apply to 24. The NEXT search returns
the SAME 25 from DB-first cache — the user never walks the remaining 975.
Requirement: each search shows the NEXT 25 unseen jobs (newest first), walking
the pool progressively until exhausted. Industry standard: cursor pagination
+ always dedupe (JobsPipe/Indeed/LinkedIn guidance).

## 2. Core concept

Every job RETURNED to the user is marked "seen" for that query. The next
search for the same query shows whatever is UNSEEN in the local DB first,
newest first, $0. Providers only advance (next page / next slice) when the
unseen-in-DB pool runs dry. DB is the "what have I seen" ledger.

## 3. Components (all additive — V1 untouched)

### A. `search_seen` table (per user, per query)
```sql
CREATE TABLE IF NOT EXISTS search_seen (
  user_id TEXT NOT NULL,
  query_fp TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, query_fp, fingerprint)
);
```
Marked when jobs are returned in a search response — "seen", not "fetched".

### B. `provider_cursors` table (per user, per query, per provider)
```sql
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
LinkedIn → `start` offset (page 2, 3, …). Indeed → next page. Santa Maria →
no server cursor; its "advance" is the skip-list of owned fingerprints; each
run fetches the next budget slice, filtered locally.

### C. Query fingerprint — reuse `getSearchFingerprint()` (searchService.ts)
`devops-engineer|india|24h|remote|any`. Different query = different walk.

## 4. Data flow

```
POST /api/jobs/search {keywords, location, postedWithin, limit}
  ↓
query_fp = getSearchFingerprint(...)
  ↓
STEP 1 — DB-first, unseen only:
  fresh jobs matching query+location (scrapedAt < 24h, isActive)
  EXCLUDING search_seen rows for this query_fp
  → ≥ LIMIT? → mark seen → return next 25 → $0 (the 975-left case)
  → fewer → missing = LIMIT − unseenDB
  ↓
STEP 2 — provider advance (only if missing > 0):
  global budget = ceil(missing × 1.5)   ← the ONLY money number
  router picks eligible providers (query-aware), reads their cursors,
  allocates slices (reserve 15% for top-up), runs IN PARALLEL
  with per-provider soft timeout (≤35s)
  ↓
STEP 3 — merge pipeline:
  normalize → dedupe (fingerprint) → exclude already-seen
  → persist new (scrapedAt/isActive/fingerprint) → update cursors
  → mark seen → rank (title-exact → freshness) → slice LIMIT → return
  ↓
STEP 4 — if still short AND cursors not exhausted:
  ONE bounded top-up (best next provider, ≤ reserved slice)
  ↓
STEP 5 — pool exhausted:
  return what we have + "No more new jobs in the last 24h — widen the window"
```

## 5. Cost safety (invariants)

- `missing × 1.5` is the only money number; providers share it, never multiply.
- Pure DB hit (enough unseen stored) = $0, zero provider calls.
- Repeat searches contact providers only when unseen-in-DB runs dry — bounded
  by budget. Page 2 costs a little; that is inherent to walking the pool.
- Regression: sum of provider allocations ≤ global budget for LIMIT 5/10/15/25/50.

## 6. Error handling

- Provider failure → slice lost, top-up may cover; "Some sources temporarily
  unavailable" — never a blank search.
- New posting mid-walk → cursor may shift → dedupe by fingerprint absorbs it.
- Pool exhausted → clear message, not empty results.

## 7. UI (minimal)

Keep the Find Jobs bar. Under results:
- "Showing next 25 unseen · 42 of ~1,000 in the last 24h"
- Exhaustion state: "No more new jobs — try a wider window or check back later."

## 8. Seen scope

Per query (recommendation A approved). Searching "DevOps Engineer" and
"Platform Engineer" can both show the same job — different walks. Global
per-user seen is a one-line change in STEP 1 if desired later.

## 9. Tests

1. Repeat same query → disjoint results (batch 2 ≠ batch 1) — core regression
2. 30 fresh, 10 seen, LIMIT 25 → missing 5 → providers called with budget 8
3. Mark-seen idempotency
4. Cursor advance per provider (mocked: LinkedIn start, Santa Maria skip-list)
5. Budget invariant (sum ≤ global for all LIMITs)
6. Pool-exhaustion message
7. DB-hit = 0 provider calls
8. Provider failure isolation

## 10. Files touched

- `server/storage/v2Tables.ts` — search_seen + provider_cursors tables + helpers
- `server/services/searchService.ts` — STEP 1 unseen filter + seen marking
- `server/services/providerRouter.ts` — cursor read/advance per provider
- `server.ts` — route passes query_fp; response includes seen/total counts
- `src/components/ScraperBar.tsx` — "next N unseen" + exhaustion message
- `tests/providers/optimizedSearch.test.ts` — new tests above

## 11. Implementation order

1. Tables + helpers (search_seen, provider_cursors)
2. STEP 1 unseen filter + mark-seen in searchService
3. Provider cursor read/advance in router (LinkedIn start; Santa Maria skip-list)
4. Exhaustion message + UI counts
5. Tests + full gate (tsc / vitest / vite build)