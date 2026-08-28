# Application Engine V1 — Phase 0 Research & Contract Design

Status: PHASE 0 (research + contract only — no submission implementation)
Date checked: 2026-08-28

## 1. Mission

Design the provider-neutral Application Engine that consumes READY
Application Packages and — in future phases — safely inspects and (later)
submits applications. This document separates what each ATS actually
supports from what would be assumed.

## 2. Evidence Log

| # | Provider | Claim | Evidence type | Source | Confidence |
|---|----------|-------|---------------|--------|------------|
| E1 | Greenhouse | `boards.greenhouse.io` 301→ `job-boards.greenhouse.io` (canonical host) | NETWORK_OBSERVATION | live GET | HIGH |
| E2 | Greenhouse | Job page is a JS SPA (Remix bundles on job-boards.cdn.greenhouse.io) | SOURCE_CODE_OBSERVATION | page HTML + JS bundle | HIGH |
| E3 | Greenhouse | Application submitted as JSON `{job_application}` to a submitPath | SOURCE_CODE_OBSERVATION | entry.client-D8ZlKSVO.js | HIGH |
| E4 | Greenhouse | Submit carries csrfToken (authenticity_token) + device fingerprint | SOURCE_CODE_OBSERVATION | same bundle | HIGH |
| E5 | Greenhouse | Optional reCAPTCHA client + optional employer security code + jobApplicationRequestToken | SOURCE_CODE_OBSERVATION | same bundle | HIGH |
| E6 | Greenhouse | Old `boards-api.../embed/detail?id=` question JSON endpoint now 404s on canonical host | NETWORK_OBSERVATION | live GET | HIGH |
| E7 | Greenhouse | Official candidate-side submission API: none documented | INFERENCE (no docs found in page/bundle) | research | MEDIUM |
| E8 | Lever | Job page + `/apply` are server-rendered HTML | NETWORK_OBSERVATION | live GET | HIGH |
| E9 | Lever | `<form id="application-form" enctype="multipart/form-data" method="POST">` posts to the `/apply` URL | SOURCE_CODE_OBSERVATION | apply page HTML | HIGH |
| E10 | Lever | Fields: name, email, phone, location, timezone, resume(file), source, origin, referer, org + custom questions | SOURCE_CODE_OBSERVATION | apply page HTML | HIGH |
| E11 | Lever | No CSRF token / authenticity_token in the static form | PUBLIC_FORM_OBSERVATION | apply page HTML | MEDIUM |
| E12 | Lever | No CAPTCHA markers in static form | PUBLIC_FORM_OBSERVATION | apply page HTML | MEDIUM |
| E13 | Ashby | Application page is a SPA; bundles on cdn.ashbyprd.com (Vite manifest) | SOURCE_CODE_OBSERVATION | page + manifest | HIGH |
| E14 | Ashby | Submissions go to `/api/non-user-graphql?op=<operationName>` | SOURCE_CODE_OBSERVATION | index-BY_pw5rC.js | HIGH |
| E15 | Ashby | reCAPTCHA (incl. Enterprise) with per-org public site key; dummy token fallback | SOURCE_CODE_OBSERVATION | same bundle | HIGH |
| E16 | Ashby | CSRF + application_form tokens; AutomatedProcessingLegalNotice legal feature | SOURCE_CODE_OBSERVATION | same bundle | HIGH |
| E17 | All | No mutations were performed during research | — | — | — |

## 3. Provider Findings

### Greenhouse

- Job discovery: OFFICIAL public API (`boards-api.greenhouse.io/v1/boards/{company}/jobs`) — already used by Tailor.
- Application form: browser SPA (`job-boards.greenhouse.io`) — JSON POST to a per-request `submitPath` with `{job_application}`.
- Official candidate submission API: NONE (employer API is authenticated employer-side; not candidate-facing).
- Question discovery: form data (questions, EEOC, compliance) is embedded in the SPA's application data — accessible via the app's own endpoints; the legacy `embed/detail` JSON endpoint is gone on the canonical host.
- Resume upload: file part inside the JSON submission (bundle shows file/application handling + Google Drive picker integration).
- CSRF/session: authenticity_token (CSRF) + device fingerprint required.
- CAPTCHA/anti-bot: reCAPTCHA client configurable per employer; optional security code; device fingerprint.
- Success verification: no reliable HTTP-only signal — the SPA handles the response; success text/redirect depend on employer config.
- Duplicate behavior: not discoverable without mutation.
- Transport classification: BROWSER_AUTOMATION (JS app, fingerprint, CSRF; reCAPTCHA/security-code gates when enabled).

