# Tailor AI Browser Companion — Chrome extension (Phase 1)

Local-first assistant for approved Tailor AI applications. Fills the
approved fields on the real Lever application page. It NEVER submits, NEVER
solves CAPTCHAs, and NEVER touches your resume.

## What it does (Phase 1)

- Pairs with your local Tailor AI instance (one-time code from
  Settings → Browser Companion).
- From the Applications dashboard: **Continue in Browser** opens the
  verified Lever apply page in a new tab.
- Verifies the page identity (jobs.lever.co + site slug + posting ID +
  `#application-form`) BEFORE touching anything.
- Inspects the current form; if it changed vs the approval → stops
  (`FORM_CHANGED` → Action Required).
- Fills ONLY approved fields (text/email/tel/textarea/select/radio/
  checkbox) with exact approved values — no guessing, no nearest-neighbor.
- Detects hCaptcha structurally → reports Human Action Required; the user
  completes it on the real page.
- Reports structured, non-PII events to the local backend.

It does NOT: click the final Submit button, attach/upload the resume, solve
or click CAPTCHAs, read cookies or passwords, run in iframes, or use the
MAIN world.

## Permissions (why each exists)

| Entry | Why |
|---|---|
| `storage` | store pairing identity (`chrome.storage.local`) and ephemeral session metadata (`chrome.storage.session`) |
| `https://jobs.lever.co/*` (host) | content script + page interaction for Lever applications |
| `http://127.0.0.1:3000/*` (host) | localhost API calls from the service worker (CORS-exempt in extension context) |
| optional `http://localhost:3000/*`, `http://[::1]:3000/*` | IPv6/localhost-alias variants |
| `content_scripts` on jobs.lever.co + local web app | lever adapter + Tailor UI bridge |

No `<all_urls>`, no `webRequest`, no `cookies`, no `tabs`, no
`declarativeNetRequest`, no `unlimitedStorage`.

## Local-only architecture

```
Tailor web UI ──postMessage({sessionId})──▶ bridge content script
        ┌─────────────────────────────────────────┐
        │ extension service worker                │
        │  └─ localhost HTTP (127.0.0.1:3000)     │
        │      pairing / session claim / payload  │
        │      events                             │
        │  └─ Lever content script (isolated)     │
        │      verify → inspect → fill → report   │
        └─────────────────────────────────────────┘
All data stays on your machine. No cloud, no telemetry.
```

## Development installation (unpacked)

1. Build not required — plain JS.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. **Load unpacked** → select the `browser-extension/` directory.
5. Open the extension options (right-click the icon → Options) and pair
   with the code from Tailor AI → Settings → Browser Companion.

No native host, no registry changes, no Web Store publication.

## CAPTCHA policy

The extension detects the widget and stops. It never clicks, solves,
injects tokens, or modifies challenge scripts. Human verification remains
human.

## Manual fallback

If the extension is missing/unpaired/outdated, the dashboard still offers
**Continue on Lever** — the manual flow works exactly as before. The
companion is an enhancement, not a dependency.

## Security notes

- All localhost traffic happens in the service worker (extension origin,
  CORS-exempt via host permission); content scripts never fetch localhost.
- The web page bridge carries ONLY `{sessionId}` — never answers, tokens,
  or secrets.
- Sessions are 10-minute, single-active-per-attempt, bound to
  attempt/package/plan/approval/resume; the backend revalidates bindings on
  every call.
- No PII is logged anywhere (backend or extension).

## Phase 1 exclusions (frozen)

- No final Submit click.
- No resume attachment (exact PDF remains available via the dashboard
  download).
- No SUBMISSION_* events (success semantics not yet proven).
- No MAIN-world injection.