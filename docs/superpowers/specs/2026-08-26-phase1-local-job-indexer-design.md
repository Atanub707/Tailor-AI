# Phase 1 — Local Job Indexer: Background Watcher + Lifecycle + Retention

Status: Approved (2026-08-26)
Branch: feat/v2-unified-search

## Goal

Evolve Tailor AI from "a UI that runs job scrapers" toward "a private local
job-search engine": a background watcher silently fills a local SQLite corpus
from the free ATS APIs, searches read that corpus first, providers only top up
shortages, and a retention scheduler deletes stale untouched jobs after 7 days.

## Scope (Phase 1)

1. **Job lifecycle fields** — `firstSeenAt`, `lastSeenAt`, `isActive`
2. **Background watcher** — incremental refresh of free-ATS boards
   (Greenhouse/Lever/Ashby), bounded concurrency, per-board failure isolation
   with backoff, boot-time catch-up, never blocks the web UI
3. **Retention scheduler** — deletes jobs older than 7 days unless
   Applied/Tailored/Ready; cleans orphaned `search_jobs` links
4. **Local-first search** — search the local corpus before any provider call;
   on-demand top-up only for the shortage
5. **Tests** — all mocked/isolated (temp data dir), zero live API calls

Out of scope (Phase 2+): registry health verification, change-rate-based
refresh scheduling, economy/balanced/aggressive modes, SQLite FTS5, lazy
description loading, description pruning, paid-provider background refresh.

## Architecture

```
Tailor AI server process
│
├── Web/API server (existing — unchanged)
├── Local Job Indexer (NEW)
│   ├── scheduler (setInterval + boot catch-up)
│   ├── company registry reader (company_career_sites)
│   ├── provider connectors (free ATS direct APIs — reuse existing)
│   ├── incremental diff (new/changed/removed)
│   ├── bounded concurrency (max 3 boards)
│   └── per-board failure backoff
└── Retention scheduler (NEW)
    ├── daily + boot sweep
    └── 7-day deletion with Applied/Tailored/Ready exemption
```

## Data model

Jobs (existing `jobs` table, JSON blob — add fields, no schema migration):

```js
{
  ...existing,
  firstSeenAt: "2026-08-26T09:00:00Z",  // first discovery
  lastSeenAt:  "2026-08-26T09:00:00Z",  // last confirmed on board
  isActive: true                          // false = removed from board
}
```

- `firstSeenAt` set once on insert; `lastSeenAt` bumped on every refresh that
  still sees the job; `isActive=false` when a refresh no longer sees it.
- Existing rows: `firstSeenAt ?? scrapedAt`, `lastSeenAt ?? scrapedAt`,
  `isActive ?? true` — lazily backfilled on read/update, no migration pass.

## Retention policy (Option B — user-approved)

Delete jobs where:
- `isActive` is false OR age since `firstSeenAt` (fallback `postedDate`) > 7 days, AND
- state is NOT `applied`, `tailored`, `ready`

Applied/Tailored/Ready jobs are kept forever regardless of age.

Sweep runs: on app boot + every 24h. Also deletes orphaned `search_jobs`
rows for deleted job ids (single DELETE via join).

## Background watcher behavior

- Interval: every 4h while server runs (Phase 1 fixed interval; Phase 2 adds
  change-rate scheduling).
- Board selection: `company_career_sites` filtered to active free-ATS
  platforms, rotating slice (reuse existing rotation), max 3 concurrent.
- Incremental diff per board:
  - job id seen before → existing row: bump `lastSeenAt`; if title/company/
    applyUrl/publishedAt changed materially → update; else skip
  - new job id → insert with `firstSeenAt = now`
  - previously-seen ids missing from this fetch → `isActive = false`
- Failure isolation: one board 403/timeout → record failure, skip, continue
  others; exponential backoff per board (30s, 2m, 8m cap) after consecutive
  failures. Never throws out of the watcher loop.
- Budget: watcher NEVER calls Apify. Free direct ATS only (Greenhouse/Lever/
  Ashby). If a board belongs to a non-free platform, skip.
- Throttle: watcher skips a cycle if a user search is in-flight (mutex flag).

## Local-first search

Already ~60% present in `searchService.searchWithCache` (DB-first path). Phase
1 hardens it:
- Read local corpus → eligibility (validity/date/location/jobtype) →
  relevance rank → if `>= limit` results, return (zero provider calls).
- Shortage → provider top-up for exactly the missing count → normalize →
  persist → re-run local search → return.
- Watcher-fed corpus means the DB-first path pays off: repeated/cross-query
  searches are $0.

## Retention + watcher concurrency

- Retention sweep and watcher run sequentially (single scheduler tick), never
  concurrently — one mutex.
- Deletion respects `search_jobs` FK cleanup (no FK constraint; explicit
  DELETE of orphaned links after job DELETE).

## API / UI

- No new endpoints in Phase 1.
- `GET /api/jobs` unchanged semantics: default shows active jobs (hide
  `isActive=false` from the default view unless the user is in a state where
  they should see them — applied/inactive rows stay visible via state tabs).
- Search-context isolation (searches/search_jobs) already in place — untouched.

## Testing (all isolated, zero live calls)

- Incremental diff: new job → insert; changed job → update; missing job →
  isActive=false
- firstSeenAt set once, lastSeenAt bumps
- Retention: pending job >7d deleted; applied/tailored/ready kept; orphaned
  search_jobs removed; isActive=false pending job deleted at sweep
- Local-first: corpus has >= limit → no provider call; shortage → top-up
- Watcher: board failure → other boards continue; backoff increases
- All via `TAILOR_DATA_DIR` temp dir + mocked fetch; no Apify tokens used.

## Success criteria

- 7-day-old untouched jobs never appear; applied/tailored/ready survive
- Searches over a warm corpus make zero provider calls
- Watcher runs 4h cycles without breaking the UI or hitting Apify
- 165 existing tests still pass + new watcher/retention/lifecycle tests