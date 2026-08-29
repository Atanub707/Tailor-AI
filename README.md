<p align="center">
  <img src="https://github.com/Atanub707/Tailor-AI/raw/main/media/screenshot.png" width="100%" alt="Tailor AI Dashboard"/>
</p>

<h1 align="center">Tailor AI</h1>

<p align="center">
  <strong>AI-powered job search & CV tailoring — 17+ sources, ATS scoring, and tailored CVs. Runs 100% on your machine.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Tailwind-4.x-06D6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4"/>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT"/>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome"/>
  <img src="https://img.shields.io/badge/Self--hosted-100%25_local-2563EB" alt="Self-hosted, 100% local"/>
  <img src="https://img.shields.io/badge/Auto--update-One--click-059669" alt="One-click auto-update"/>
</p>

---

## What is Tailor AI?

A self-hosted job-hunting tool that:

- **Scrapes job listings** from 17+ sources (LinkedIn, Indeed, Glassdoor, Upwork, Naukri + free built-ins: Arbeitnow, Dice, Reed, SimplyHired, RemoteOK, WeWorkRemotely, MyCareersFuture, Cutshort, Gupy, JobsCh, Daijob, MyJobMag, and more)
- **Scores jobs against your CV** with AI — match %, matching/missing skills, missing keywords, and recommendations
- **Tailors your CV** to any specific job description and exports an ATS-optimized PDF
- **Finds recruiter job posts** on LinkedIn in real time (free engine, no token needed)
- **Extracts recruiters** and drafts cold emails via your own SMTP
- **One-click updates** — the app checks GitHub itself (every 30 minutes while open) and shows an in-app "Update & Restart" button when a new version is released. No terminal, no commands.
- Keeps **everything local** — jobs, CV, history, and API keys never leave your machine

**Screens have dedicated URLs:** `/` dashboard · `/settings` · `/recruiters` · `/master-cv` · `/manual-jd` · `/job-portals` · `/ai-interview` · `/linkedin-posts` — reload and you stay where you were.

---

## 🎬 Demo

*Coming soon — a 30-second screen recording: search → score → tailor → download.*
*(Meanwhile: install it and try the live app in under 2 minutes below.)*

---

## Requirements

| Requirement | Notes |
|---|---|
| **Docker Desktop** | Recommended install path — signed, free, warning-free |
| **Node.js 18+** | Only for the developer/manual install |
| **LLM API key** | Required for ATS scoring & CV tailoring (bring your own) |
| **Apify token** (optional) | Only for LinkedIn/Indeed/Naukri/Glassdoor/Upwork sources |

---

## 🚀 Install (one command)

> 📖 Full guide: [scripts/HOW-TO-INSTALL.md](scripts/HOW-TO-INSTALL.md) — install, update, uninstall, troubleshooting.

### Quick command menu

Pick what you want to do, pick your OS, copy the command, paste it into **PowerShell** (Windows) or **Terminal** (macOS/Linux):

| What you want | Windows — PowerShell | macOS / Linux — Terminal |
|---|---|---|
| **Install** | `irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/install.ps1 \| iex` | `curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/install.sh \| bash` |
| **Update** | `irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/update.ps1 \| iex` | `curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/update.sh \| bash` |
| **Uninstall** | `irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/uninstall.ps1 \| iex` | `curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/uninstall.sh \| bash` |

> **Which terminal?** Windows users: open **PowerShell** (Start → type "PowerShell" → Enter). macOS/Linux users: open **Terminal**. Copy the command from the matching column and paste it — press Enter and the script runs.

**Windows — paste into PowerShell:**

```powershell
irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/install.ps1 | iex
```

**macOS / Linux — paste into Terminal:**

```bash
curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/install.sh | bash
```

The installer is **idempotent**: checks/installs Docker Desktop, starts the engine, downloads Tailor AI (git clone), and opens `http://localhost:3000`. Re-run it anytime — finished steps are skipped. No code-signing, no SmartScreen warnings.

**Start the app again later:** the app runs in Docker in the background, so there's no start command — after closing the tab or rebooting, just open **http://localhost:3000** once Docker Desktop is running (the app auto-starts with Docker).

## Applying to jobs (Assisted Apply)

1. Find a job in the Job Library.
2. Click **Apply** — Tailor AI prepares the application (no page reload).
3. The **Application Detail** opens: it shows the current state and the one
   next action (Start Application, Answer Questions, Continue, Ready to Submit…).
4. Tailor AI inspects the provider form (read-only), fills only verified
   information, and attaches your exact resume (a verified tailored version,
   or your Master CV when no tailored version exists yet).
5. Anything Tailor AI cannot answer stays **Action Required** for you:
   unknown questions, legal consent, EEO, CAPTCHA, login, MFA, OTP.
6. When everything supported is filled, the application is **Ready to Submit** —
   review it and **click Submit yourself**.
