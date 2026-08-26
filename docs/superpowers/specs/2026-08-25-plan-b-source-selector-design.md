# Plan B — Source-Selector Search (Fallback) — Design (private, not pushed)

Date: 2026-08-25
Status: DESIGN ONLY — not implemented. Activate ONLY if the unified dynamic
search (Plan A, "Next Unseen Batch") fails to meet requirements.
Repo: Tailor-AI (ATS-FREE-CVs), branch: main

## 1. What Plan B is

Restore the OLD source-selector search structure (exactly as it was in v1.8.x,
commit `33d14b9~1`) — the search bar WITH source chips — and EXTEND it with
the ATS-25 sources. User explicitly picks which sources to search:
LinkedIn, Naukri, Indeed, Glassdoor, Upwork + 25 ATS (Greenhouse, Lever,
Ashby, Workable, Workday, SmartRecruiters…) + free boards (Arbeitnow, Dice…).

"Plan B" = the old structure + ATS sources added. Nothing else changes.

## 2. Why it exists

The unified dynamic search (Plan A) may not match requirements (loose
keyword matching, provider mix, seen-walk semantics). Plan B is the
known-good fallback the user already validated for months (v1.8.x era):
explicit source selection = predictable results.

## 3. The old structure (verified from git, 33d14b9~1)

### 3.1 UI — ScraperBar.tsx (old)

- `ALL_SOURCES: JobSource[]` = `['LinkedIn', 'Arbeitnow', 'SimplyHired', 'Dice', 'Reed', 'MyCareersFuture', 'Cutshort', 'Gupy', 'JobsCh', 'Daijob', 'MyJobMag', 'RemoteOK', 'WeWorkRemotely', 'Indeed', 'Naukri', 'Glassdoor', 'Upwork']`
- `APIFY_SOURCES_VISIBLE = ALL_SOURCES.filter(s => getSourceMeta(s)?.apifyActorId)` — main row chips
- `MORE_SOURCES = ALL_SOURCES.filter(s => !getSourceMeta(s)?.apifyActorId)` — "More" dropdown
- `selectedSources: JobSource[]` state, default `['LinkedIn']`
- `renderSourceChip(src)` — pill with flag, label, `Apify` badge when `apifyActorId`, disabled when `needsApify && !apifyAvailable` or "Coming soon"
- Filters row: Location, Job Type, Posted, Level, Contract, Limit (5/10/15/25/50), Competition (under 10 applicants)
- Submit → `onScrape({ keywords, location, sources: selectedSources, datePostedFilter, jobType, maxJobsPerSource, contractType, experienceLevel, under10Applicants })`

### 3.2 Source registry — src/constants/sources.ts (old)

`SOURCES: Record<JobSource, SourceMeta>` with per-source:
```ts
{ id, label, flag, country, region, apifyActorId?, needsApify?, builtInFallback?, pricePer1K? }
```
Apify (Valig): LinkedIn `valig~linkedin-jobs-scraper` ($0.40, builtInFallback),
Indeed `valig~indeed-jobs-scraper` ($0.10), Naukri `valig~naukri-jobs-scraper`
($0.40), Glassdoor `valig~glassdoor-jobs-scraper` ($0.40), Upwork
`valig~upwork-jobs-scraper` ($0.20). All `needsApify: true` except LinkedIn.

Free: LinkedInPosts (free), Arbeitnow, SimplyHired, Dice, Reed, RemoteOK,
WeWorkRemotely, MyCareersFuture, Cutshort, Gupy, JobsCh, Daijob, MyJobMag, Custom.

### 3.3 Backend — POST /api/jobs/scrape (V1, UNTOUCHED today)

`server.ts:1398` → `ScraperFactory.runScrape(ScraperParams)`:
- iterates `sources` SEQUENTIALLY
- Apify sources via `APIFY_SCRAPERS[source]` (apifyBase: buildInput + mapItem + relevance filter)
- free sources via explicit else-if chain
- robots.txt guard for direct-crawl sources (cached 1h)
- `persistJobsWithUpgrade()` → jobs table, dedup by url
- returns `{ scrapedTotal, addedCount, skippedDuplicates, skippedSources, newContacts }`

This endpoint STILL EXISTS and STILL WORKS today — it was never removed.

## 4. What Plan B ADDS on top of the old structure

### 4.1 ATS-25 as selectable sources

