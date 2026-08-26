# Changelog

## v1.9.10 (2026-08-26)

### 🐛 Fixes
- **install.ps1: "Test-Path : A parameter cannot be found that matches parameter name 'and'"** — two `Test-Path $x -and -not (Test-Path $y)` expressions were invalid PowerShell (`-and` parsed as a Test-Path parameter). Parenthesized both operands; the error no longer prints on every install.
- **update.ps1: silent no-op update when git is missing** — the script called bare `git`, which failed with "git is not recognized" on terminals where git is not on PATH, yet still printed "OK Code updated" and rebuilt from the OLD code. The updater now refreshes PATH, locates git.exe (same lookup as the installer), and **fails loudly** if git is not found — no more fake success.
## v1.9.9 (2026-08-26)

### 🐛 Fix: repeat searches never found new jobs
- **"Scraped N live postings! (All N were already in your job list)" on every search — fixed.** The direct-API provider always picked the SAME 8 company boards, so re-searching returned the same jobs every time and the list never grew.
- Board selection now **rotates per search** (priority boards always included, tail advances ~1 board per 15s, wraps through all 41k companies). Each search explores new boards and surfaces genuinely new postings.
- Verified live: repeated search went from 0 new → **6 new jobs added** from fresh boards.

## v1.9.8 (2026-08-26)

### 🐛 Critical fix: multi-account job isolation
- **Fixed: account B searching jobs account A already saved got "already in your job list" with an empty list.** The jobs table used a GLOBAL primary key on id, so the second account's insert was silently rejected at the DB level.
- Rebuilt jobs table with **composite PK (user_id, id)** — every account now owns its own copy of each job. Migration runs automatically on boot (existing DBs upgraded in place).
- Verified live in the UI: fresh Admin account searched Greenhouse/Ashby/Lever → **38 jobs added** (previously 0 with "already exist").

## v1.9.7 (2026-08-26)

### ⚡ Major: Free-API ATS search — zero Apify credits
- **Greenhouse, Lever, Ashby now fetch directly from their FREE public job APIs** (boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com) — no Apify actor, no credits, no monthly-limit surprises. This is the fix for the "Greenhouse returns nothing" reports: your Apify account had hit its monthly usage cap, and the actor was blocking the search.
- SmartRecruiters stays on the Santa Maria actor (its public API tenant slugs differ from careers-site slugs — the open directory lists stale slugs).
- Direct path reuses the full pipeline: priority boards + rotation, keyword relevance, posted-window, dedup.
- **Real failure reasons now surface in the UI** — a source that errors shows "Greenhouse: <reason>" instead of the misleading "No results found in the selected window".
- Santa Maria run failures (ABORTED/TIMED-OUT) retry up to 2x with a rotated board slice.

## v1.9.6 (2026-08-26)

### 🐛 Fixes
- **Greenhouse/ATS "No results" with default filters — fixed.** The Santa Maria provider never mapped the actor's posting timestamp, so ATS jobs fell back to a synthetic scrape-time date; the 24h posted-window guard then dropped them all. The provider now maps `posted_at`/`published_at`/`updated_at` and returns newest-first, so a "Last 24 hours" search surfaces real fresh postings.

### ✨ UI
- **Removed the ✓ checkmark from source chips** — selection is shown by the filled brand-colored chip itself.

## v1.9.5 (2026-08-26)

### ✨ Enhancements
- **Source chips show official career-portal counts** — every ATS chip now displays the number of company boards in the registry (e.g. Greenhouse 6,032, Workable 4,752, Ashby 3,450) via the new /api/ats/company-counts endpoint.
- **Sources ordered by popularity** — active ATS sorted by portal count (desc), locked ATS grouped at the end (also by count).
- Jobvite chip now reports its real count (92 portals).

## v1.9.4 (2026-08-26)

### ✨ UI
- **Removed RemoteOK and WeWorkRemotely** from the source chips (they were "coming soon" placeholders). 32 portal chips remain, locked ATS still grouped at the end.

## v1.9.3 (2026-08-26)