### Lever

- Job discovery: OFFICIAL public API (`api.lever.co/v0/postings/{company}?mode=json`) — already used by Tailor.
- Application form: server-rendered HTML form (`jobs.lever.co/{company}/{id}/apply`) — classic multipart POST.
- Official candidate submission API: NONE documented (hosted form only).
- Question discovery: custom questions rendered server-side in the form HTML — directly parseable.
- Resume upload: `name="resume"` file input in the multipart form.
- CSRF/session: none observed in the static form (classic form; no token).
- CAPTCHA/anti-bot: none observed in the static markup.
- Success verification: form POST response (redirect/HTML) — verify empirically in Phase 2.
- Duplicate behavior: not discoverable without mutation.
- Transport classification: DIRECT_HTTP (multipart POST) — lowest friction of the three.

### Ashby

- Job discovery: OFFICIAL public API (`api.ashbyhq.com/posting-api/job-board/{slug}`) — already used by Tailor.
- Application form: SPA (`jobs.ashbyhq.com/{slug}/{id}/application`) → GraphQL `/api/non-user-graphql?op=<op>`.
- Official candidate submission API: NONE documented (internal GraphQL).
- Question discovery: GraphQL queries carry the application form/questions (fetchable read-only).
- Resume upload: file upload inside the GraphQL submission (system field `_systemfield_submission_files`).
- CSRF/session: CSRF + application_form token required.
- CAPTCHA/anti-bot: reCAPTCHA (incl. Enterprise) with per-org site key — a token is executed before submission; without a key a `recaptcha_dummy_token` is used.
- Legal/consent: configurable legal notices (e.g., AutomatedProcessingLegalNotice).
- Success verification: GraphQL response — verifiable when implemented.
- Duplicate behavior: not discoverable without mutation.
- Transport classification: DIRECT_HTTP+reCAPTCHA (GraphQL + token) — anti-bot friction HIGH.

## 4. Provider Capability Matrix

| Capability | Greenhouse | Lever | Ashby |
|---|---|---|---|
| Job discovery (official API) | SUPPORTED | SUPPORTED | SUPPORTED |
| Question discovery (read-only) | PARTIAL (SPA data) | SUPPORTED (server HTML) | SUPPORTED (GraphQL) |
| Standard fields | SUPPORTED | SUPPORTED | SUPPORTED |
| Custom questions | SUPPORTED | SUPPORTED | SUPPORTED |
| Resume upload | SUPPORTED (JSON part) | SUPPORTED (multipart file) | SUPPORTED (GraphQL file) |
| Cover letter | PARTIAL | PARTIAL | PARTIAL |
| Boolean / single / multi / text / numeric / date | SUPPORTED (question types) | SUPPORTED | SUPPORTED |
| EEO/demographic | SUPPORTED (separate section) | PARTIAL | PARTIAL |
| Consent/legal | SUPPORTED (compliance section) | UNKNOWN | SUPPORTED (legal notices) |
| Required-field discovery | PARTIAL | SUPPORTED | PARTIAL |
| Official candidate API | NOT SUPPORTED | NOT SUPPORTED | NOT SUPPORTED |
| Browser required | YES (SPA) | NO (static form) | YES (SPA) |
| Session/CSRF | CSRF + fingerprint | none observed | CSRF + form token |
| CAPTCHA | reCAPTCHA (employer-config) | not observed | reCAPTCHA (org-config) |
| Success verification | UNKNOWN (app handles) | PARTIAL (HTTP/redirect) | PARTIAL (GraphQL) |
| Duplicate detection | UNKNOWN | UNKNOWN | UNKNOWN |
| Automation suitability | LOW-MEDIUM | HIGH | LOW (CAPTCHA) |

## 5. Provider-Neutral Contracts (types only — no adapters)

### ApplicationTarget
```ts
interface ApplicationTarget {
  provider: Provider;
  externalJobId: string;
  applyUrl: string;
  company: string;
  title: string;
  hostname: string;
  redirectKind: 'SUPPORTED_TARGET' | 'REDIRECTED_SUPPORTED_TARGET' | 'UNSUPPORTED_TARGET' | 'MANUAL_ONLY';
}
```

