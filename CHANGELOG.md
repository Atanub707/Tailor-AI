# Changelog

## v2.0.0 (2026-08-26)

### 🏗️ Architecture: Tailor AI becomes a local job-search engine
- **Background job indexer** — silently watches free-ATS boards (Greenhouse/Lever/Ashby) every 4h while the app runs: incremental refresh (new jobs inserted, changed bumped, removed marked inactive), bounded concurrency (3 boards), per-board failure isolation with skip-on-failure, boot catch-up. No Apify spend.
- **Retention policy (Option B)** — jobs older than 7 days are auto-deleted unless Applied/Tailored/Ready (those survive forever). Runs on boot + daily; orphaned search links cleaned up.
- **Job lifecycle fields** — `firstSeenAt`, `lastSeenAt`, `isActive` on every job; removed-from-board jobs are hidden from the default view but preserved for applied history.
- **Search-context isolation** — `searches` + `search_jobs` tables: each search records its query/location/window and links only its relevant jobs. A "DevOps Engineer" search no longer shows results from an earlier "AI Engineer" search. State tabs (Applied/Tailored/Ready) remain global.
- **Query-aware relevance engine** — 10 query profiles (DevOps/SRE, Cyber Security, AI/ML, Backend, Frontend, Full Stack, Data Engineering, QA, Mobile + conservative generic fallback). Named match tiers (EXACT → WEAK_RELATED), deterministic scoring, explicit exclusions. "Data Engineer" / "Product Manager" / "Account Executive" can never pass a DevOps search. Ranking: relevance tier first, freshness second.
- **Greenhouse date fix** — `first_published` is now the canonical posting date (was `updated_at`, which let a February job pass "Last 24 hours"). Lever `createdAt` → created, Ashby `publishedAt` → published; `dateSemantics` labels each job's timestamp so the UI shows "Published Xh ago" vs "Updated Xh ago".
- **Local-first search** — searches read the local corpus first (instant, $0); providers only top up shortages.
- **Provider date semantics + local filter pipeline** — validity → date → location → job-type → relevance → dedup → rank → limit; normalized location matching ("India" matches "Bengaluru, India" / "Remote - India").
- **Free-API ATS search** — Greenhouse/Lever/Ashby fetched directly from their free public APIs (zero Apify credits); SmartRecruiters stays on the Santa Maria actor.
- **Source chips** — official brand SVG icons for the main portals, portal counts, popularity ordering, "More" dropdown removed, paid/enterprise ATS locked (🔒).

### 🐛 Fixes
- Relevance guard is unconditional — a fully-irrelevant board slice returns [] and is never persisted (was the "Account Executive leaked into DevOps search" bug).
- Installer fixes: `Test-Path -and` PowerShell syntax error (2 spots), updater now locates git.exe and fails loudly instead of fake "OK Code updated".
- Multi-account jobs PK is now `(user_id, id)` — each account owns its own copy of a job (was: account B saw "already exists" with an empty list).
- No live Apify calls in any test — all hermetic (temp data dir + mocks); 195 tests passing.

### ⚠️ Notes
- Old jobs saved before this release remain in your DB — delete stale rows manually if you want them gone.
- SmartRecruiters + job-board sources (Glassdoor/Indeed/Naukri/Upwork) still require Apify credits; the UI surfaces the real reason when the monthly cap is hit.