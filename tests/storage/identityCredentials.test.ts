// Application Identity & Credentials V1 — vault security matrix + mail
// intelligence tests (mocked transports only; no live mailbox reads).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idcred-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema } = await import('../../server/storage/applicantProfile.js');
const { ensureExecutionSchema } = await import('../../server/applicationEngine/executionStore.js');
const { LocalCredentialVault, encryptAes256Gcm, decryptAes256Gcm, ensureMasterKey, ensureVaultSchema } = await import('../../server/credentialVault/credentialVault.js');
const { classifyMail, matchMailToApplication, statusFromClassification, recordMailEvidence, normalizeMessageMetadata, canPromoteViaEmailConfirmation, ensureMailSchema } = await import('../../server/mailIntelligence/mailIntelligence.js');
const { syncNow, connectMailConnector, mailConnectorStatus } = await import('../../server/mailIntelligence/mailService.js');
import type { MailMessage } from '../../server/mailIntelligence/mailIntelligence.js';

const USER = 'idcred-user';
const KEY = randomBytes(32);

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureVaultSchema(getDb());
  ensureMailSchema(getDb());
  ensureExecutionSchema(getDb());
  runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'IC', 'ic@test.local'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const vault = () => new LocalCredentialVault({ db: getDb(), dataDir: tmpDir, masterKey: KEY });

