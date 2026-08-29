# ADR — Browser Companion V1 (Application Execution V2)

Status: ACCEPTED (Phase 0 freeze) · Date: 2026-08-29 · Branch: `research/browser-companion-phase0` · Base: `8c1d503`

## Context

Tailor AI prepares immutable Application Packages + approvals for real ATS
pages (Lever first). Application Experience V1 established the dashboard,
human checkpoints, verified provider handoff, and USER_CONFIRMED provenance.
The next capability is a local Browser Companion that operates the REAL page
while the local backend stays the source of truth.

Constraints: local-first, minimal infra, low user friction, secure, no
central server, no CAPTCHA solving, no arbitrary page automation.

## Research summary (evidence)

- **Manifest V3 (Chrome official docs)**: service workers are event-driven
  and may be terminated at any time; persistent state must live in
  `chrome.storage` (session for ephemeral); listeners registered
  synchronously. Content scripts run in an **isolated world** (shared DOM,
  no page-JS scope); network from content scripts is page-origin and CORS-
  bound.
- **Extension network**: extension contexts (service worker/popup/options)
  bypass CORS **only for hosts listed in `host_permissions`** (official
  docs + verified behavior). Content-script fetch is NOT exempt — localhost
  traffic must be routed through the service worker.
- **Private Network Access**: Chromium tracks LNA enforcement for local
  network requests; extension SW → localhost with a matching host
  permission works today; the documented forward-compatible remedy is
  `fetch(url, { targetAddressSpace: 'local' })`. Residual risk documented.
- **File inputs**: Chrome (all modern browsers) supports programmatic file
  assignment via `new File([bytes], name, {type})` → `new DataTransfer()`
  → `dt.items.add(file)` → `input.files = dt.files` (WHATWG-blessed
  pattern; used by production extensions). Local-path selection is
  impossible from JS — byte transfer from the backend is the feasible path.
- **Docker reality**: `docker-compose.yml` publishes `3000:3000`; the host
  browser reaches the app at `http://127.0.0.1:3000`. Host-side binding is
  `0.0.0.0` by default → Phase 1 hardening: publish `127.0.0.1:3000:3000`.

## Decision

### Transport

**Primary: Extension service worker ↔ Tailor AI localhost HTTP API**
(`http://127.0.0.1:3000/api/browser-companion/*`) with strict local auth.

- All localhost traffic originates in the extension **service worker**
  (CORS-exempt via `host_permissions`); content scripts never fetch
  localhost.
- **Fallback: explicit user handoff** (existing Continue on Lever flow) —
  no extension needed; the app works unchanged today.

Rejected: web-app→extension `externally_connectable` messaging as primary
(extension ID must be fixed in the web app — breaks unpacked/dev, ties the
web UI to one extension ID); Chrome Native Messaging host (binary + registry
setup, Docker friction, cross-platform pain — high install friction);
WebSocket bridge (service-worker lifecycle + keepalive complexity, no
benefit over request/response HTTP); polling (same complexity as HTTP with
worse latency). Firefox/Edge: MV3 content-script/service-worker model is
portable; V1 targets Chrome only.

### Trust model

- **Trusted**: Tailor AI backend (owns all application truth), the paired
  extension instance, the user.
- **Untrusted**: every web page (including `jobs.lever.co` — its DOM may be
  attacker-influenced via XSS), other local processes, other extensions,
  stale/replayed requests.
- Assumption: the user's machine is trusted (local-first app; attacker with
  local file/process access already owns the data — the threat model defends
  the browser boundary, not the OS).

### Pairing

1. User clicks **Pair** in the Tailor AI web UI → backend generates a
   **one-time pairing code** (random, 10-minute TTL, single use).
2. User pastes it into the extension's options page → extension POSTs
   `/api/browser-companion/pair {code}` → backend responds with
   `pairingId + installSecret` (both random).
3. Extension stores `{pairingId, installSecret}` in `chrome.storage.local`.
4. Revocation: **Unpair** in the web UI invalidates the secret server-side.
5. Browser reinstall: re-pair (new secret). A single extension instance is
   paired per install; the pairing secret is the extension's identity — any
   process that has it can call the API, so it lives only in
   `chrome.storage.local` (extension-private) and the backend.

### Session authentication

- `POST /api/browser-companion/session` (authenticated by `installSecret`)
  with `{applicationAttemptId}` → creates a **BrowserAssistSession**
  (random `sessionToken`, TTL **10 minutes**, single active session per
  attempt — creating a new one invalidates the old).
- All subsequent calls use `Authorization: Bearer <sessionToken>`.
- The token is bound server-side to: attempt, provider, externalJobId,
  packageSnapshotHash, planFingerprint, approvalFingerprint,
  resumeArtifactHash, canonical action URL. It is usable only for that
  application, expires, is invalidated on completion/cancel/expiry, and is
  never persisted by the browser beyond `chrome.storage.session` (ephemeral,
  cleared when the browser session ends).

