# ADR — Application Identity & Credentials V1

Status: ACCEPTED (foundation) · Base: `eb22b69` · Branch: `feat/application-identity-credentials-v1`

## Context

Account-heavy ATS workflows (Workday/iCIMS/Oracle later) require a real
user identity + a dedicated Application Password + the ability to learn
application outcomes from employer email. Tailor AI stays local-first.

## Decisions

### Application Identity
Applications use the user's REAL identity (ApplicantProfile email). No
proxy emails, no temporary addresses, no Tailor-owned forwarding. Email
delivery stays DIRECT to the user's real inbox.

### Existing ATS accounts
Tailor AI NEVER asks for or stores existing ATS passwords. Existing-account
login = user action on the provider page (password manager, SSO, passkey,
manual, MFA); Tailor AI waits and resumes after the user returns. Checkpoint
LOGIN_REQUIRED.

### New ATS accounts
For NEW-account creation only, Tailor AI may fill: real email + a DEDICATED
Application Password (≥12 chars; generated ≥16; never the user's email/
banking password; never an existing ATS password). Account creation remains
user-visible; required terms only with exact explicit approval; marketing
never auto-opted-in; CAPTCHA/email verification/MFA remain human.

### Credential Vault
- Encryption: AES-256-GCM (node:crypto) — AEAD, random 12-byte nonce,
  auth tag, versioned envelope `v1:nonce:tag:ciphertext`, tamper-detecting,
  fail-closed. No invented crypto, no base64-as-encryption, no hardcoded key.
- Master key: local installation key (32 random bytes) at
  `<dataDir>/keys/master.key`, chmod 0600. Platform notes: macOS/Linux 0600
  enforced; Windows best-effort via user-profile ACLs; Docker: lives in the
  named data volume. OS keychain (keytar unmaintained; safeStorage
  Electron-only) rejected as a dependency for this runtime — documented
  limitation.
- Storage: `credential_vault` table, ciphertext only, no hints, never in
  ApplicantProfile/package/plan/approval/attempt/events/logs/extension.
- Authorization: plaintext released ONLY via a short-lived (5-min)
  single-use grant bound to user+attempt+provider+externalJobId+purpose
  (`ATS_NEW_ACCOUNT_CREATION`); grant consumed by the paired extension
  claim; web APIs never return plaintext.
- Browser boundary: password NEVER crosses the page bridge/postMessage/
  DOM/URL/console/events; extension content script receives only the value
  for the single field-fill; memory only, references released; never in
  chrome.storage/IndexedDB/localStorage.

### Mailbox architecture
- Emails go directly to the user's real inbox; Tailor AI may OPTIONALLY read
  via an authorized connector (Gmail OAuth / Microsoft Graph / generic IMAP
  contract) while the app runs (local polling, 10-min default, no webhook
  infra). SMTP in this project is OUTBOUND only — never treated as inbound.
- Classification is deterministic/rule-based (NO LLM by default); no
  clicking links, no attachments, no OTP/verification-code consumption.
- Evidence table persists metadata only (connector/messageId/thread/sender/
  subject/received/classification/match/fingerprint) — no bodies, no
  images, no attachments. Dedup by provider message id.
- Status evidence: browser confirmation remains strong immediate evidence;
  a strongly-matched confirmation email can promote SUCCESS_UNCONFIRMED →
  APPLIED (evidence source EMAIL_CONFIRMATION). Other mail evidence maps to
  Assessment/Interview/Offer/Rejected/Withdrawn projections (never
  overwriting terminal state).
- OAuth tokens are credentials: stored only through the vault abstraction.

## Explicit non-goals (this milestone)
No Workday/iCIMS/Oracle adapters, no auto-submit, no auto account creation
on live providers, no auto OTP consumption, no proxy email service, no UI
redesign. Security doc: `docs/security-identity-credentials.md`.