# Tailor-AI V2 — Execution Plan (Private, not pushed)

> Santa Maria ATS Job Search & How-to-Apply — incremental, V1-safe.
> Source spec: user research 2026-08-19 (38 sections). This doc is the private build plan.

## 0. Principles

* Do NOT rebuild V1, replace workflows, or introduce a new DB/search engine unless needed.
* Reuse: `src/types.ts:Job`, `server/scraper/*`, `server/storage/fileStorage.ts` (jobs as JSON per user), `server/builder/*`, `server/ats/*` (Playwright scaffold), `server/config.ts` BYOK.
* Provider-agnostic: `JobProvider` interface hides Santa Maria; UI never calls Apify directly.
* BYOK: `APIFY_API_TOKEN` + `LLM_API_KEY` from `config.ini` / env, never in Git, never to frontend.
* Cost-control: DB-first cache (`JOB_CACHE_TTL_HOURS=24`), `LIMIT` is post-filter, never fabricate jobs.

## 1. Current V1 Map (verified 2026-08-19)

* **Job:** `src/types.ts:4` (`id,title,company,location,source:JobSource(23),description,url,state, tailoredCv`) → `jobs(id PK, user_id, data TEXT)` JSON.
* **Sources:** `src/constants/sources.ts:SOURCES` (23). Apify: LinkedIn/Indeed/Naukri/Glassdoor/Upwork + Greenhouse/Lever/Ashby/Workable (placeholders). Free: Arbeitnow, SimplyHired, Dice, Reed, RemoteOK, etc. Factory `server/scraper/scraperFactory.ts:APIFY_SCRAPERS` + `else if` chain.
* **Search:** `ScraperBar.tsx` → `App.tsx:handleScrape` → `POST /api/jobs/scrape` (`server.ts:1398`) → `ScraperFactory.runScrape` → `persistJobsWithUpgrade()` → `GET /api/jobs?search&source&page&limit` → `queryJobs()`.
* **Tailor:** `server/builder/llmCvTailor.ts` + `server/matcher/llmMatcher.ts` → `POST /api/jobs/:id/tailor` (2044), `POST /api/analyze-jd/*` (Manual JD). `TailoredCv` stored inline.
* **ATS scaffold:** `server/ats/types.ts` (22-state machine, `ATSAdapter` 8 methods), `detector.ts` (14 ATS URL hints), `browser.ts` (`chromium` + `~/.tailor-ai/browser-profiles/<ats>`), `queue.ts` (`ats_queue`), only `greenhouse/adapter.ts` exists and is not registered.
* **Secrets:** `server/config.ts` (`config.ini` + `dotenv`), `hasApiKeyConfigured()` guard.

## 2. V2 Target Architecture

```
User Search (keywords, locations, remote, LIMIT 5/10/15/25/50)
  ↓
Job Search Service (local DB-first)
  ↓ (miss)
SantaMariaApifyProvider (JobProvider)
  ↓ POST /v2/acts/santamaria-automations~career-site-jobs-scraper/runs → poll → dataset
  ↓ normalize → fingerprint → deduplicate → persist (isActive, scrapedAt, providerRunId)
  ↓ rank → slice LIMIT
  ↓
Display (ATS badge, Tailor & Apply)
  ↓ Apply: Tailor (cache by fingerprint+CV version) → ATS detection → Adapter → Playwright → Layer 1 Preview → User Confirm → Submit → Receipt → History
```

## 3. Model Changes (additive)