### Provider detection (confidence-aware)
Signals: `job.atsPlatform`, `applyUrl`/`jobUrl` hostname (jobs.lever.co, boards.greenhouse.io,
jobs.ashbyhq.com), external-id shape (gh-N, lev-UUID, ashby-UUID). Output `{provider, confidence, reason}`.
Redirects (e.g., a Greenhouse-indexed job whose applyUrl points at a company Workday site) → the target
hostname decides: unsupported hosts → `UNSUPPORTED_TARGET`/`MANUAL_ONLY`, never forced onto the index provider.

### ApplicationRequirements / ApplicationField
```ts
type FieldType = 'TEXT' | 'TEXTAREA' | 'EMAIL' | 'PHONE' | 'URL' | 'BOOLEAN' | 'NUMBER' | 'DATE'
  | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'FILE' | 'CONSENT' | 'UNKNOWN';
type FieldCategory = 'IDENTITY' | 'CONTACT' | 'LOCATION' | 'WORK_AUTHORIZATION' | 'SPONSORSHIP'
  | 'COMPENSATION' | 'EXPERIENCE' | 'EDUCATION' | 'RESUME' | 'COVER_LETTER' | 'CUSTOM' | 'CONSENT' | 'EEO' | 'UNKNOWN';
interface ApplicationField {
  providerFieldId: string;
  normalizedKey?: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  category: FieldCategory;
}
interface ApplicationRequirements {
  provider: Provider;
  target: ApplicationTarget;
  fields: ApplicationField[];
  discoveredAt: string;
  fingerprint: string; // deterministic over provider+target+fields
}
```

### Field normalization ladder (design)
1. EXACT canonical key match → 2. known alias map (e.g., "Given Name"→first_name, "Work authorization"→authorized_to_work, "Will you now or in the future require sponsorship?"→requires_sponsorship) → 3. deterministic semantic rules (label/type/category heuristics) → 4. AI_SUGGESTED (optional, review required) → 5. USER confirmation when uncertain. Never an LLM-only mapper.

### EEO policy
Never infer, never LLM-generate, never derive. Classification: EEO → `MANUAL_ONLY` (user may fill voluntarily) or `DECLINE_TO_ANSWER` when the form explicitly offers it and policy allows. Auto-fill: never.

### Consent policy
Classify: INFORMATIONAL / REQUIRED_ACKNOWLEDGEMENT / LEGAL_CONSENT / UNKNOWN. LEGAL_CONSENT and REQUIRED_ACKNOWLEDGEMENT require explicit user review — never auto-accepted from profile booleans.

### File policy
Resume = the Application Package's immutable PDF artifact (never regenerated at submission time). Cover letter = package generated content (verified). Other files: manual/optional.

## 6. Application Engine Contract (Phase 1 — no submission)

```
ApplicationEngine.inspect(packageId)        → ApplicationRequirements   (read-only)
ApplicationEngine.createPlan(packageId, reqs) → SubmissionPlan
ApplicationEngine.validatePlan(planId)      → PlanValidation
ApplicationEngine.getPreview(planId)        → DryRunPreview
```
Engine consumes READY packages only (status READY, snapshotHash valid, PDF artifact present, not stale).
Engine never mutates the package; discovered requirements/answers live in the PLAN layer.

## 7. Adapter Contract

```ts
interface ApplicationAdapter {
  readonly provider: Provider;
  detect(target: ApplicationTarget): DetectionResult;          // read-only
  inspect(target: ApplicationTarget): Promise<ApplicationRequirements>; // read-only, NEVER submits
  buildSubmissionPayload(pkg, requirements, mappings): SubmissionPayload; // pure
  validate(payload): ValidationResult;                         // pure
  // submit/verify are FUTURE — separated from inspection by contract
}
```

## 8. Submission Plan (immutable, no execution)

```ts
interface SubmissionPlan {
  id: string;
  packageId: string;
  packageSnapshotHash: string;
  provider: Provider;
  target: ApplicationTarget;
  requirementsFingerprint: string;
  mappedFields: MappedField[];
  files: { kind: 'RESUME' | 'COVER_LETTER' | 'OTHER'; artifactSha?: string }[];
  unresolvedFields: string[];
  consentFields: string[];
  manualFields: string[];
  status: 'INSPECTING' | 'NEEDS_INPUT' | 'NEEDS_REVIEW' | 'READY_TO_SUBMIT' | 'UNSUPPORTED';
  createdAt: string;
}
```
MappedField: `{providerFieldId, canonicalKey?, label, type, required, value, source, mappingConfidence, mappingMethod: 'EXACT'|'ALIAS'|'DETERMINISTIC'|'USER'|'AI_SUGGESTED'}`.

