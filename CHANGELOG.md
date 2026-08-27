# Changelog

## v2.1.0 (2026-08-27)

### 🎯 Search: one source per search, honest limits

- **Exactly one source per search.** Clicking a source replaces the previous selection — no multi-source fan-out, no hidden sources. Enforced on both the UI and the backend (`POST /api/jobs/scrape` rejects 0 or >1 sources with "Select exactly one job source per search.").
- **LIMIT is the true total result count** — never multiplied across sources.
- **Removed broken/unavailable ATS sources from the UI.** Workable, Workday, BambooHR, JazzHR, iCIMS, Personio, Rippling, Teamtailor, Recruitee, Pinpoint, Jobvite, SmartRecruiters, Comeet and Join no longer appear as selectable chips — they had no working implementation and could not return jobs.
- **Greenhouse, Lever and Ashby use free direct ATS APIs** (no Apify token needed) with local query/relevance/date filtering; `first_published`/`createdAt`/`publishedAt` date semantics preserved.
- **Search results are isolated by query + source** — a "DevOps Engineer" search never mixes into a later "AI Engineer" search, and LinkedIn results never reuse a Naukri cache.
- **Relevance remains strict** — unrelated Sales/Data/Recruiting/PM roles cannot enter a DevOps search; a fully-irrelevant board returns zero results (nothing persisted).
- **Applied/Tailored/Ready history preserved and global.**
- **Removed unused Jobo/Santa Maria/FetchCat/watcher code** — smaller, cleaner codebase with zero references to abandoned experiments.
- **Free-scraper test coverage** — Arbeitnow, SimplyHired, Dice, Reed, MyCareersFuture, Cutshort, Gupy, JobsCh, Daijob and MyJobMag now have fixture-based parsing tests (keyword, LIMIT, malformed responses, zero live calls).

### ✅ Supported sources (18)

- **Paid (Apify):** LinkedIn, Indeed, Naukri, Glassdoor, Upwork — require your own Apify API token.
- **Free scrapers:** Arbeitnow, SimplyHired, Dice, Reed, MyCareersFuture, Cutshort, Gupy, JobsCh, Daijob, MyJobMag.
- **Direct ATS (free):** Greenhouse, Lever, Ashby — no Apify needed.

### 📝 Notes

- Paid sources (LinkedIn/Indeed/Naukri/Glassdoor/Upwork) need an Apify API token in Settings; without it they are skipped with a clear reason. All other sources work with no token.
- Auto-apply is not included in this release — Apply opens the original job posting.
- Free scrapers are verified against fixture data; runtime behavior depends on the source sites and is best-effort.