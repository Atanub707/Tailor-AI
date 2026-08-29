# Application Execution E2E V1 — Audit & Wiring

Complete path trace from the visible Job Card Apply button through execution
tracking. Verdicts: what was already connected, what was mis-wired, what this
milestone fixed.

## Path trace (before this milestone)

| STEP | FILE | FUNCTION | WAS WORKING? | WAS CONNECTED? |
|---|---|---|---|---|
| Job Card Apply | src/components/JobMatrix.tsx | `apply()` | partial | NO — hard `window.location.href='/applications'` = full page reload ("looks like refresh"); errors silently swallowed |
| Package creation | server.ts | `POST /api/jobs/:id/application-package` → `packageEngine.buildPackage/preparePackage` | YES | YES (idempotent fingerprint reuse) |
| Applications list | applicationService.applicationSummaries | rows | partial | NO — packages WITHOUT a plan were skipped (`if (!plan) continue`) → after Apply the list was empty → looked broken |
| Application Detail | src/components/ApplicationsScreen.tsx | drawer + `/api/applications/:id/details` | YES | partial — no canonical route; drawer only opened on click |
| Plan creation | engine.createPlan | plan + gates | YES | partial — the UI's START_APPLICATION action called `/start` directly, which requires an existing plan → "This application needs to be prepared first." |
| Unsupported providers | engine.resolveAdapter | throw | YES (by design) | NO — the throw became a 500 instead of a durable UNSUPPORTED plan → user saw "Failed"/error, never "Manual application required" |
| No tailored resume | packageEngine.buildPackage | resumeSnapshot | partial | NO — package had NO resume artifact without a Tailor V2 version → gate RESUME_ARTIFACT_MISSING → Apply could never proceed for untailored jobs |
| Plan → attempt → checkpoints | executionEngine / applicationService.startApplication | full lifecycle | YES | YES (proven by existing suites: CAPTCHA, consent, EEO, idempotency) |
| Companion / handoff / confirm | browser-companion routes + ApplicationsScreen | sessions/handoff/confirm | YES | YES (existing) |

## Fixes in this milestone

1. **Apply handoff** — `useNavigate` (react-router) instead of `window.location.href`; `type="button"`; `Preparing…` loading label; `if (applying) return` double-click guard; human-readable errors with guidance. Navigates to the canonical `/applications/:applicationId`.
2. **Canonical route** — `/applications/:applicationId` in App.tsx (prefix route); ApplicationsScreen auto-opens that application's detail drawer → reload/restart recovery.
3. **Plan-less packages listed** — `applicationSummaries` now includes packages without plans as **Preparing** with `START_APPLICATION` (+ jobUrl). Repeated preparation stays idempotent (fingerprint).
4. **Start Application orchestrates plan** — the client action now POSTs `/api/application-packages/:id/plan` (read-only inspection) first, then `/start`; friendly gate errors (PACKAGE_NOT_READY / RESUME_ARTIFACT_MISSING / STALE / NOT_FOUND) instead of raw codes.
5. **Unsupported providers → Manual application required** — `createPlan` catches `InspectionFailure` and persists a durable **UNSUPPORTED** plan (idempotent); status maps to `MANUAL_REQUIRED` (never `FAILED`); actions: `OPEN_ORIGINAL` (jobUrl) + `MARK_APPLIED` (new `POST /api/applications/:applicationId/mark-applied`, durable event under synthetic attempt `manual-<pkgId>`, no fabricated provider evidence) + `VIEW`.
6. **Master CV resume policy (§10)** — packages without a verified tailored version snapshot the authoritative Master CV as the resume artifact (`source: 'MASTER_CV'`, deterministic PDF + hash + artifact store) so Apply works without an LLM tailoring call; `validatePackage` accepts TAILORED (requires verification) or MASTER_CV (requires artifact) sources; Apply route rebuilds non-READY packages instead of reusing DRAFT ones.
7. **Timeline** — `/api/applications/:id/details` now returns recent events (incl. manual events); drawer renders "Recent activity".
8. **Manual applied** — new endpoint + `markAppliedManually` service: idempotent, distinguishes `confirmationSource: 'USER_MANUAL'`, maps to APPLIED, persists forever.

## Unchanged (per §80/§71)

Search, Fit, Score, Tailor V2 engine, legacy Tailor endpoints, Application
Package engine, execution router, Browser Companion pairing/session/security,
Credential Vault, Mail Intelligence. No new providers. No final-submission
primitives (static audit: zero `form.submit()`/`requestSubmit()`/synthetic
submit clicks in `src/` + `browser-extension/`).

## Certification level for this environment

- **MOCK/FIXTURE CERTIFIED**: plan/attempt/checkpoint/confirmation contracts
  (existing suites) + new E2E suites.
- **SAFE LIVE DOM CERTIFIED**: Apply→/applications/:id (no reload), Preparing
  state, Start Application → plan, Manual application required, Mark as
  applied → Applied + timeline + exact resume download, refresh recovery,
  mobile 390.
- **REAL EXTENSION**: not exercisable in this environment (unpacked extension
  cannot be loaded into the managed browser); companion chains are covered by
  their existing contract suites + presence handshake wiring.

## User-facing flow (documented in README/docs)

Find a job → Apply → Tailor AI prepares the application → Application Detail
shows the next step → answer anything genuinely required → approve → continue
in the ATS form (Browser Companion assisted where supported) → complete human
checkpoints (CAPTCHA/login/MFA/OTP/EEO/consent) → review → **you** submit →
Tailor AI records the result when confirmation is available.