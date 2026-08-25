# V2 Cost-Optimized Search — Architecture Report (Before Edits)

**Branch:** `feat/v2-unified-search` (from `main` @ `445193d` v1.8.4)
**Date:** 2026-08-19
**Goal:** Optimize job-search to never scrape 500 to return 5-50, without touching UI/source-selector.

## 1. Existing Search Implementation

* **Entry:** `ScraperBar.tsx` (state: `keywords, location, sources[], datePostedFilter, jobType, maxJobsPerSource 5/10/15/25/50, under10Applicants`) → `App.tsx:handleScrape` → `POST /api/jobs/scrape` (`server.ts:1398`)
* **Scrape:** `ScraperFactory.runScrape(ScraperParams)` (`server/scraper/scraperFactory.ts`) — iterates `sources` sequentially, checks `robots.txt` (cached 1h) for free scrapers, checks `apify.enabled+token` for Apify sources, calls `APIFY_SCRAPERS[source].scrape(params)` or `new XScraper().scrape(params)`. Then `persistJobsWithUpgrade()` (dedup by `url.toLowerCase()`), `queryJobs()` for listing.
* **Listing:** `GET /api/jobs?search&source&jobType&page&limit` → `queryJobs()` (filters: state, source, search, jobType via `classifyWorkMode`, location, datePostedFilter, under10Applicants, minScore, sortBy).

## 2. Scraper/Provider Interfaces

* `BaseScraper` (`server/scraper/baseScraper.ts`): `source, scrape(params):Promise<Job[]>`
* `ApifyBaseScraper` (`server/scraper/apifyBase.ts`): `source, actorId, buildInput(params), mapItem(item):Job|null, scrape()` — generic `run-sync-get-dataset-items?token=` (240s timeout), relevance filter (any keyword word in title/company), posted-window opt-in, isolates failures.
* `JobProvider` (`server/providers/jobProvider.ts` — added in Phase 1 scaffold, not yet used by `ScraperFactory`): `search(params: JobSearchParams):Promise<JobProviderResult>` — provider-agnostic, BYOK.
* `SantaMariaApifyProvider` (`server/providers/santaMariaProvider.ts`): wraps `santamaria-automations~career-site-jobs-scraper`, `maxJobsPerCompany:500` (to be removed), `includeDescription:true`, async `createRun → poll SUCCEEDED → dataset`, `normalize()` now handles snake_case (`job_url`, `ats_platform`).

## 3. Existing Apify Integrations

* **Valig actors (5):** `LinkedIn` (`valig~linkedin-jobs-scraper`, `builtInFallback:true`), `Indeed`, `Naukri`, `Glassdoor`, `Upwork` — all `needsApify:true`, `pricePer1K $0.10-$0.40`. `buildInput` maps `keywords→title`, `location`, `datePostedFilter→datePosted`, `jobType→remote`, `maxJobsPerSource→limit` (clamped 1000).
* **Santa Maria (new, 25 ATS):** `santamaria-automations~career-site-jobs-scraper`, `$1/1K + $0.001/start`, `queries: (url|{platform,company})[]`, `maxJobsPerCompany:500` (critical bug), `includeDescription:true`. Supports Greenhouse, Workday, Ashby, Lever, SmartRecruiters, Workable + 19 more (Teamtailor, Personio, BambooHR, iCIMS, Recruitee, JOIN, Pinpoint, Rippling, JazzHR, Comeet, other).
* **Placeholders (4):** `Greenhouse/Lever/Ashby/Workable` as `apify~...` — to be replaced by Santa Maria as single provider for those 6 P0.

## 4. Other Providers

* **LinkedInPosts:** `LinkedInPostsScraper` (`server/scraper/linkedInPostsScraper.ts`) — free engine, `maxJobsPerSource` + daily quota `posts_daily_usage`.
* **Built-in free (13):** `Arbeitnow`, `SimplyHired`, `Dice`, `Reed`, `RemoteOK`, `WeWorkRemotely`, `MyCareersFuture`, `Cutshort`, `Gupy`, `JobsCh`, `Daijob`, `MyJobMag`, `Custom` — each `BaseScraper`, `https://` fetch, `cheerio` parse, `maxJobsPerSource` + `datePostedFilter→maxAgeMs`.

