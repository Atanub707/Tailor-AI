# Tailor AI — Job Workflow Control Audit (v2.4.0)

Repository-wide audit of every Job Library action. Written before any UI change
in this milestone; conclusions drive the consolidation.

## Control audit matrix

| CONTROL | USER LABEL | COMPONENT | HANDLER | API | ENGINE | INPUTS | OUTPUT | PERSISTENCE | SIDE EFFECTS | CLASS | USER VALUE | RECOMMENDED UX |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Score | Score / ATS SCORE | (removed from cards in v2.3.0) | `handleMatchJob` (App.tsx) | `POST /api/jobs/:id/match`, `POST /api/jobs/batch-match` | LLM (requires API key) | Master CV + JD | `matchScore` 0-100 + `gapAnalysis` | job row | LLM spend | LEGACY LLM metric | Resume↔JD alignment | Job Detail only, on demand (Match Analysis tab) |
| Fit | Fit | card Match pill | `openMatch` (JobMatrix) | `POST /api/jobs/:id/fit` | deterministic `fitEngine.computeFit` (+ fitCache) | Applicant Profile + Master CV + JD | score, grade, strengths, gaps, blockers, unknowns | fit cache | none ($0) | CURRENT | Candidate↔job suitability | Card metric: **Candidate Fit** |
| Tailor (legacy) | Tailor / Re-Tailor | removed from cards v2.3.0; legacy handler remained | `handleTailorJob` (App.tsx) — REWIRED in v2.4.0 | `POST /api/jobs/:id/tailor`, `POST /api/jobs/batch-tailor` | LLM `LlmCvTailor` | Master CV + JD | legacy `tailoredCv` (unverified claims) | job.tailoredCv | LLM spend | LEGACY | — | Not exposed; backend preserved for old data |
| Tailor V2 | (was hidden) | Job Detail "Tailor Resume" (now wired) | `handleTailorJob` → `POST /api/jobs/:id/tailor-v2` | `POST /api/jobs/:id/tailor-v2` (+ `/pdf`, + `/latest` new) | `tailorV2Engine.runTailorV2` — grounded, fact-verified | Master CV + Applicant Profile + JD + fit | version row (content + verification + jdTerms + PDF) | `tailor_versions` store | none beyond engine | AUTHORITATIVE | Fact-verified tailored resume | ONE action: **Tailor Resume** |
| Prepare Application | Prepare Application | removed from cards v2.3.0 | (orchestrated by Apply) | `POST /api/jobs/:id/application-package` (+ `/rebuild`) | `packageEngine.preparePackage` | profile + CV + fit + tailored version + JD | immutable Application Package | application_packages | none (no submission) | CURRENT (internal step) | — | Behind Apply |
| Prepare for Application | Prepare for Application | removed from cards v2.3.0 | (orchestrated by Apply) | `POST /api/application-packages/:packageId/plan` | `applicationEngine.createPlan` (inspection + mapping + gates) | package + resolved JD + provider adapter | SubmissionPlan (fingerprint, consent, gates) | submission_plans | read-only inspection only | CURRENT (internal step) | — | Behind Apply |
| Apply | Apply | card primary CTA | `apply()` (JobMatrix) | `POST /api/jobs/:id/application-package` → `/applications` | package + Start Application + execution router | — | package/plan/attempt lifecycle | packages/plans/approvals/attempts/events | NO auto-submit | CURRENT | Primary intent | **Apply** (primary) |
| Mark Applied | Mark Applied | overflow | `onUpdateStatus` | `PUT /api/jobs/:id/status` | job state machine | — | job.state applied/pending | job row | none | CURRENT | manual external application | Overflow |
| Download CV | Download CV / tailored resume | overflow + Job Detail | DownloadCvDropdown | `GET /api/jobs/:id/download-pdf` | legacy PDF gen from `job.tailoredCv`; V2 PDF via `/tailor-v2/pdf` | legacy tailoredCv or V2 version | PDF | none | none | MIXED | exact-artifact download | Overflow/Detail only when artifact exists |
| Open original job | ↗ | source tag + overflow | link | — | — | jobUrl/applyUrl | external tab | none | none | CURRENT | original post | Overflow + source tag |
| Delete | Delete / Remove job | overflow | `handleDeleteJob` (App.tsx) | `DELETE /api/jobs/:id` | job store | — | removes job | job row | destructive | CURRENT | remove job | Overflow + confirm (added v2.4.0) |

## Score vs Fit verdict

**DISTINCT.** Score = LLM resume↔JD alignment (`matchScore` + `gapAnalysis`, requires API key,
non-deterministic, per-job cost). Fit = deterministic candidate suitability from Applicant
Profile + Master CV + JD (free, cached). Different inputs, different engines, different outputs.
They are NOT aliases.

**Final UX:** the job card shows ONE metric — **Candidate Fit** (always available, $0,
deterministic). **Resume Match** (the LLM score) remains available on demand in Job Detail
(Match Analysis tab) only when the user triggers it with their own key — never on cards,
never in bulk.

## Tailor verdict

**Authoritative path: Tailor V2** (`tailorV2Engine.runTailorV2` — Master-CV fact ledger,
unsupported-claim detection, employer/title/date/education/skill verification, numeric
safety, ATS-safe PDF, immutable version rows, package-compatible binding).
**Legacy handling:** `POST /api/jobs/:id/tailor` + `/batch-tailor` + `/download-pdf` and the
legacy `job.tailoredCv` rendering remain in the backend so old persisted data stays
readable; the normal UI's single "Tailor Resume" action now routes to Tailor V2 (it was
mis-wired to the legacy endpoint after v2.3.0 label work — corrected in v2.4.0). New
tailoring output is displayed from the version store (`/api/jobs/:id/tailor-v2/latest`)
with verification status — no fabricated audit scores.

## Application preparation verdict

Both "Prepare Application" (package creation) and "Prepare for Application" (plan
creation) are CURRENT internal orchestration steps — not legacy duplicates. They were
removed from cards in v2.3.0 and are orchestrated behind **Apply**:
Apply → package (idempotent fingerprint reuse) → Applications → plan (gates/consent) →
approval → execution router → Browser Companion/manual → human checkpoints → user final
submission. Both remain intact as endpoints and are exercised by the applications flow.

## Safety boundaries (unchanged)

No automatic provider submission, no CAPTCHA solving, no OTP/MFA consumption, no EEO or
legal-consent inference. Static audit of `src/` and `browser-extension/` confirms zero
`form.submit()` / `requestSubmit()` / synthetic submit-event patterns.