7. Tailor AI records the result when confirmation is available; you can also
   mark an application as applied manually.

Tailor AI never submits applications automatically, never solves CAPTCHAs,
and never consumes OTP/MFA codes. Unsupported providers show
"Manual application required" with an open-original link and tracking.

### Update

**Easy way (v1.8+):** the app checks for updates itself — when a new version is released, a banner appears in the app with an **Update & Restart** button. One click, done.

**Manual way** (same result, manual — clone-based installs):

```bash
git pull origin main          # fetch the latest release code
docker compose up -d --build  # rebuild + restart the app (no data loss)
```

**Script way** (same result, manual):

```powershell
# Windows — PowerShell
irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/update.ps1 | iex
```
```bash
# macOS / Linux — Terminal
curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/update.sh | bash
```

### Uninstall

`scripts/uninstall.sh` (macOS/Linux) · `scripts/uninstall.bat` (Windows). Removes the app + data; Docker stays.

### Alternatives

```bash
# Docker manual
curl -sL https://github.com/Atanub707/Tailor-AI/archive/main.zip -o ats.zip
unzip ats.zip && cd Tailor-AI-main
docker compose up -d

# Developer mode (Node 18+, no Docker)
git clone https://github.com/Atanub707/Tailor-AI.git
cd Tailor-AI && npm install && npm run dev
```

---

## 🔑 Configure keys

ATS scoring and CV tailoring need an **LLM API key** (Bring Your Own Key). Apify-powered sources need an Apify token.

1. Start the app and sign in (account or **Guest**)
2. **Account menu → Settings → Integrations**
3. Pick your **LLM provider** + API key (and **Apify token** if using Apify sources)
4. **Apply Config**

**Supported LLM providers:** OpenCode Go (default) · Google Gemini · OpenAI · Anthropic (Claude) · OpenRouter · NVIDIA.

Full token guide: [docs/TOKENS.md](docs/TOKENS.md)

---

## 🎯 Usage

1. **Set up your Master CV** — Account menu → **Master Candidate CV**. Fill in summary, experience, skills, education, certifications. Use the live PDF preview, import an existing resume (PDF/DOCX/TXT), or **AI Compress** to fit 1–2 pages.
2. **Search jobs** — enter a role (e.g. "DevOps Engineer"), pick sources and filters, click **Search Jobs**.
3. **Score** — AI analyzes your CV against each job: match %, skill gaps, missing keywords, recommendations.
4. **Tailor** — generate an ATS-optimized CV for a specific job and download as PDF. Batch **Score Pending** / **Tailor Matched** for the whole list.
5. **Manual JD** (`⌘J`) — paste any job description and get a scored, tailored CV without scraping.
6. **LinkedIn Posts** — real-time job posts recruiters share (free engine; Apify coming later).
7. **Recruiters** — contacts extracted from descriptions; AI-drafted cold emails via your SMTP; follow-ups, templates, batch send, WhatsApp links, CSV export.
8. **AI Interview** — practice mock interviews grounded in a job description.

---

## ⚙️ Configuration (`config.ini`)

```ini
[llm]
provider=gemini
apiKey=
model=gemini-3.6-flash
temperature=0.2

[thresholds]
minMatchForTailor=40
earlyBlockThreshold=30

[storage]
mode=sqlite
sqliteDbPath=./data/ats_jobs.sqlite

[scraper]
stealthMode=true
maxRetries=3
```

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 · TypeScript · Tailwind CSS v4 · react-router · Phosphor + Lucide icons |
| Backend | Express 4 · TypeScript · tsx |
| LLM | OpenAI-compatible providers (OpenCode Go, OpenAI, Gemini, Anthropic, OpenRouter, NVIDIA) |
| Scraping | Native `fetch` · cheerio · Apify REST API |
| Storage | SQLite (`better-sqlite3`, WAL) |
| Auth | Local accounts · scrypt · httpOnly cookies |
| Email | nodemailer (your own SMTP) |
| Documents | pdfkit (PDF) · mammoth + pdf-parse (import) |
| Build | Vite · esbuild |

---

## 📄 License

[MIT](LICENSE) — free and open source.

---

## ⚖️ Legal & Terms of Use

- **Personal, local use.** Runs on your machine; data stays local. Not a cloud service.
- **Scraping & ToS.** Automated retrieval of publicly visible listings may violate a site's Terms of Service. **You are responsible for your own use** — comply with each site's `robots.txt`, Terms, and applicable law (GDPR, India DPDP Act 2023).
- **Safeguards.** The tool respects `robots.txt`, throttles requests, and strips personal contact data from stored listings.
- **No affiliation.** Not affiliated with or endorsed by LinkedIn, Indeed, or any job board.
- **No warranty.** Provided "as is". Site owners with concerns: open an issue and we'll act promptly.
