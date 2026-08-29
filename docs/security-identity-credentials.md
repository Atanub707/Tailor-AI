# Security Model — Application Identity & Credentials V1

Complements `docs/adr/identity-credentials-v1.md`. Focus: trust boundaries,
threats, controls, password policy, mail privacy, OTP boundary.

## Boundaries

- TRUSTED: local backend, paired extension, the user.
- UNTRUSTED: every web page (incl. ATS pages), other processes, mail
  providers (transit), replayed requests.
- Plaintext Application Password exists only: (a) at the moment the user
  sets/generates it (transit through the local web API), (b) inside the
  single-use grant consumption by the extension for ONE account-creation
  fill. It is NEVER persisted, logged, or returned by any read API.

## Controls

| Threat | Mitigation | Residual |
|---|---|---|
| DB leak → password | AES-256-GCM envelope, master key 0600, no plaintext anywhere | Master-key file compromise = full local compromise (accepted local-first) |
| Tampered ciphertext | GCM auth tag + version check → fail closed | None |
| Wrong user/attempt/provider/purpose | Grant binding + single-use + 5-min expiry + pairing check | None practical |
| Password via page bridge | postMessage carries only sessionId; credential flows SW→content-script message (LEVER_RESUME-like), memory only | Page XSS cannot reach it |
| Extension storage leak | credential never in chrome.storage/IndexedDB/localStorage; pairing secret TRUSTED_CONTEXTS | Compromised extension = local app compromise |
| Existing ATS password collection | Architecturally absent — no fields, no API, no storage for them | None (policy + code audit) |
| Email OTP/verification links | Mail intelligence classifies EMAIL_VERIFICATION_REQUIRED / OTP_REQUIRED; never consumes codes, never clicks links | User handles the boundary |
| Mail body leak | Evidence stores metadata only; snippet bounded 500 chars, sanitized; no attachments/images | None |
| Duplicate mail events | providerMessageId dedup + idempotent evidence id | None |
| Wrong-application mail match | 2+ evidence signals for auto-update; 1 signal → review; same-company ambiguity → review | Ambiguous mails stay unreviewed until user reviews |

## Password policy

Min 12 (generated ≥16, cryptographically secure, upper/lower/digits/symbols).
Provider policy rejection → PASSWORD_POLICY_REJECTED + "generate a
compatible password for this account" WITHOUT silently overwriting the
global Application Password (explicit approval required). Regenerate warns:
existing ATS accounts keep the old password.

## Mail privacy

- Emails stay in the user's inbox; connector reads are OAuth-authorized.
- Gmail scope note (transparent): mailbox read may technically allow
  broader inbox access; Tailor AI filters locally and persists metadata
  only. No proxy email service; no forwarding.
- OAuth tokens encrypted via the vault; disconnect/revoke supported.

## OTP boundary (frozen)

Verification codes, magic links, OTPs are NEVER read/extracted/consumed/
auto-filled. They remain an authentication boundary handled by the user.

## Mailbox passwords

Tailor AI never asks for or stores mailbox passwords (OAuth only; IMAP
app-password only if the user explicitly chooses it, stored in the vault).