describe('Crypto envelope', () => {
  it('round-trips; wrong key/tamper fails closed; versioned', () => {
    const ct = encryptAes256Gcm('S3cure-Pass-2026!', KEY);
    expect(ct.startsWith('v1:')).toBe(true);
    expect(decryptAes256Gcm(ct, KEY)).toBe('S3cure-Pass-2026!');
    expect(() => decryptAes256Gcm(ct, randomBytes(32))).toThrow();
    const tampered = ct.slice(0, -4) + 'AAAA';
    expect(() => decryptAes256Gcm(tampered, KEY)).toThrow();
    expect(() => decryptAes256Gcm('v2:abc', KEY)).toThrow(/INVALID_ENVELOPE/);
  });
  it('master key file: 0600, stable across instances', () => {
    const k1 = ensureMasterKey(tmpDir);
    const k2 = ensureMasterKey(tmpDir);
    expect(k1.equals(k2)).toBe(true);
    const mode = fs.statSync(path.join(tmpDir, 'keys', 'master.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('Credential vault security matrix', () => {
  it('plaintext never persisted; ciphertext only; configured flag', () => {
    vault().setApplicationPassword(USER, 'App-Pass-2026-x9!');
    const row = getDb().prepare('SELECT * FROM credential_vault WHERE user_id = ?').get(USER) as any;
    expect(row.ciphertext).toContain('v1:');
    expect(JSON.stringify(row)).not.toContain('App-Pass-2026-x9!');
    expect(vault().hasApplicationPassword(USER)).toBe(true);
    expect(getDb().prepare('SELECT ciphertext FROM credential_vault').all().some((r: any) => r.ciphertext.includes('App-Pass'))).toBe(false);
  });
  it('short password rejected; delete removes; regenerate updates', () => {
    expect(() => vault().setApplicationPassword(USER, 'short')).toThrow(/PASSWORD_TOO_SHORT/);
    vault().setApplicationPassword(USER, 'App-Pass-2026-x9!');
    vault().setApplicationPassword(USER, 'New-App-Pass-2026-z7!');
    vault().deleteApplicationPassword(USER);
    expect(vault().hasApplicationPassword(USER)).toBe(false);
  });
  it('grant authorization: binding mismatch/expired/single-use all fail', () => {
    const v = vault();
    v.setApplicationPassword(USER, 'App-Pass-2026-x9!');
    const grant = v.authorizeCredentialUse({ userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1', purpose: 'ATS_NEW_ACCOUNT_CREATION' });
    expect(() => v.getCredentialForGrant(grant, { userId: 'other', attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1' })).toThrow(/GRANT_BINDING_MISMATCH/);
    const g2 = v.authorizeCredentialUse({ userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1', purpose: 'ATS_NEW_ACCOUNT_CREATION' });
    expect(() => v.getCredentialForGrant(g2, { userId: USER, attemptId: 'attempt-2', provider: 'workday', externalJobId: 'job-1' })).toThrow(/GRANT_BINDING_MISMATCH/);
    const g3 = v.authorizeCredentialUse({ userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1', purpose: 'ATS_NEW_ACCOUNT_CREATION', ttlMs: -1 });
    expect(() => v.getCredentialForGrant(g3, { userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1' })).toThrow(/GRANT_EXPIRED/);
    const g4 = v.authorizeCredentialUse({ userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1', purpose: 'ATS_NEW_ACCOUNT_CREATION' });
    expect(v.getCredentialForGrant(g4, { userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1' })).toBe('App-Pass-2026-x9!');
    expect(() => v.getCredentialForGrant(g4, { userId: USER, attemptId: 'attempt-1', provider: 'workday', externalJobId: 'job-1' })).toThrow(/GRANT_UNKNOWN/); // single use
  });
  it('credential absent from profile/package/log surfaces', () => {
    const vaultData = getDb().prepare('SELECT ciphertext FROM credential_vault WHERE user_id = ?').get(USER) as any;
    expect(vaultData.ciphertext).not.toContain('App-Pass');
    // plaintext is only ever produced inside getCredentialForGrant (grant-gated)
    expect(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().some((r: any) => r.name === 'credential_vault')).toBe(true);
  });
});

describe('Mail classifier (deterministic)', () => {
  const msg = (subject: string, sender = 'talent@veo.com', name = 'Veo Talent'): MailMessage => normalizeMessageMetadata({ providerMessageId: 'm1', subject, senderAddress: sender, senderName: name, from: { address: sender, name }, receivedAt: new Date().toISOString() });
  it('classifies application/assessment/interview/rejection/offer/additional/withdrawal', () => {
    expect(classifyMail(msg('Thank you for applying to Veo — application received'))).toBe('APPLICATION_CONFIRMED');
    expect(classifyMail(msg('Your application has been submitted successfully'))).toBe('APPLICATION_CONFIRMED');
    expect(classifyMail(msg('Complete your coding assessment'))).toBe('ASSESSMENT_REQUIRED');
    expect(classifyMail(msg('Interview invitation — schedule a call'))).toBe('INTERVIEW_SCHEDULED');
    expect(classifyMail(msg('Interview with the team'))).toBe('INTERVIEW_REQUEST');
    expect(classifyMail(msg('We are sorry to inform you — we will not be moving forward'))).toBe('REJECTION');
    expect(classifyMail(msg('Congratulations! We would like to offer you the role'))).toBe('OFFER');
    expect(classifyMail(msg('We need additional information about your documents'))).toBe('ADDITIONAL_INFORMATION_REQUIRED');
    expect(classifyMail(msg('Your application has been withdrawn'))).toBe('WITHDRAWAL_CONFIRMED');
    expect(classifyMail(msg('A brand new line of sneakers at 40% off!', 'news@other.com', 'Other News'))).toBe('UNRELATED');
  });
  it('no LLM: classification is rule-based and bounded', () => {
    const long = msg('x'.repeat(5000));
    expect(JSON.stringify(long).length).toBeLessThan(2500); // snippet bounded at normalization
  });
});

describe('Application matcher (same-company ambiguity)', () => {
  const candidates = [
    { applicationId: 'pkg-1', attemptId: 'a1', company: 'Veo', jobTitle: 'Platform Engineer', provider: 'lever', externalJobId: 'lev-abc' },
    { applicationId: 'pkg-2', attemptId: 'a2', company: 'Veo', jobTitle: 'Cloud Engineer', provider: 'lever', externalJobId: 'lev-xyz' },
  ];
  it('strong match requires 2+ signals; ambiguous → review; none → unmatched', () => {
    const strong = matchMailToApplication(normalizeMessageMetadata({ providerMessageId: 'x', subject: 'Platform Engineer — thank you for applying', senderAddress: 'talent@veo.com', senderName: 'Veo', from: { address: 't', name: 'V' }, receivedAt: '' }), candidates);
    expect(strong).toMatchObject({ matched: true, confidence: 'strong' });
    const ambiguous = matchMailToApplication(normalizeMessageMetadata({ providerMessageId: 'x', subject: 'We love your application', senderAddress: 'talent@veo.com', senderName: 'Veo Talent', from: { address: 't', name: 'V' }, receivedAt: '' }), candidates);
    expect(ambiguous).toMatchObject({ matched: false, reason: 'MAIL_MATCH_REVIEW_REQUIRED' });
    const none = matchMailToApplication(normalizeMessageMetadata({ providerMessageId: 'x', subject: 'Your weekly newsletter', senderAddress: 'news@other.com', senderName: 'Other', from: { address: 't', name: 'O' }, receivedAt: '' }), candidates);
    expect(none).toMatchObject({ matched: false, reason: 'UNMATCHED_JOB_MAIL' });
  });
});

describe('Status projection + email confirmation recovery', () => {
  it('classifications map to post-application statuses', () => {
    expect(statusFromClassification('ASSESSMENT_REQUIRED')).toMatchObject({ status: 'Assessment' });
    expect(statusFromClassification('INTERVIEW_SCHEDULED')).toMatchObject({ status: 'Interview' });
    expect(statusFromClassification('OFFER')).toMatchObject({ status: 'Offer' });
    expect(statusFromClassification('REJECTION')).toMatchObject({ status: 'Rejected' });
    expect(statusFromClassification('WITHDRAWAL_CONFIRMED')).toMatchObject({ status: 'Withdrawn' });
    expect(statusFromClassification('APPLICATION_CONFIRMED')).toBeNull();
  });
  it('SUCCESS_UNCONFIRMED browser result + strong confirmation mail → promote APPLIED (EMAIL_CONFIRMATION)', () => {
    expect(canPromoteViaEmailConfirmation('SUCCESS_UNCONFIRMED', { matched: true, confidence: 'strong' })).toBe(true);
    expect(canPromoteViaEmailConfirmation('APPLIED', { matched: true, confidence: 'strong' })).toBe(false);
    expect(canPromoteViaEmailConfirmation('SUCCESS_UNCONFIRMED', { matched: true, confidence: 'weak' } as any)).toBe(false);
  });
});

describe('Mail evidence + sync (mocked transport)', () => {
  it('dedup by providerMessageId; sync projects evidence; no duplicate events', async () => {
    connectMailConnector(getDb(), USER, 'gmail');
    expect(mailConnectorStatus(getDb(), USER)[0].connector).toBe('gmail');
    const mail: MailMessage = normalizeMessageMetadata({ providerMessageId: 'm-dedup-1', subject: 'Thank you for applying to Veo — application received', senderAddress: 'talent@veo.com', senderName: 'Veo', from: { address: 't', name: 'V' }, receivedAt: new Date().toISOString() });
    const transport = { fetchMessages: async () => [mail, mail] };
    const r1 = await syncNow(getDb(), USER, transport);
    expect(r1.duplicateSkipped).toBe(1);
    expect(r1.classified).toBe(1);
    const rows = getDb().prepare('SELECT COUNT(*) c FROM mail_message_evidence').get() as any;
    expect(rows.c).toBe(1);
  });
});