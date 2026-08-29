# Browser Companion Phase 2 — Complete Lever Application Flow

Extends the frozen Phase 0 architecture (ADR `docs/adr/browser-companion-v1.md`)
and Phase 1 implementation. All Phase 0 decisions remain authoritative;
Phase 2 adds the exact-resume attachment, human-checkpoint continuation, and
user-triggered submission observation that the ADR designed for.

## Résumé trust boundary

- Source of truth: `ApplicationPackage → resumeSnapshot.pdfHash → immutable
  artifact` (exact bytes, never regenerated, never LLM-produced, never the
  latest Tailor version).
- `GET /api/browser-companion/sessions/:id/resume` serves bytes ONLY to a
  valid session bearer, after per-request verification:
  1. authenticated session (opaque bearer, hashed server-side)
  2. not expired (10-min TTL) · 3. pairing not revoked (session terminalized
     with its pairing) · 4. session belongs to the current user
  5. attempt valid · 6. package valid · 7–10. packageSnapshotHash /
     planFingerprint / approvalFingerprint / resumeArtifactHash unchanged
  11–12. artifact exists and belongs to this package/user · 13. size ≤ 5 MB
  14. `%PDF-` magic · 15. SHA-256(bytes) == resumeArtifactHash
- Headers: `Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="resume-<hash12>.pdf"`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- The installSecret can NEVER retrieve bytes (session bearer only).
- Extension: service worker fetches bytes (never paths/keys), hands ONLY the
  ArrayBuffer to the content script → `File` + `DataTransfer` → the verified
  `#application-form` resume input → verify `files.length===1` +
  name/size/type → `RESUME_ATTACHED {artifactHashPrefix,size,mimeType}`.
  References released; bytes never persisted (no chrome.storage/IndexedDB/
  localStorage/logs).
- Fallback: attachment failure → `RESUME_ATTACHMENT_FAILED` →
  Action Required `RESUME_ATTACHMENT_REQUIRED`; user may Download exact
  resume and attach manually.

## Two-pass form safety (release blocker)

- **PASS 1 — READ-ONLY**: verify provider/host/slug/posting/form; every
  approved field exists; every required control understood (reverse pass:
  required form controls without approved values → UNKNOWN_REQUIRED);
  current option sets; consent/EEO requirements; unsupported controls;
  resume control; CAPTCHA/human-checkpoint; NO DOM mutation.
- Any blocking mismatch → `FORM_CHANGED` / `HUMAN_ACTION_REQUIRED` and ZERO
  fields modified (tested: first/middle/LAST mismatch, option change,
  resume-control missing → zero mutations).
- **PASS 2 — MUTATION**: only after full validation: fill approved fields +
  attach résumé + dispatch input/change events.

## Human-checkpoint continuation

- Checkpoint reasons (provider-independent): CAPTCHA_REQUIRED, LOGIN_REQUIRED,
  MFA_REQUIRED, EMAIL_VERIFICATION_REQUIRED, OTP_REQUIRED,
  REQUIRED_CONSENT_REVIEW, REQUIRED_EEO_REVIEW, UNSUPPORTED_REQUIRED_FIELD,
  RESUME_ATTACHMENT_REQUIRED, FORM_CHANGED, MANUAL_SUBMISSION,
  UNKNOWN_PROVIDER_CHECKPOINT.
- Flow: safe fields + résumé prepared → `HUMAN_ACTION_REQUIRED` → user
  completes the human step on the real page (CAPTCHA/login/MFA/OTP/email
  are NEVER automated) → companion observes the blocking state clearing
  (structural widget gone — never reads tokens) → `CHECKPOINT_CLEARED` →
  FULL read-only revalidation → `READY_FOR_USER_SUBMISSION`.
- Never claims "CAPTCHA solved"; wording: "Human verification completed /
  checkpoint cleared". Uncertain → remain Action Required.