### Permissions (narrowest for V1, Lever-only)

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": [
    "https://jobs.lever.co/*",          // content script + page interaction
    "http://127.0.0.1:3000/*"           // localhost API (service worker)
  ],
  "optional_host_permissions": ["http://localhost:3000/*", "http://[::1]:3000/*"],
  "content_scripts": [{ "matches": ["https://jobs.lever.co/*"], "js": ["content.js"] }]
}
```

- No `<all_urls>`, no `webRequest`, no `cookies`, no `tabs` (tab id passed
  via messaging or `activeTab`), no `declarativeNetRequest`, no
  `unlimitedStorage`.
- `storage` (chrome.storage.local for pairing identity, session for
  ephemeral session metadata) is required; everything else is
  optional/activeTab-scoped.

### Localhost endpoint security (Phase 1 hardening list)

- Bind loopback only: publish `127.0.0.1:3000:3000` in compose.
- Reject non-loopback `Host` headers (`127.0.0.1:3000`, `localhost:3000`,
  `[::1]:3000` only).
- No wildcard CORS; CORS `Access-Control-Allow-Origin` absent/`null` for
  extension-origin requests (extension SW fetch does not need CORS); reject
  requests with `Origin` not in the allowed set.
- Bearer session token, short TTL, per-session rate limits.
- Endpoint-specific authorization — every endpoint re-validates the session
  binding (no broad "profile" or "files" APIs).
- No query-param secrets; no secrets in logs (sessionToken truncated,
  answers/resume never logged).
- **PNA**: use `fetch(url, { targetAddressSpace: 'local' })` + host
  permission in the SW.

### Content script model

- Isolated world only (no MAIN-world injection for V1).
- Allowed: verify page URL + expected job/form identity; read current form
  structure (normalized — reuse server-side `parseLeverForm` semantics);
  fill explicitly approved fields (text/select/radio/checkbox) with values
  from the session payload; attach the exact resume bytes (DataTransfer
  pattern); report structured status events.
- Forbidden: eval/Function, arbitrary HTML injection, executing provider-
  supplied JS, scraping unrelated content, passwords/cookies collection,
  CAPTCHA manipulation, generic "selector+script" protocols.

### Page identity verification (Lever adapter)

Before ANY fill: verify hostname `jobs.lever.co`, expected site/company
slug, posting ID from the canonical action URL, and the presence of
`#application-form`. Mismatch → `PAGE_IDENTITY_MISMATCH`, BLOCK, no fill.
Frame handling: top frame only (`allFrames: false`); navigation away →
session abort.

### Approved field transfer

The session payload contains ONLY this application's approved fields:
`{providerFieldId, questionIdentity, type, approvedValue, required,
allowedOptionsHash}` — no Applicant Profile, no CV, no unrelated jobs.
Fresh form structure (re-read at interaction time) is authoritative:
semantic requirements fingerprint comparison vs the approval; mismatch →
`FORM_CHANGED` → Action Required (no silent remapping).

### Resume transfer

**Chosen: extension fetches the exact PDF bytes from
`GET /api/browser-companion/session/:id/resume`** (session-bound, backend
re-verifies ownership + package + expected SHA-256 + artifact existence +
PDF magic before serving bytes), then creates `File` + `DataTransfer` into
the `resume` file input (verified feasible in Chrome). Fallback: user
selects the downloaded PDF manually (existing Download exact resume path).
Phase 1 defers attachment until the fill path is proven; the contract is
frozen now.

### Browser storage policy

- Persistent (`chrome.storage.local`): pairing identity only
  (`{pairingId, installSecret}`).
- Session (`chrome.storage.session`): ephemeral session metadata
  (sessionId/attemptId/expiry — never token-bearing payloads).
- Service-worker memory: transient buffers only.
- NEVER stored: resume bytes, approved answers, Applicant Profile, CAPTCHA
  tokens, provider cookies, legal consent text, package contents.

### Event model (provider-independent, frozen)

`SESSION_OPENED, PAGE_VERIFIED, FORM_DISCOVERED, FORM_CHANGED,
FIELDS_FILLED, RESUME_ATTACHED, HUMAN_ACTION_REQUIRED,
SUBMISSION_INITIATED, SUBMISSION_CONFIRMED, SUBMISSION_UNCONFIRMED,
SESSION_EXPIRED, PAGE_IDENTITY_MISMATCH, COMPANION_ERROR`

Non-PII, typed, idempotency-aware (server dedupes by event id), mapped into
the existing `application_events` model + user status projections.

### CAPTCHA / login / MFA / consent / EEO policy

- CAPTCHA: detect + report `HUMAN_ACTION_REQUIRED`; never click/solve/inject
  tokens/call solvers/suppress widgets/spoof completion.