## 9. Dry Run

Preview = exact "what would be submitted": target, resume artifact SHA, every mapped field
(provider label → value → source), questions, consents (marked REQUIRES_REVIEW), unresolved fields.
Zero mutations.

## 10. State Machine (future)

PREPARATION: PACKAGE READY → INSPECTING → PLAN CREATED → NEEDS_INPUT / NEEDS_REVIEW → READY_TO_SUBMIT.
EXECUTION (future): USER_APPROVED → SUBMITTING → SUBMITTED | FAILED | MANUAL_ACTION_REQUIRED | SUCCESS_UNCONFIRMED.

## 11. Idempotency & Retry (design)

Submission identity: `(userId, provider, externalJobId, packageSnapshotHash)`. Duplicate prevention is
mandatory before any Phase-2 submit. Retry: inspection GETs are retry-safe; a submission mutation is
NEVER blindly retried — a timeout after a POST yields `SUCCESS_UNCONFIRMED`, never an immediate retry.

## 12. Failure Taxonomy

`VALIDATION_FAILED | MISSING_REQUIRED_FIELD | REVIEW_REQUIRED | AUTH_REQUIRED | CAPTCHA_REQUIRED |
RATE_LIMITED | PROVIDER_UNAVAILABLE | FORM_CHANGED | UNSUPPORTED_FIELD | UPLOAD_FAILED |
SUBMISSION_REJECTED | SUCCESS_UNCONFIRMED | DUPLICATE_APPLICATION | MANUAL_ACTION_REQUIRED | UNKNOWN`

## 13. CAPTCHA / Anti-bot Policy

No bypass, ever. CAPTCHA observed (Greenhouse configurable, Ashby default) → future result
`MANUAL_ACTION_REQUIRED`. No stealth, no circumvention.

## 14. Rate Limiting

No official limits documented for the observed flows (undocumented internals). Phase 1: conservative
per-provider rate limiting with sensible defaults; documented as policy, not provider fact.

## 15. Provider Implementation Order (evidence-based)

1. **Lever** — direct multipart POST, no CSRF/CAPTCHA observed, server-rendered questions (best
   read-only discovery). 2. **Greenhouse** — deterministic JSON shape but SPA + fingerprint + CSRF +
   employer-configurable reCAPTCHA/security code (medium complexity). 3. **Ashby** — GraphQL +
   reCAPTCHA (highest anti-bot friction; most steps become MANUAL_ACTION_REQUIRED).

## 16. Phase 1 Plan (scope)

- Application Engine core (inspect/createPlan/validatePlan/getPreview) — NO submission.
- Read-only inspection abstraction (adapter interface; a `static-inspection` reference mode using
  server-rendered/question APIs where safe — Lever page, Ashby GraphQL query, Greenhouse app data).
- SubmissionPlan persistence (SQLite `submission_plans` table) + plan/requirement fingerprints.
- Field normalization (exact → alias → deterministic) + EEO/consent classification.
- Dry-run preview UI ("here is exactly what would be submitted").
- Tests: provider detection, redirect classification, field normalization, fingerprints, plan
  statuses, package-gating (READY only), ownership. No live ATS calls in the suite.
- Acceptance: a dry-run preview exists for a READY package; zero mutations; all frozen systems green.

## 17. Future Phases

Phase 2: Lever adapter (inspect + plan + dry-run against a real board read-only). Phase 3: Greenhouse,
then Ashby adapters. Phase 4: Assisted Apply (user-approved execution, MANUAL_ACTION_REQUIRED steps).
Phase 5: Controlled Auto-Apply under explicit policy.

## 18. Security / Privacy

JD/question text is untrusted data (never instructions). No secrets in logs. Inspection sends minimum
data (no resume upload during read-only inspection). Cross-user isolation for plans/packages.

## 19. Database

Phase 0: no migration. Phase 1 may add `submission_plans` (SQLite, same patterns as
application_packages).