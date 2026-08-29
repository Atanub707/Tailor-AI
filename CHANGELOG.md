# Changelog

## v2.3.0 (2026-08-29)

### 🧭 Job discovery experience

- Simplified job cards around **Match, View, and Apply**.
- Consolidated Score and Fit into a clearer **Match** experience — a compact `% Match` indicator opens the full match analysis (strengths, gaps, blockers) with no misleading placeholders.
- Moved secondary actions (open original job, mark as applied, download tailored resume, remove job) into a compact **overflow menu**.
- Removed internal workflow terminology from normal job cards: `ATS Score`, `Tailor V2`, `Prepare Application`, `Prepare for Application`, standalone `Mark Applied`, and standalone `Delete` are gone from the card surface.
- **Apply** now acts as the main entry point into Tailor AI's existing application-preparation workflow (package → approval → Browser Companion → human checkpoints → your final submission).
- Job details now speak product language: **Tailored Resume**, **Tailor Resume**, and **Match Analysis**.
- Improved responsive behavior for job cards — no nine-button rows, no horizontal scrolling.

## v2.2.0 (2026-08-29)

### ✨ Application Automation
- Added **Browser Companion** application assistance: the extension pairs with your local Tailor AI, opens the exact employer application page, verifies it, validates the whole form before filling anything, and fills only approved answers.
- Added guided application support for **Lever, Greenhouse, and Ashby**.
- Added **exact tailored-resume attachment** — the immutable package-bound PDF, never regenerated.
- Added **human checkpoints** for CAPTCHA and verification steps — Tailor AI never solves CAPTCHAs; you complete security steps on the real page.
- Final provider submission remains **user-triggered**; Tailor AI tracks confirmation and reports Applied / Check Submission honestly.

### 🔐 Application Security
- Added an **encrypted local credential vault** (AES-256-GCM, local key, ciphertext only).
- Added a dedicated **Application Password** for future ATS account creation — never your email or banking password.
- **Existing ATS passwords are never stored** by Tailor AI.
- Browser Companion secrets remain local and short-lived.

### 📬 Application Tracking
- Added application status intelligence foundation: Gmail and Microsoft mailbox connector architecture, plus deterministic recognition of confirmation, assessment, interview, rejection, and offer emails.
- Email data remains local (metadata only, no bodies).

### 🛡️ Safety & Privacy
- No automatic CAPTCHA solving.
- No proxy email identity; mail stays in your real inbox.
- No centralized applicant-data storage.
- No automatic use of OTP or MFA codes.

### 🏢 Providers
Application-assist providers: **Lever · Greenhouse · Ashby**.

## v2.1.1 (2026-08-27)

### 🐛 Fix: search no longer hides previous jobs
- Searching now ADDS jobs to the top of the full job list (previous behavior) instead of scoping the list to only the current search results. The search-context isolation remains server-side for cache/session identity; the All Jobs view always shows the complete stored library.

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