- Login/MFA: detect + report; never store/type passwords from Tailor AI,
  never intercept OTPs.
- Consent: fill only consent explicitly approved in the authoritative
  approval; text/option change → STOP + Action Required; marketing never
  default.
- EEO: never inferred; optional → omit; required-unapproved →
  `HUMAN_ACTION_REQUIRED`.

### Submission button policy

**V1: the companion NEVER clicks the final submit button.**
Rationale: hosted Lever success semantics are not fully proven; local
first-receipt verification is not ready; CAPTCHA boards dominate current
samples. The user submits; the companion detects outcome where possible.
A future V2 capability may allow submit-on-approval only after provider
success semantics are verified.

### Confirmation

- `PROVIDER_CONFIRMED`: positive DOM evidence only (confirmation page
  marker, success DOM, provider application ID in DOM). NOT: button click,
  navigation alone, tab close, CAPTCHA completion, elapsed time.
- `USER_CONFIRMED`: existing manual flow.
- `UNCONFIRMED` → `SUCCESS_UNCONFIRMED` → Check Submission.
- DOM-level success detection preferred; no broad `webRequest` interception.

### Source of truth

- Backend owns: package, approval, attempt, job identity, resume artifact,
  business state, event persistence.
- Companion owns: current page observation, DOM interaction, ephemeral
  execution progress. The extension is NEVER an authoritative database.

## Architecture diagram

```
+--------------------------------------------------------------------------+
| BROWSER (Chrome, MV3)                                                    |
|                                                                          |
|  Tailor AI web UI (localhost:3000)   Chrome extension                    |
|  ┌─────────────────────────────┐    ┌──────────────────────────────┐    |
|  │ Start Application           │    │ service worker ──localhost───┼───┼──┐
|  │ (existing product command)  │    │   fetch API (host perm)      │    │  │
|  │ Continue in Browser →       │    │ content script (jobs.lever   │    │  │
|  │ postMessage bridge          │───▶│   .co, isolated world)       │    │  │
|  └─────────────────────────────┘    │ Lever page (real ATS)        │    │  │
|  Application Dashboard ← events ────┘   fill/verify/report          │    │  │
+--------------------------------------------------------------------------+
                            │ localhost HTTP
                            │ http://127.0.0.1:3000/api/browser-companion/*
                            ▼
+--------------------------------------------------------------------------+
| HOST: Docker container                                                    |
|  Tailor AI backend (source of truth)                                      |
|   /pair /session /payload /resume /events                                 |
|  - session bound to attempt+package+approval+resume                      |
|  - verified canonical action URL                                         |
|  - application_events persistence                                        |
|  - loopback-only binding (Phase 1: 127.0.0.1:3000)                       |
+--------------------------------------------------------------------------+

Trust boundary: web pages (incl. jobs.lever.co DOM) are UNTRUSTED;
the paired extension + backend are trusted; all localhost calls are
session-authenticated and bound to ONE application.
```

## Session contract (frozen types — see `server/browserCompanion/companionContract.ts`)

```
BrowserAssistSession {
  sessionId, applicationAttemptId, provider, externalJobId,
  canonicalActionUrl, packageSnapshotHash, planFingerprint,
  approvalFingerprint, resumeArtifactHash,
  issuedAt, expiresAt (10 min), nonce, protocolVersion
}
```

Binding: ONE attempt, ONE provider, ONE external job, ONE approved
package/plan/resume. Replay: token + nonce, single active session, TTL,
invalidation on completion/cancel/expiry/package/approval/plan changes.

## Alternative transports rejected

| Option | Rejected because |
|---|---|
| Native Messaging host | binary + registry/native-host manifests per OS, Docker friction, high install friction |
| WebSocket local bridge | service-worker lifecycle complexity, keepalive, no benefit over HTTP |
| Web app → externally_connectable | web UI must hardcode extension ID; breaks unpacked/dev; ID change = breakage |
| Polling local endpoint | same security as HTTP with worse UX/latency |
| Cloud relay / broker | violates local-first |

## Future providers

The `BrowserProviderAdapter` interface (canHandle/verifyPage/inspectForm/
mapApprovedFields/fillFields/attachResume/detectHumanCheckpoint/
detectSubmissionOutcome) keeps ATS specifics in adapters; the session/event
contract is provider-independent (Greenhouse/Ashby/Workday later).

## Open risks

- Chrome PNA enforcement may tighten on extension→localhost (mitigation:
  host permission + `targetAddressSpace: 'local'`; verify in Phase 1).
- Lever hCaptcha boards dominate samples — companion reports
  HUMAN_ACTION_REQUIRED; no bypass.
- Hosted Lever success DOM semantics unverified — confirmation detection is
  a Phase 1 research task against a real no-CAPTCHA page.
- Unpacked-dev extension ID changes — pairing is ID-agnostic (installSecret
  based), so this is safe by design.