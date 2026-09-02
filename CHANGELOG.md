# Changelog

## v2.8.0 (2026-09-01)

### ⚡ Enhanced Tailoring (new)

- New Enhanced mode with a bounded 30% embellishment budget: metrics derived
  from real numbers, one-hop-adjacent tools, and leadership/scope language
  from real signals — each flagged as "Enhanced" in the preview and listed in
  the audit panel with its source basis.
- Strict mode (previous behavior) remains available per job.
- Employers, titles, dates, education, certifications and projects are NEVER
  changed in either mode.

## v2.7.2 (2026-09-01)

### 🖥️ UI reliability fixes

- **Tailor updates cards live**: the app now runs in production mode (no Vite dev middleware / HMR client). The Tailor button's result appears in-place — no more "it did nothing" until a manual reload. (Fix: inverted HMR toggle + NODE_ENV=production.)
- **Job modal always shows the authoritative CV**: opening any job refetches the server copy, so Skills/Projects/Education/Certifications can never render a stale in-memory version again.

## v2.7.1 (2026-09-01)

### 🔧 Tailored Resumes now match the Master CV

- **Skills grouped into Master CV categories**: Tailored resumes previously rendered a single flat "Skills:" blob; they now render the same grouped category blocks as the Master CV preview (Cloud & DevOps, Languages, Core Competencies, ... — no LLM involved, deterministic re-grouping).
- **All projects guaranteed**: the drafter could omit projects (e.g. 2 of 4). Every Master CV project (Tailor AI, Expenzee AI, POS, Netflix DevSecOps Pipeline) is now deterministically appended — the Tailored Resume's Project section always matches your Master CV.
- Boot backfill repairs every existing tailored CV (runs per-user against the correct Master CV).

## v2.7.0 (2026-09-01)

### 🤖 CV extraction is now model-agnostic

- CV upload/paste extraction previously broke with every model: raw `JSON.parse` could not read fenced model replies, so both minimax-m3 and deepseek-v4-flash silently fell back to a crude regex parser (hardcoded "Senior Engineer / IT Specialist", location "Remote", empty LinkedIn/GitHub).
- The parser now uses the proven `askJson` pipeline (markers + JSON repair cascade + bounded retry) — any model in the catalog extracts correctly.
- `designation` added to the extraction schema (was never extractable).
- The fallback parser no longer fabricates values — empty fields stay empty.
- The success banner is field-aware: shows exactly which fields were extracted.

### 🎯 Tailored CV scores are real per-job values

- V2-tailored CVs were missing the audit metadata the UI reads, so every card showed the hard-coded 92% fallback. Tailored CVs now carry their own before/after score, keyword incorporation and contact block (header renders correctly in preview + download).
- Existing tailored CVs were backfilled deterministically (no LLM).

### ✉️ Human, short outreach emails

- Drafted emails are 60-90 words, sell your level with one real number, mention projects in one passing clause, and ban em/en dashes (prompt + deterministic strip).

### 📧 SMTP send auto-corrects SSL vs STARTTLS

- Port 465 = SSL, 587/25 = STARTTLS decided deterministically; a mismatched toggle no longer blocks sending ("wrong version number" error) — retries with the flipped mode.

### 🧭 Settings in the hamburger

- Settings is now reachable from the hamburger drawer (and still from the account menu + ⌘,).

## v2.6.0 (2026-08-31)

### 🗑️ Deleted jobs stay deleted

- Removed jobs never reappear: every search now filters out per-user hidden jobs, so a deleted job (from any source — job boards, Greenhouse, Lever, Ashby) cannot re-enter your list on a new search.
- Remove shows a 6-second "Removed — it won't appear in new searches" toast with Undo (undo un-hides for a future search without re-adding to the current list).
- Clear All also resets the hidden list for a true fresh start.

## v2.5.0 (2026-08-31)

### 🧹 Removed

- **Applications screen removed** — `/applications` UI and drawer deleted; the Applied button is now a simple status toggle (mark applied → green, no navigation, no tracker).
- Redirect guard hardened: stale/unknown URLs (including `/applications`) now land on Home without a React hooks-order crash.
- Server-side application APIs remain (untested UI consumers only).

## v2.4.3 (2026-08-30)

### 📋 Applications redesign