### ✨ UI
- **All sources shown directly in the row** — the "More" dropdown is gone. Every portal chip (LinkedIn → Join, ATS + built-in) is now visible at once and wraps to fit.
- **Locked ATS grouped at the end** of the source row (Workday, Teamtailor, Personio, BambooHR, Rippling, JazzHR, Recruitee, iCIMS, Jobvite, Pinpoint — all 🔒).

## v1.9.2 (2026-08-26)

### 🧹 Cleanup
- **Removed dead auto-apply scaffolding** (server/ats/browser.ts, detector.ts, queue.ts, adapters/, types.ts, shims.d.ts) — zero callers, Playwright not even installed; it type-checked only via a fake shim. The real ATS scraping path (Santa Maria provider + registry) is untouched.
- **Removed unused providerCapabilities.ts** (zero callers).
- **Source chips show portal names only** — the "Apify" badge is gone; chips are just Greenhouse, Lever, Ashby, … with the 🔒 badge for locked ATS.

## v1.9.1 (2026-08-26)

### 🔒 Locked (paid/enterprise-only ATS)
- **BambooHR, Workday, iCIMS, JazzHR, Jobvite, Personio, Recruitee, Rippling, Pinpoint, Teamtailor** are now locked — their APIs require a paid plan or enterprise agreement, so they are disabled until a free access route exists.
- UI: chips show a 🔒 badge, are non-clickable, and tooltips explain the lock. Settings lists them as locked.
- Server-side enforcement: requesting a locked source spends **zero Apify credits** — it is skipped with a clear reason shown in the search result.
- **Active ATS (free public APIs):** Greenhouse, Lever, Ashby, SmartRecruiters, Workable.

## v1.9.0 (2026-08-26)

### ✨ Enhancements
- **Full official ATS company coverage — no more guessing.** Replaced hand-typed company lists with the community-maintained official dataset (kalil0321/ats-scrapers): **41,255 career sites** across all 15 ATS — Greenhouse 6,032, BambooHR 5,632, Workable 4,752, Workday 3,530, Ashby 3,448, SmartRecruiters 2,747, JazzHR 2,689, Lever 2,402, iCIMS 2,498, Personio 2,463, Rippling 1,923, Teamtailor 1,464, Recruitee 1,164, Pinpoint 406, Jobvite 92. Every slug comes from a real ATS career URL — no hand-guessing, no 404s.
- **Smart search coverage:** Each search always checks your platform's priority boards (Stripe/GitLab/MongoDB/Twilio on Greenhouse, Palantir/Kraken on Lever, OpenAI/Notion/Linear on Ashby, Amazon/Airbnb on SmartRecruiters, Vercel/Asana/OpenAI on BambooHR, Shopify/Uber on Teamtailor, Slack on Workday) **plus** a rotating slice of the remaining companies (advances every 30 min), so repeated searches gradually cover every company on every ATS.
- **Generic seeder** (`server/ats/seedCompanies.ts`): imports any company-list JSON from `server/ats/data/` into the registry — idempotent (INSERT OR IGNORE), existing installs upgrade automatically.

## v1.8.8 (2026-08-19)

### 🐛 Fixes
- **Installers now recover from a stale/partial `tailor-cv` folder:** If a previous run left a non-empty folder without `docker-compose.yml` (e.g. a failed clone or an interrupted install), `git clone` refused with "destination path already exists and is not an empty directory". Both `install.ps1` (Windows) and `install.sh` (macOS/Linux) now detect that state, **back up `config.ini` (API keys), clean the stale folder, clone fresh, and restore your keys** — no manual deletion needed.

## v1.8.7 (2026-08-19)

### 🐛 Fixes
- **Windows installer (install.ps1) — no more "docker/git not recognized" after install:** The installer now refreshes the PATH in the same session after installing Docker Desktop and Git, locates `docker.exe` / `git.exe` by their real install paths (not just PATH), and retries the git install elevated if winget fails. Previously, on fresh machines (no Docker, no Git), the script claimed "Docker engine ready" while `docker`/`git` were not on PATH, then failed at `git clone`. Now it installs, refreshes PATH, finds the executables, and continues — no logout/restart needed mid-install.
- **Windows installer no longer false-positives on `$LASTEXITCODE`:** `Test-DockerEngine` and the compose check now invoke the located `docker.exe` explicitly (a missing command no longer masquerades as a successful check).