## 5. SQLite Schema

* **Core:** `jobs(id PK, user_id, data TEXT JSON)` — per-user via `AsyncLocalStorage`, dedup by `url`. `master_cv`, `manual_analysis`, `interview_sessions`, `hr_contacts`, `lp_history`, `candidate_profile`, `contact_emails`, `posts_daily_usage`.
* **V2 additions (scaffolded, not yet migrated):** `company_career_sites(id, companyName, careerUrl UNIQUE, atsPlatform, isActive, lastScrapedAt)`, `provider_runs(id, provider, externalRunId, requestedLimit, jobsReturned, status)`, `ats_queue` (22-state machine), `application_receipts`. Indexes on `json_extract(data,'$.fingerprint')` etc. (best-effort).

## 6. Job Normalization / Dedup / Ranking

* **Normalization:** `ApifyBaseScraper: extractDescription()` (7 fields + nested), `cleanDescription()` (strip HTML), `normalizeIsoDate()` (relative caption > date stamp). `SantaMaria`: preserves `jobUrl/applyUrl`, maps `atsPlatform`, `fingerprint` (`ATS+externalId → applyUrl → company|title|location` hash).
* **Deduplication:** `ScraperFactory` none; `persistJobsWithUpgrade` dedups by `url.toLowerCase()`; `SantaMaria` dedup by `fingerprint` (new). No cross-provider dedup yet.
* **Ranking:** `queryJobs()` sorts by `postedDate|matchScore|createdAt|company|title|salaryMax` + deterministic title/company filter (any keyword word in `title+company`). No LLM ranking. Work-mode guard `contradictsWanted()` post-filter.
* **Cache:** `lp_history` (200) for LinkedIn Posts only; no general job cache. `JOB_CACHE_TTL_HOURS` not yet implemented.

## 7. Existing Cache Behavior

* No DB-first cache for job search — every `POST /api/jobs/scrape` runs all requested providers.
* `ScraperFactory` does relevance filter (any term) and `applyPostedWindowFilter` (Upwork only) but no global `LIMIT` slicing or progressive stop.

## 8. API Endpoints

* `POST /api/jobs/scrape` (V1, to preserve)
* `GET /api/jobs`, `GET /api/jobs/stats`, `GET /api/jobs/:id`, `POST /api/jobs/:id/match|tailor|apply` (tailor has fingerprint cache in Phase 5), `POST /api/scrape-full-text`
* `POST /api/jobs/search` (V2, added in Phase 3 scaffold, DB-first, not yet wired to UI)
* `POST /api/linkedin-posts/search` etc.

## 9. Existing Tests

* `tests/providers/santaMariaProvider.test.ts` (3 tests: LIMIT, fingerprint, ATS hint) + 10 other suites (78 tests total, all green). No integration tests that hit real Apify (mocked).

## 10. What Will Be Reused (no duplicate)

* `Job` model + `jobs` table (extend, not replace)
* `ScraperParams` / `JobSource` / `SOURCES` registry (add `SantaMaria` as `JobProvider` behind flag, not as `JobSource`)
* `ApifyBaseScraper` helpers (`cleanDescription`, `normalizeIsoDate`, etc.)
* `server/ats/*` (detector, browser, queue, adapters) for Apply — untouched in this task
* `server/config.ts` BYOK (`apify.token`, `llm.apiKey`)

## 11. Smallest Integration Points for Optimization

* Add `SearchRequest` + `fetchBudget = min(ceil(LIMIT*1.5), 50)` (config-driven, not hard-coded 500)
* Add `ProviderCapabilities` per provider (keyword/location/date/maxResults)
* Wrap `ScraperFactory.runScrape` with `SearchService` that does `local DB → provider router → progressive fan-out → dedup → rank → slice LIMIT`
* Fix Santa Maria `maxJobsPerCompany:500` → `ATS_MAX_RAW_RESULTS=50` safety budget
* Make `description` optional for discovery (fetch full JD only on Tailor & Apply)
