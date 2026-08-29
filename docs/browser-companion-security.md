# Browser Companion — Security Model

Concise security reference for the local Browser Companion (V2 Phase 0).
Complements the ADR (trust model, transport, permissions) without
duplicating it. Focus: trust boundaries, threats, controls, PII policy,
CAPTCHA policy, session lifecycle.

## Trust boundaries

```
[BROWSER]                    [HOST]
web pages (untrusted)        Tailor AI backend (trusted — source of truth)
jobs.lever.co DOM (untrusted)  ├─ application package/approval/attempt
Tailor AI web UI (trusted*)    ├─ resume artifact (immutable, hashed)
paired extension (trusted)     ├─ session authority
other extensions (untrusted)   └─ event persistence
other local processes (untrusted)
```

- Trusted: the paired extension instance, the local backend, the user.
- Untrusted: EVERY web page and its DOM (an XSS on jobs.lever.co is
  attacker-controlled content), other local processes, replayed requests.
- *The Tailor AI web UI is trusted only as far as the app itself is not
  XSS-compromised; the companion never trusts page JS — the extension
  content script runs in an isolated world and only follows its own
  session contract.

## Threats and controls

| Threat | Impact | Mitigation | Residual risk |
|---|---|---|---|
| Malicious website calls Tailor localhost API | Data exfiltration / state corruption | Loopback-only bind; strict Host header; bearer session token required; no CORS; PNA blocks public→private by default; token is one-application-scoped, TTL 10 min | None practical (token never known to pages) |
| Malicious page on jobs.lever.co origin (XSS) | Session hijack via page JS | Content script in isolated world — page JS cannot read extension state/messages; session token never touches page scope; fill only via content script with identity checks | Page DOM is adversary-controlled — fill is validated against approved values only |
| Compromised extension (other extension, malware) | Steal pairing secret / answers | Pairing secret lives in chrome.storage.local (extension-private); session token ephemeral in chrome.storage.session; payloads application-scoped; no broad permissions; no webRequest | Full local compromise = full local data loss (accepted — same as any local app) |
| Another local process calls the API | Same as above | Loopback bind + Host check + bearer token + rate limits + no static universal token (installSecret + per-session token + pairing revocation) | A process with OS access to the user's chrome.storage or config already owns the machine |
| Replay of an old BrowserAssistSession | Re-fill/re-request a stale application | Single active session per attempt; TTL 10 min; invalidated on completion/cancel/expiry/package/approval/plan change; nonce | Very low (token never persisted long-term) |
| Cross-job / cross-user session reuse | Apply wrong job / wrong user | Session bound server-side to attempt → user → provider → externalJobId → package → plan → approval → resume hash; every endpoint re-validates the binding | None (binding rechecked per request) |
| Resume substitution | Attach wrong resume | Resume endpoint re-reads artifact by hash, re-verifies SHA-256 + size + PDF magic + ownership per request; no arbitrary file path; no filename from extension | None |
| Arbitrary URL navigation / tab hijack | Companion acts on wrong page | Identity verification (hostname + slug + posting id + #application-form) before ANY fill; PAGE_IDENTITY_MISMATCH blocks; top-frame only | Malicious redirect to a lookalike host fails host check |
| Iframe confusion | Fill a hidden iframe | `allFrames: false`; content script acts on top frame only | None |
| Tab reuse / tab cloning | Stale session on wrong page | Session bound to canonical URL; identity re-check each navigation; SESSION_EXPIRED on mismatch | None |
| XSS in Tailor AI UI | Trigger companion actions | Companion only acts on its own session messages; web UI bridge passes only sessionId/attemptId (no free-form instructions) | Must audit the postMessage bridge in Phase 1 |
| ATS page DOM injection | Altered form filled wrongly | Fresh form reinspection; requirements fingerprint compare vs approval; FORM_CHANGED blocks; fill only approved values mapped to CURRENT provider structure | Provider text is untrusted — never executed (no eval/HTML injection) |
| Arbitrary JS execution | Full compromise of the tab | No eval, no Function, no injected scripts, no "selector+script" protocol; content script has a fixed capability set | None |
| Leaking answers into logs | PII exposure | Logging allowlist: session id (truncated), provider, non-sensitive event, error code, protocol version only | None |
| Leaking resume bytes | Resume exposure | Resume bytes never logged, never stored by extension, never in event metadata; only served via session-bound endpoint | None |
| Service-worker restart / browser crash | Lost session state | Ephemeral state in chrome.storage.session survives SW restarts; on browser restart: SESSION_EXPIRED → user restarts from dashboard; no corrupted Applied | Rely on dashboard state (authoritative) |
| Docker restart mid-session | Session dies | Sessions are in-memory/DB? (design: SQLite-backed, TTL) — on restart sessions expire; safe fallback WAITING_FOR_YOU / restart | None |
| Stale event replay | Duplicate events | Event id idempotency (server dedupe); append-only log | None |

## PII policy

- Extension may receive, per active session ONLY: this application's
  approved fields (name/email/phone/location/approved answers/approved
  links) and the exact resume bytes for THIS application.
- Never received: Applicant Profile, Master CV JSON, other applications,
  search history, API/LLM keys, Apify token, database contents, other
  users' data.
- No PII telemetry; no cloud.

## CAPTCHA policy (frozen)

- Detect + report HUMAN_ACTION_REQUIRED; show/focus the real page.
- NEVER: click/solve, inject tokens, call solver APIs, replay tokens,
  suppress the widget, spoof completion, modify challenge scripts.

## Login / MFA policy (frozen)

- Detect + report. Never store credentials, never type passwords from
  Tailor AI data, never intercept OTPs, never read unrelated auth fields.

## Session lifecycle

1. Pair (one-time code) → installSecret (chrome.storage.local).
2. Start Application → web UI bridge → extension creates session
   (10-min TTL, single per attempt).
3. Extension opens canonical URL → PAGE_VERIFIED → fill → events.
4. Human checkpoint → HUMAN_ACTION_REQUIRED → user completes → user submits.
5. Confirmation detection or USER_CONFIRMED → session invalidated.
6. Expiry/cancel/plan-change/package-change → invalidated; user restarts
   from the dashboard.

## Controls recap (checklist for Phase 1)

- [ ] compose publishes 127.0.0.1 only
- [ ] Host-header allowlist middleware
- [ ] No CORS wildcards; Origin rejection policy
- [ ] Session token: random, 10-min TTL, single-active-per-attempt
- [ ] Every endpoint re-validates full session binding
- [ ] Resume endpoint: hash+size+magic+ownership per request
- [ ] Rate limits per session
- [ ] Log allowlist enforced (no PII)
- [ ] content script: isolated world, fixed capabilities, no eval
- [ ] identity verification before fill (host/slug/posting/form)
- [ ] requirements-fingerprint compare vs approval (FORM_CHANGED blocks)
- [ ] CAPTCHA untouched (frozen policy)
- [ ] no webRequest; no <all_urls>; no cookies permission