## v1.8.6 (2026-08-19)

### ✨ Enhancement
- **Master CV — Contact Information now includes Designation:** Added **Designation** input to Contact Information (alongside Full Name, Email, Phone, Location, Portfolio, LinkedIn, GitHub). It prefills from Master CV and flows through Manual JD Preview and PDF generation (as `targetRole`).

## v1.8.4 (2026-08-19)

### ✨ Enhancement
- **Master CV — Skills are now draggable:** Skill categories in the Master CV editor can be reordered via drag-and-drop (grip handle, same as Projects / Experience / Certifications), so you can prioritize your strongest skills at the top.

## v1.8.3 (2026-08-19)

### 🐛 Fixes
- **Manual JD — contact links now prefilled from Master CV:** Portfolio (website), LinkedIn, and GitHub are carried through the Manual JD Preview editor (`editableCv ↔ editorShape`), so the Preview shows the links you saved in Master CV instead of empty fields.
- **Manual JD — PDF names include role & company:** Downloads are now `Atanu_Biswas_DevSecOps_Stripe_CV.pdf` (candidate + role + company from Stage 1) instead of `Atanu_Biswas_edited.pdf`. Both the token download and the edited Preview download use the same pattern, with server `Content-Disposition` aligned.

## v1.8.2 (2026-08-19)

### ✨ Features
- **Update check now runs every 30 minutes while the app is open** (previously only on app open) — even a user who keeps the dashboard open for hours sees the "New version available" banner within half an hour of a push. The **Update & Restart** button does the whole update automatically (pull → reinstall deps if needed → restart), no terminal needed.

## v1.8.1 (2026-08-19)

### 🐛 Fixes
- **User menu footer shows the real installed version** (was hardcoded "v1.2.0" since that release). It now reads the actual app version from the server (e.g. "v1.8.1 · local").

## v1.8.0 (2026-08-19)

### ✨ Features
- **One-click auto-update.** The update banner now has a real **"Update & Restart"** button: the app pulls the latest `main` from GitHub itself, reinstalls dependencies when the lockfile changed, and restarts automatically (~15–30 s, data untouched). No terminal commands anymore.
- Installs now mount the live source (`docker-compose` volume) + `git` inside the image; `restart: unless-stopped` brings the app back on the new code.

### ⚠️ Known Issues
- Auto-update only works on **git-checkout installs** (the standard install). Installations without git fall back to the manual instructions shown in the banner.

### 🔄 Breaking Changes
- **One-time re-install required** to enable auto-update on existing installs (the compose mounts changed): `git pull && docker compose build && docker compose up -d` once. After that, every future release is one click inside the app.

### 📦 How to Update
- New installs: run your installer once — updates are one click in the app from then on.
- Existing installs: `git pull && docker compose build && docker compose up -d` ONCE, then the "Update & Restart" button takes over for all future versions.

## v1.7.3 (2026-08-19)

### ✨ Features
- **Recruiters** — "Manual Email" button renamed to **Create Email** and the contact counter next to it removed for a cleaner header.

## v1.7.2 (2026-08-19)

### 🐛 Fixes
- **Recruiters — manual email**: the button is back to its clear "Master CV" label (it briefly showed the CV filename instead); clicking it still attaches the CV, and the attachment chip shows the CV's real name (e.g. `Atanu_Biswas_DevSecOps_SRE_CV.pdf`).

## v1.7.1 (2026-08-19)

### 🐛 Fixes
- **Recruiters — manual email**: the "Master CV" button and the attachment chip now show the CV's real name (the PDF name you set on the Master CV screen, e.g. `Atanu_Biswas_DevSecOps_SRE_CV.pdf`) instead of the generic "Master CV" label. Previously the name was only loaded when composing to a specific contact, so the manual compose path fell back to the literal "Master CV".

