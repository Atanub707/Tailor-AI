# Multi-Provider Application Execution — Research + Adapter Evidence

Extends `docs/browser-companion-phase2.md`. Provider adapters are isolated
behind the common `BrowserProviderAdapter` contract
(`server/browserCompanion/browserProviderAdapter.ts`): identifyPage →
inspectForm → validate (PASS 1 read-only) → apply (PASS 2, only on ok) →
locateResumeInput → detectHumanCheckpoint → observeSubmission. The
execution router (`resolveProviderAdapter`) selects by AUTHORITATIVE
provider metadata, never page text.

## Lever (Phase 3 — calibration)

- Confirmation hardening: `observeSuccessText` requires strong markers
  (`application has been submitted`, `application received`,
  `successfully applied`, `thank you ... application` + URL). Vague text
  alone is never CONFIRMED. Classifications: CONFIRMED / UNCONFIRMED /
  FAILED / STILL_ON_FORM / IDENTITY_CHANGED.
- CAPTCHA-cleared semantics: the checkpoint watcher reacts only to a
  structural blocking-state change (widget/response-input gone), then a
  FULL read-only revalidation; wording is "checkpoint cleared", never
  "CAPTCHA solved".
- Secret isolation: pairing secret via `chrome.storage.local` with
  `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` where supported;
  content scripts never receive installSecret/bearer/package/profile.

## Greenhouse (BROWSER_ASSIST_SUPPORTED — evidence 2026-08, GET-only)

- Hosts: `boards.greenhouse.io` + `job-boards.greenhouse.io`.
- Identity: `/{company}/jobs/{jobId}` (also `?gh_src=` params allowed);
  form `#application-form` is server-rendered (33 KB field markup observed).
- Fields are identified by **ID** (no name attributes): `first_name`,
  `last_name`, `email`, `phone`, `preferred_name`, `country`,
  `cover_letter` (+ `cover_letter-text`), `question_{id}` custom questions;
  labels via `<label for=...>` + `aria-label`; required via `required` +
  `aria-required`; types observed: text, tel, file; `react-select` widgets
  for country (hidden input id `country`).
- Resume: `input#resume` type=file accept `.pdf,.doc,.docx,.txt,.rtf`.
- EEO: none on the two sampled boards (Tech Holding, InfoTrust) — policy:
  never inferred, optional omit, required-unapproved → HUMAN_ACTION_REQUIRED.
- CAPTCHA: reCAPTCHA is board-configurable (g-recaptcha markers) — detected
  structurally only; live acceptance hint true (provisional — marker regex
  is looser in the acceptance harness than the extension's structure-only
  check).
- Submit: form action = same job URL (SPA posts); USER-triggered only.
- Acceptance: live GET → identity OK, 11 fields normalized, resume control
  found, captcha hint present, POST=0 uploads=0 submit=0.

## Ashby (BROWSER_ASSIST_SUPPORTED — evidence 2026-08, GET + rendered-DOM)

- Host: `jobs.ashbyhq.com`; identity `/{company}/{postingId}/application`.
- The static HTML is an SPA shell; the RENDERED DOM (captured read-only in
  a real browser) exposes: `_systemfield_name` (Full Name), `_systemfield_email`,
  `_systemfield_resume` (file), custom questions keyed by UUID
  (`name=id={uuid}`, tel/url/text), radio groups sharing the UUID name with
  `{uuid}_{optionId}` ids, labels as rendered text, and reCAPTCHA via a
  hidden `g-recaptcha-response` textarea (LatamCent board).
- SPA safety: current DOM is the transport authority; every mutation
  preceded by full revalidation; identity re-checked per navigation; stale
  plans never reused; PAGE_IDENTITY_MISMATCH on other jobs.
- Resume: `#_systemfield_resume`; exact package bytes only.
- Acceptance: rendered-DOM evidence captured; adapter logic validated on the
  synthetic fixture mirroring the rendered structure; POST=0.

## Capability matrix

| Capability | Lever | Greenhouse | Ashby |
|---|---|---|---|
| Search | ✓ (existing) | ✓ (indexed) | ✓ (indexed) |
| Page identity | ✓ live | ✓ live | ✓ rendered-DOM |
| Form inspection | ✓ live (19) | ✓ live (11) | ✓ synthetic (rendered structure) |
| Autofill (two-pass) | ✓ | ✓ | ✓ |
| Resume attach (exact) | ✓ | ✓ (control found) | ✓ (control found) |
| Human checkpoint | ✓ hCaptcha | ✓ reCAPTCHA configurable | ✓ reCAPTCHA observed |
| Ready to Submit | ✓ | ✓ | ✓ |
| User submit | ✓ | ✓ | ✓ |
| Confirmation observer | ✓ (strong markers) | ✓ (shared) | ✓ (shared) |
| Manual fallback | ✓ | ✓ | ✓ |

All providers: GET allowed, POST=0, uploads=0, submit=0, CAPTCHA
interaction=0, LLM=0, Apify=0, paid=0. Sessions bind provider immutably;
cross-provider URLs rejected by `verifiedProviderActionUrl`.