- Session continuation: 10-min sessions remain; expired sessions are never
  resurrected — the dashboard offers a fresh session (re-bound to
  attempt/package/plan/approval/resume) through the authenticated flow.

## Submission policy

- **Final Submit remains a USER ACTION.** Tailor AI prepares the complete
  form; the user clicks submit on Lever. No form.submit/requestSubmit/
  button.click, no synthetic submit events, no internal Lever APIs, no POST.
- `REVIEW_AND_SUBMIT` is the only action at READY_TO_SUBMIT; there is no
  "Auto Submit" anywhere.

## Submission observation

- LeverSubmissionObserver classifies the post-submit page: CONFIRMED /
  UNCONFIRMED / FAILED / STILL_ON_FORM using STRONG evidence (stable success
  text/confirmation UI + URL), never vague text alone.
- CONFIRMED → `SUBMISSION_CONFIRMED` (requires confirmationEvidenceType +
  confirmationFingerprint — sanitized, no HTML/PII) → attempt `SUBMITTED` →
  user status Applied.
- Ambiguous → `SUBMISSION_UNCONFIRMED` → `SUCCESS_UNCONFIRMED` → Check
  Submission (never auto-retry; duplicate warning before any explicit retry).
- Explicit failure → `SUBMISSION_FAILED` with sanitized failureCategory →
  FAILED / Action Required per category.

## Duplicate protection

Execution identity (user + provider + externalJobId + packageSnapshotHash +
planFingerprint) remains authoritative. Once SUBMISSION_OBSERVED/APPLIED/
SUCCESS_UNCONFIRMED, no automatic re-execution for the same identity; an
explicit retry after ambiguity requires a duplicate warning.

## Events (Phase 2 additions)

RESUME_ATTACHED, RESUME_ATTACHMENT_FAILED, CHECKPOINT_CLEARED,
READY_FOR_USER_SUBMISSION, SUBMISSION_INITIATED (user-initiation evidence
only — never focus/hover), SUBMISSION_CONFIRMED, SUBMISSION_UNCONFIRMED,
SUBMISSION_FAILED. Idempotency: `companion-{sessionId}-{type}-{clientEventId}`
(clientEventId bounded ≤64 chars, pattern-validated) — retries dedupe,
legitimate later occurrences allowed; existing events unaffected. Events
are evidence-validated, schema-checked, PII-free, and transition the attempt
only through the central state machine.

## Dashboard

Statuses: Preparing / Ready / Applying / Action Required / Waiting for You /
Ready to Submit / Applied / Check Submission / Failed — backend-projected,
never guessed from event text. Actions: Continue in Browser (paired) /
Continue on Lever / Review & Submit on Lever / Download exact resume. No
technical internals exposed.

## Privacy

Local-first: data flows only local Tailor AI → local extension → the
intended ATS form. No central service, no analytics, no telemetry, no
résumé bytes outside the session-resume pipeline, no answers persisted in
the extension.

## Failure taxonomy

| Event | Attempt state | User status |
|---|---|---|
| RESUME_ATTACHMENT_FAILED | (stays) | Action Required (RESUME_ATTACHMENT_REQUIRED) |
| FORM_CHANGED / PAGE_IDENTITY_MISMATCH | BLOCKED | Action Required / Failed |
| SUBMISSION_CONFIRMED | SUBMITTED | Applied |
| SUBMISSION_UNCONFIRMED | SUCCESS_UNCONFIRMED | Check Submission |
| SUBMISSION_FAILED | FAILED | Failed (retryable per category) |

## Manual fallback

If the companion is missing/unpaired/outdated/fails, Continue on Lever +
Download exact resume always remain available.

## ADR status

No Phase-0 ADR decision was violated. Implemented exactly what the ADR
designed for Phase 2 (resume transfer via session-bound bytes +
DataTransfer; DOM-level confirmation; single-active sessions; permissions
unchanged — no webRequest/cookies/<all_urls> added).