Add to the source registry (and chips) the ATS sources that route through
Santa Maria (single aggregated actor — not 25 separate actors):

```ts
// src/constants/sources.ts — new ATS entries (needsApify: true, single actor)
Greenhouse:  { flag: '🌱', apifyActorId: 'santamaria-automations~career-site-jobs-scraper', pricePer1K: '$0.40' }
Lever:       { flag: '🔷', same actor, pricePer1K: '$0.40' }
Ashby:       { flag: '🟣', same actor, pricePer1K: '$0.40' }
Workable:    { flag: '🔧', same actor, pricePer1K: '$0.40' }
Workday:     { flag: '🏢', same actor, pricePer1K: '$0.40' }
SmartRecruiters: { flag: '🧠', same actor, pricePer1K: '$0.40' }
+ Teamtailor, Personio, BambooHR, iCIMS, Recruitee, JOIN, Pinpoint,
  Rippling, JazzHR, Comeet, other (16-25 ATS total — see ATSPlatform enum)
```

Each ATS source = a CHIP. Selecting any of them → one Santa Maria call with
`queries` built from `company_career_sites` filtered by that `atsPlatform`.

### 4.2 Backend routing for ATS chips

`ScraperFactory` (or a small branch in it) maps the selected ATS sources to
ONE `SantaMariaApifyProvider.search()` call with the registry queries for
those platforms:

```ts
// server/scraper/scraperFactory.ts — new branch, additive
if (selectedAtsSources.length > 0) {
  const atsPlatforms = selectedAtsSources.map(toAtsPlatform);
  const queries = getCareerUrlsFor(atsPlatforms); // from company_career_sites
  const result = await new SantaMariaApifyProvider().search({
    keywords: [params.keywords],
    limit: params.maxJobsPerSource,
    queries,
  });
  jobs.push(...result.jobs);
}
```

Cost control KEEPS: `getProviderFetchLimit(limit, 'santa-maria')` budget
(still never 500), DB-first cache untouched if it stays on.

### 4.3 Filters — reused as-is from old structure

Location, Job Type, Posted, Level, Contract, Limit, Competition — unchanged.
`maxJobsPerSource` = per-source cap exactly like V1 (each selected source gets
its own limit — the old semantics the user knows).

## 5. Rollback / Activation

Plan B = RECOVER the old ScraperBar + sources.ts from `33d14b9~1` +
ADD the ATS source entries + the SantaMaria branch. Concretely:

1. `git show 33d14b9~1:src/components/ScraperBar.tsx > src/components/ScraperBar.tsx`
   (restore source chips; re-wire onScrape to POST /api/jobs/scrape shape)
2. `git show 33d14b9~1:src/constants/sources.ts > src/constants/sources.ts`
   (restore registry) then ADD the 16-25 ATS entries (above)
3. `server.ts` POST /api/jobs/scrape is UNCHANGED (still present) — keep it
   as the Plan B endpoint. Add the SantaMaria branch to ScraperFactory.
4. Gate: `npx tsc --noEmit && npx vitest run && npx vite build`
5. Verify: search "DevOps Engineer" → select LinkedIn + Greenhouse + Workday
   → returns jobs from all three (ATS badges visible), LIMIT respected,
   cost = sum of per-source budgets (never 500).

## 6. Decision trigger

Activate Plan B when (any):
- Plan A search returns empty/irrelevant for common queries
- User explicitly wants per-source control
- Provider mix is wrong (e.g., ATS never appears)
- Budget surprise (unexpected Apify spend from unified fan-out)

Keep Plan A code in the repo (git history + feature branch); Plan B does not
delete it — just restore old UI + endpoint wiring, add ATS chips.

## 7. Files touched (when activated)

- Restore: `src/components/ScraperBar.tsx` (from 33d14b9~1), `src/constants/sources.ts` (from 33d14b9~1), `src/App.tsx` handleScrape (V1 response shape)
- Modify: `server/scraper/scraperFactory.ts` (SantaMaria branch), `src/types.ts` (JobSource union + ATS sources)
- Keep: `server/providers/santaMariaProvider.ts`, `searchBudget.ts` (budget), `company_career_sites` (registry seed), `server.ts` POST /api/jobs/scrape
- Tests: existing 102 + new: ATS chip → SantaMaria queries filtered by platform; per-source LIMIT respected; budget never 500.