## v1.7.0 (2026-08-19)

### ✨ Features
- **Update checker — the app now tells installed users when a new version is pushed.** On every app open the dashboard polls GitHub (`/api/update-check`) and shows a dismissible banner: "New version vX is available — pull the update", with a direct link to the repo. No webhooks needed (self-hosted Docker installs have no public inbound URL), installs simply compare their installed version against the latest pushed `package.json`.
- **LinkedIn Posts — results stay on the search screen only.** Searches no longer dump anything into the dashboard job list; each post gets an explicit "Save to my job list" button (idempotent, shows "Saved ✓").
- **LinkedIn Posts — search history persists server-side** (`lp_history` table in the app's SQLite, per user): results stay on the screen across refresh, closing the screen, or switching devices — grouped by date with a "Clear" action.
- **Back from any screen now shows FRESH data**: the dashboard re-fetches jobs + stats from the server and resets to page 1 (newly saved posts, scraped jobs and updated scores are always visible; never a stale in-memory view).

### 🐛 Fixes
- LinkedIn Posts results no longer vanish when leaving and reopening the screen (was: in-browser storage only).
- Removed the Scrapling engine completely (per-product decision) — the Free engine is the only active path; the Apify engine remains locked as "coming soon".

### ⚠️ Known Issues
- The update banner only appears after the app's server can reach `raw.githubusercontent.com` (no change in behavior offline — it just stays silent).
- Update banners are per-install dismissed; a new pushed version re-shows the banner.

### 🔄 Breaking Changes
- The Scrapling engine option is gone from the LinkedIn Posts screen (Free engine only).

### 📦 How to Update
- If the app shows the update banner (or you want the latest): `git pull && docker compose build && docker compose up -d` — data is untouched.

## v1.6.0 (2026-08-17)

### ✨ Features
- **Manual JD restructured to 3 steps** (Add JD → Analyze → Preview): Tailor + Review merged into Preview; "Generate Tailor CV" button; ATS score card (before→after, skills added, bullets rewritten, skipped) at the top of the Preview editor.
- **Preview editor now reuses the exact Master CV editor** (shared `MasterCvEditor` component): Contact Information, Master Professional Summary + ✦ Ask AI, Work Experience (Position #N cards, drag), Education, Technical Skills with comma/Enter TagInput + suggestions + Add Skill Category, Featured Projects, Certifications, Skill Gaps. AI-added items are labeled with `✦ AI` badges; upload banner and Skill Gaps are hidden in the Manual JD Preview.
- **Compact segmented stage navigation** in the Manual JD header (Add JD → Analyze → Preview) + full-bleed left/right split.
- **Dedicated URLs for every screen** via react-router: `/settings`, `/recruiters`, `/master-cv`, `/manual-jd`, `/job-portals`, `/ai-interview`, `/linkedin-posts`. Reload or a shared link lands back on the SAME screen (was: always the dashboard); Back returns home; unknown paths redirect to `/`.
- **LinkedIn Posts free search now works** (research-driven): Google News RSS primary (synthetic posts from full post titles + date), r.jina.ai render proxy for DuckDuckGo/Bing, LinkedIn public company-home discovery, direct-engine fallbacks. Verified live: 12 real job posts per search, no token/cookie.
- **LinkedIn Posts Apify engine locked** (shown as "coming soon") — free engine is the active path; Apify + daily quota kept intact for later unlock.

### 🐛 Fixes
- Manual JD: Preview fully scrollable (score card no longer pinned); drag-and-drop reordering uses the same proven mechanism as the Master CV editor; bullet AI-tagging by content comparison vs the original Master CV (catches AI-added AND rewritten bullets); fixed a crash on opening the screen (hooks order).
- LinkedIn Posts: lnkd.in links resolve via GET + interstitial extraction (HEAD returned 403); guest post author/date/apply-link parsing fixed (og:title " | " split, JSON-LD `datePublished`, links from text).
- Manual JD: removed footer copyright; compare tags renamed "Master CV" / "Tailored CV"; AI tag moved to the left of bullet points.

### ⚠️ Known Issues
- Free LinkedIn Posts carry full text + date; live apply links appear only when the source exposes a direct URL or text link (Google News truncates titles).
- Nothing from a datacenter IP is 100% reliable for free engine search — the 7-engine redundancy is the mitigation.

### 🔄 Breaking Changes
- URL routes changed (screens now have dedicated paths); old bookmark to the dashboard root still works.

### 📦 How to Update
- Re-run your platform installer (install.sh / install.bat / the PowerShell one-liner) — data is untouched.

## v1.5.0 (2026-08-16)

### ✨ Features
- 

### 🐛 Fixes
- 

### ⚠️ Known Issues
- 

### 🔄 Breaking Changes
- None.

### 📦 How to Update
- Re-run your platform installer (install.sh / install.bat / the PowerShell one-liner) — data is untouched.


## v1.4.0 (2026-08-12)

### 🎨 Professional UI redesign — whitish multi-tint theme
- The whole app now speaks one design language: **whitish canvas + soft pastel multi-tint accents** (blue/sky/indigo/violet/emerald/teal/amber/orange/rose), with brand blue `#2563EB` as the primary. The old flat-indigo look is gone everywhere.
- Design tokens centralized in `@theme` (neutral `#F9FAFB`, warm whites `#FAFAF9`/`#F1F5F9`); **Plus Jakarta Sans** type and **Phosphor icons** kept from the previous iteration.
- Converted screens: Dashboard, Login, Manual JD, Master CV, Recruiters, Job Portals, Job Detail, Settings, Navbar, ScraperBar — functionality untouched.
- **KPI cards** now have real white cards with soft pastel tints (blue/violet/emerald/amber/sky) — fixed the blank-card bug.
- **Per-source job tag colors** (LinkedIn blue, Indeed sky, Glassdoor emerald, Naukri amber, Upwork teal, Arbeitnow orange, others slate).

### 🔐 Login screen
- Whitish brand panel with the 4 feature highlights (19 live sources, one-click tailoring, recruiters + cold email, local-first data).
- **Animated left panel**: office photo with slow Ken-Burns zoom, floating CV card with an ATS score ring animating to 97%, a recruiter chat (bubbles fade in + typing dots), and drifting stat chips — all over soft pastel blobs.
- Everything fits **on one screen** — no scrolling on any laptop size (features in a 2-column grid, scene flexes, `max-height: 700px` fallback, `prefers-reduced-motion` respected).

### ⚙️ Settings & fixes
- Settings redesign shipped with sidebar (Account / Security / Integrations) and LLM·Apify·Email sub-tabs; scoped `--st-*` palette.
- **Open Master CV** from Settings now closes the modal first (was hidden behind the overlay).
- **Replay tutorial** button removed from Settings (the tour stays in the account menu).

## v1.3.0 (2026-08-09)

### 🎨 Manual JD polish (carried in this release)
- Tailoring Updates panel is now a compact dashboard: Impact cards (with before→after score bar), added-skills chip cloud, rewritten bullets showing **BEFORE (struck) → AFTER** text, "What's preserved" row, collapsible review list, and a single auto-saving Download button.
- Analysis panel always shows the honest current-CV score; the boosted score lives on the Tailor screen as `49% → 97%`.
- History restore fixed: the API returns `{ analysis, downloadToken }` with camelCase fields — the UI now unwraps it (previously restored records showed empty results).
- Stepper (Add JD → Analysis → Tailor) is centered; skill chips are deduplicated (`patching ×3`) and capped with "+N more".

## v1.2.0 (2026-08-04)

### ✨ AI CV Compression Assistant (Master CV)
- **AI Compress button** in the Master CV screen — analyzes your CV against **live market data** (keywords extracted from your recent scraped jobs for the target role) and compresses it to the industry-standard 1–2 pages.
- **3-phase engine**: Analyze (per-bullet guidance with reasons) → Rewrite (tightens & merges without losing meaning, weaves market keywords in) → Verify (deterministic keyword-preservation scan, stopword-filtered with word-boundary matching).
- **Uses your BYOK key**: same provider/model from Settings — nothing extra to configure.
- **Single-screen result**: hero outcome card (pages 3→2, % word reduction, market keywords added), a minimal "What changes" list (Tightened / Merged / Kept + reason), then side-by-side **Original (left) vs New CV (right)** at full width — pages auto-scale to fill the lane.
- **Apply** replaces the master CV after an automatic backup; **Versions** drawer restores any backup with one click; a confirmation modal shows before/after stats before applying.
- **Download new CV** (PDF) directly from the result view.

### 🖥️ Master CV screen polish
- Full-screen split editor with a **live, page-wise PDF preview** — content flows onto real A4 pages exactly like the downloaded PDF (headers never orphaned; repaginates as you type).
- Clean header: Back · Save (split button with Download PDF dropdown) · Versions; **AI Compress + PDF rename** live in the preview toolbar.
- Contact links in the preview now show **LinkedIn / GitHub / Portfolio** labels with hyperlinks instead of raw URLs.

### ⚡ Performance & reliability
- **No more global UI lock**: match/tailor processing no longer freezes the app — pagination, filters, deletes, and downloads stay live while jobs process in the background.
- **Batch match & tailor run 3 jobs concurrently** instead of one-by-one (up to ~3× faster batches).
- **Manual JD history**: every analysis is saved per user (SQLite) — restore any past analysis or its tailored CV anytime; history survives restarts.
- Manual JD redesigned: fixed input panel on the left, all insights (score ring, skill chips with why-tooltips, recommendations, tailoring diff with before→after bullet rewrites) on the right.
- **Back button** on all full-screen views (Manual JD, Master CV) — no more browser-history surprises.

### 🐛 Fixes
- `&amp;` literal text in PDF section titles.
- React hooks violation (hooks after early return) that crashed the Master CV screen on close.
- API-key audit advisories: undici + postcss updated (0 vulnerabilities).
- Applicant counts, jobType/under10Applicants param forwarding, and scraper fixes carried forward.

## v1.1.0 (2026-08-03)

### 🔐 Local Accounts & Data Isolation
- **Local sign-in**: create accounts with email + password (scrypt-hashed), or use password-less **guest accounts** (Guest 1, Guest 2…).
- **Per-account isolation**: every account has its own CV, job list, match history, and applied tracker. No more shared "one profile for everyone".
- **Cookie sessions**: httpOnly session cookie per browser, resolved per request — each person on the same machine sees only their own data.
- **One-click guest sign-in**: existing guests are listed on the login screen so switching accounts takes one click.
- **Safe migration**: existing installations are migrated automatically — your old jobs and CV are claimed by a new `Admin` guest account; nothing is lost.

### 🌍 Country-Specific Job Portals (6 new sources)
- **MyCareersFuture** 🇸🇬 Singapore (official government API)
- **Cutshort** 🇮🇳 India
- **Gupy** 🇧🇷 Brazil
- **JobsCh** 🇨🇭 Switzerland
- **Daijob** 🇯🇵 Japan
- **MyJobMag** 🇳🇬 Nigeria
- Source pills show country flags so you can spot regional postings at a glance.
- Greenhouse & Lever company-portal scrapers removed; RemoteOK / WeWorkRemotely parked as "Coming soon".

### 👥 Applicant Counts
- LinkedIn jobs now display **how many people applied** ("200 applicants") right in the listing and job detail — gauge competition without opening the posting.
- Parsed from the job page at scrape time (no extra requests); only shown when the source exposes the number.

### 💾 Real SQLite Storage
- Replaced JSON file storage with **SQLite (`better-sqlite3`)** — WAL mode, crash-safe, faster at scale.
- Legacy JSON data auto-imported on first run.
- **Server-side pagination**: list + stats (`/api/jobs/stats`) moved to the server; large job lists load in pages instead of all-at-once.

### 🎨 Professional Navbar
- Four items (guest chip, Manual JD, Master CV, Settings) consolidated into **one account menu** — avatar pill with dropdown: user card, Workspace (Master CV, Manual JD ⌘J), System (Settings ⌘,), Sign out.
- Duplicate metrics badge removed from the app bar (dashboard KPIs are the single source).
- Keyboard shortcuts: **⌘J** = Manual JD, **⌘,** = Settings.

### 🖱️ UX Improvements
- **Drag-and-drop reordering** for Work Experience, Projects, Certifications in the Master CV drawer.
- **Add-to-top** default for new Experience / Education / Skills / Projects / Certifications entries.
- Reliable **Download CV** (programmatic click survives re-renders during tailoring).
- Master CV form no longer wipes in-progress edits on background refreshes.

### 🐛 Fixes
- `jobType` / `under10Applicants` params were dropped by the scrape route — now forwarded correctly.
- Arbeitnow term matching (e.g. "DevOps Engineer" now returns results).
- MyJobMag date parsing regex; Cutshort slug→role mapping + 30s timeout + hybrid classification.

## v1.0.1 (2026-07-30)

### New Scrapers
- Added **RemoteOK** — free API, 100 latest remote jobs with no keyword restrictions
- Added **WeWorkRemotely** — 6 tech categories (full-stack, frontend, backend, devops, design, product) via HTML scraping

### Tailoring Engine
- **Two-tier keyword placement**: missing keywords go into experience bullets (full weight) or skills section (half weight). No keyword left behind.
- **Honest scoring**: score reflects actual keyword fill ratio. Breakdown shows Already Matched + Newly Integrated + Still Missing.
- **Keyword verification**: every claimed keyword is scanned against the actual CV text. Only verifiably present keywords are displayed.
- **Candidate title preserved**: `targetRole` always comes from Master CV's first experience. Never replaced by job posting title.
- **Auto gap analysis**: clicking Tailor on an unscored job automatically runs match first.
- **Three-tier audit display**: ✓ Integrated in Experience, + Added to Skills, ✕ Could Not Be Added.

### UI / UX
- **Contextual search suggestions**: 7 domains (DevOps, Cybersecurity, Software, Data/AI, Design, Management, Database) with role + skill suggestions.
- **Loading tooltips**: hover over Score/Tailor buttons during processing to see step-by-step messages.
- **Copy JD button**: copies full job description with clipboard fallback.
- **PDF-only downloads**: DOCX format removed.
- **Score badge clickable**: opens directly to tailored audit view.
- **Applied jobs tracker**: manual toggle per job, green card border, applied filter tab, navbar count, dashboard KPI.
- **Ask AI**: AI-generated summary suggestions in Master CV drawer (3 options with different tones).

### LinkedIn Fixes
- `f_WT=2` filter for remote-only job postings.
- Date filter now strictly respects selection (removed fallback that bypassed filter).
- Detail fetch delay reduced from 3-8s to 0.8-2s per job.
- `jobType` hardcoded to `Full-time · Remote` (since `f_WT=2` guarantees remote).
- "Show more" / "Show less" text stripped from descriptions.

### CI/CD
- **Gated pipeline**: gitleaks → npm audit → Trivy → Build. Security failures stop the pipeline.
- **Auto-release on every push**: executables + Docker image published automatically.
- Exception management via `.trivyignore` and `.npm-audit-allowlist`.
- Docker image at `ghcr.io/atanub707/ats-free-cvs:latest` and `:v1.0.1`.
- Step summaries for security scan results in Actions tab.

### Bug Fixes
- Scrape handler calling removed `runWithPopup` (caused infinite loading).
- JobCard memo comparison using wrong prop name (loading state never updated).
- Copy button navigating away due to missing `type="button"`.
- Separate score/tailor message state so each button shows its own independent tooltip.
- `config.ini` removed from git tracking (API key was exposed).

## v1.0.0 (2026-07-28)

- Initial release with LinkedIn, Arbeitnow, SimplyHired, Dice, Reed, Greenhouse, Lever scrapers.
- AI gap analysis + CV tailoring using multiple LLM providers.
- DOCX and PDF export.
- Docker + standalone executables for Linux, macOS, Windows.