- Rebuilt the Applications screen to the approved mockup: overview stat tiles (All / Action Required / Waiting / Applied), pill filter tabs with counts, search + sort controls, grouped application cards with color status rails, provider chips, status pills, one primary action per status, options button, and a friendly empty state with CTA.
- **Applied toggle moves across** — clicking "Applied" on a job card marks it and after 3 seconds creates the tracker entry (no LLM) and navigates to Applications, where it appears as an Applied row.
- Fixed: plan-less applications ignored the manual confirmation event and stayed "Preparing" — manual applied records now resolve correctly.

### ⚙️ Settings & UI cleanups

- Settings moved into the account menu (guest chip) with the ⌘, shortcut intact; ⌘ symbols removed from the drawer.
- Apify integration trimmed (toggle + token only, referral restored) — li_at cookie and price list removed.
- Browser Companion / Data & privacy / Application Accounts / Email Connections panels removed from Settings.
- Master CV: AI compress removed; Save + Download PDF moved to the right toolbar after the PDF-name field.
- Job cards: uniform 38px buttons, ATS pill inline left of Re-Tailor, Tailored/Matched badges and skill chips removed, View button dropped (title opens details), Applied toggle turns green.

### 🧠 Model-agnostic AI pipeline

- New askJson pipeline (markers + JSON repair cascade + bounded retry) used by Tailor, Score, CV Compressor and email drafting — any model (minimax, kimi, qwen…) works without per-model fixes.
- /api/emails/draft now drafts successfully (was plain JSON.parse → "Failed to draft email").
- Live model catalog in Settings (auto-updates, Free/New pills, refresh); 4-minute LLM budget with peak-hour guidance.

## v2.4.2 (2026-08-30)

### 🎯 Tailor & Matching

- **Tailor V1 is back** — the real Tailor CV button on every job card (Tailor/Re-Tailor), the `Tailored ATS` score pill (before → after + boost badge), Download CV, and the live stage tooltip (✓/⟳) while tailoring.
- **Model-agnostic AI pipeline (`askJson`)** — pick ANY model from the live catalog; reasoning-model quirks (`<thinking>` wrappers, unquoted keys, prose, trailing commas, `[...]` placeholders) are automatically repaired with a bounded retry. No per-model crashes.
- **Live model catalog** — Settings pulls the provider's real model list (auto-updates, Free/New pills, Refresh button); timeout explanations and a 4-minute LLM budget.
- Robust resume attachment names (FullName_Role_Company_CV.pdf) and honest JD-less handling.

### 🧹 UI Cleanups

- Uniform 38px buttons on job cards (icon-only bin 38×38), `Applied` toggles green in place, Apply links directly to the job post.
- Master CV: AI Compress removed; Save + Download PDF moved to the right toolbar after the rename field.
- Candidate Profile: autosave (no Save button), Sensitive/Login cards removed.
- Settings: Browser Companion + Data & privacy + Application Accounts + Email Connections panels removed.

### 🧰 Robustness

- ATS index schedulers verified healthy (308k+ jobs cycling every 60s); search guidance for empty keywords; JSON extraction cascade (fences, thinking blocks, balanced-brace fallback, non-whitespace/position repairs).

## v2.4.0 (2026-08-29)

### 🧭 Simpler Job Workflow

- Simplified job cards around **View, Apply**, and a compact secondary menu.
- Removed duplicate and implementation-specific workflow controls from the card surface.
- Consolidated resume tailoring behind a single **Tailor Resume** experience — one action, one pipeline, with every claim verified against your Master CV.
- Removed internal engine terminology from the normal interface.
- Application preparation now happens behind the main **Apply** workflow — no manual staging steps.
- Moved low-frequency actions (open original job, mark as applied, download tailored resume, remove job) into the overflow menu; removal now asks for confirmation.
- Improved job-card responsiveness and action hierarchy.

### Match & Fit

- Clarified the two matching concepts so they are easy to tell apart:
  - **Candidate Fit** — how well you (profile + CV) suit the job; computed locally and instantly on the job card.
  - **Resume Match** — how well your resume aligns with the job description; available on demand in Job Details with your own API key.
- No fake scores: nothing is shown as a percentage until it has actually been calculated.

### Safety

- Existing application safety checkpoints remain unchanged.
- CAPTCHA, login, MFA, OTP, consent, and required questions remain user-controlled.
- Final job submission remains user-triggered.

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