* `ATSPlatform` enum: `greenhouse|workday|ashby|lever|smartrecruiters|workable|teamtailor|personio|bamboohr|icims|recruitee|join|pinpoint|rippling|jazzhr|comeet|other` (16+). Keep `JobSource` for backward compat, map lowercased.
* `Job` extensions: `atsPlatform?: ATSPlatform`, `externalId?`, `companyId?`, `locations?:string[]`, `department?`, `employmentType?`, `remote?:boolean`, `atsCompanySlug?`, `provider?:string`, `providerRunId?:string`, `fingerprint:string` (ATS+externalId → applyUrl → company+title+location, URL normalized), `isActive:boolean`, `scrapedAt`, `createdAt/updatedAt`. Preserve `jobUrl`/`applyUrl` as-is, never fabricate.
* New tables: `company_career_sites(id, companyName, careerUrl UNIQUE, atsPlatform, atsCompanySlug, isActive, lastScrapedAt)` (global, reusable) + `provider_runs(id, provider, externalRunId, requestedLimit, jobsReturned, status, startedAt, completedAt)`. Keep `jobs` JSON, add indexes on `json_extract(data,'$.atsPlatform')`, `fingerprint`, `isActive`.

## 4. Phases (incremental, V1-safe)

### Phase 1 — Provider Abstraction (current)
Files: `server/providers/jobProvider.ts` (`JobProvider` interface), `server/providers/santaMariaProvider.ts` (`SantaMariaApifyProvider`), `src/constants/atsPlatforms.ts`.
* Interface: `search(params: JobSearchParams): Promise<JobProviderResult>` with `JobSearchParams{keywords[], locations?, remote?, atsPlatforms?, limit, companyIds?}` and `JobProviderResult{jobs:Job[], provider, providerRunId, totalReturned, requestedLimit}`.
* Santa Maria input: `{queries: (url|string|{platform,company})[], maxJobsPerCompany:500, includeDescription:true}` — `maxJobsPerCompany` ≠ UI `LIMIT`.
* Tests: mocked Apify responses (no cost), ATS detection, URL normalization, fingerprint, LIMIT enforcement.

### Phase 2 — Persistence
`normalize()` (preserve URLs), `validate()` (title/company/jobUrl/applyUrl/atsPlatform required; descriptionAvailable flag), `deduplicate()` (fingerprint), `persist()` + indexes. Add `JOB_CACHE_TTL_HOURS=24` (configurable).

### Phase 3 — Search
`POST /api/jobs/search` (new, keep `/api/jobs/scrape` untouched): parse search → local DB relevance (title/department/description/location/remote, deterministic, no LLM) → `isActive` + freshness → `LIMIT` slice → if insufficient, invoke Santa Maria → normalize → persist → rank → return.

### Phase 4 — UI
Keep `Find Jobs`, job card shows `ATS badge + Remote + Department`. `Tailor & Apply` replaces `Run Apify Actor` copy. No Apify leakage.

### Phase 5 — Tailor Integration
`Job.description + MasterCv → LlmCvTailor` with cache by `fingerprint + CV version` + `descriptionAvailable` guard.

### Phase 6 — Adapters
Order: `Greenhouse → Lever → Ashby → Workable → Workday → SmartRecruiters`. Each `ATSApplicationAdapter {supports, prepare, preview, submit}` around existing `browser.ts`. No generic script.

### Phase 7 — Confirm + Receipt
`preview() → Confirm → submit() → ApplicationReceipt{id,userId,jobId,company,jobTitle,atsPlatform,applyUrl,status,submittedAt,confirmationReference,screenshotPath}` + history. Mandatory user confirm.

### Phase 8 — Background Refresh
`Company Refresh Worker` (12-24h, queue, batched `careerUrl` → Santa Maria → DB), non-blocking.

## 5. Tests & Gates

* Unit: ATS detection, URL normalization, fingerprint, dedup, LIMIT, relevance, normalization, provider errors.
* Integration: Santa Maria API mocked for CI, manual optional live test.
* Acceptance: 6 ATS (Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Workday) + LIMIT 5/10/15/25/50 + dedup + cached search + Apply flow.
* After each phase: `npx tsc --noEmit`, `npx vite build`, `npx vitest run`, existing V1 tests.

## 6. Next Step

Phase 1 scaffolding with mocked Santa Maria — no Apify cost, no V1 breakage.

## 7. Log

* 2026-08-19: Phase 0 Track A complete (14 ATS matrix), T1 engine scaffold (types/detector/browser/queue/greenhouse adapter), Layer 1 preview drawer built and validated.
* 2026-08-19: V2 spec aligned to V1 codebase, private plan created.
