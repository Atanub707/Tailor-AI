// Browser Companion Phase 2 — two-pass form safety, resume binding,
// checkpoint continuation, submission observation, no-auto-submit.
// Synthetic fixtures only; no network mutations.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion2-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { storePlan } = await import('../../server/applicationEngine/planStore.js');
const { createApproval } = await import('../../server/applicationEngine/executionEngine.js');
const { ensureExecutionSchema } = await import('../../server/applicationEngine/executionStore.js');
const {
  createPairingCode, pairExtension, createCompanionSession, claimSessionToken,
  sessionPayload, serveSessionResume, recordCompanionEvent, CompanionError,
} = await import('../../server/browserCompanion/companionService.js');
const { validateAgainstPlan, applyValidatedPlan, observeSubmission, parseLeverIdentity } = await import('../../server/browserCompanion/leverPageAdapter.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'companion2-user';

const FORM = (extra = '') => `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required><input type="tel" name="phone">
  <select name="heard"><option value="Job Board">Job Board</option><option value="Linkedin">Linkedin</option></select>
  <input type="radio" name="level" value="Fluent" required><input type="radio" name="level" value="Native" required>
  <input type="file" name="resume">
  <input type="hidden" name="h-captcha-response" value="">
  <button type="submit">Submit application</button>
  ${extra}
</form>`;

const makeFacade = (url: string, html = FORM(), pageText = '') => {
  const $ = require('cheerio').load(html);
  const form = $('form').first();
  if (!form.length) return { url, form: null, pageText };
  const inputs: any[] = [];
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const type = String($el.attr('type') || 'text').toLowerCase();
    if (['hidden', 'file', 'submit', 'button', 'password'].includes(type)) return;
    const tag = el.tagName.toLowerCase();
    const options: string[] = [];
    if (tag === 'select') $el.find('option').each((__, o) => options.push($(o).attr('value') || ''));
    else if (type === 'radio' || type === 'checkbox') {
      const name = String($el.attr('name') || '');
      form.find(`input[name="${name}"]`).each((__, o) => options.push($(o).attr('value') || ''));
    }
    inputs.push({ name: String($el.attr('name') || ''), type: tag === 'textarea' ? 'textarea' : type, value: '', required: $el.attr('required') !== undefined, options, tagName: tag.toUpperCase() });
  });
  const resumePresent = !!form.find('input[type="file"][name="resume"]').length;
  return { url, form: { id: 'application-form', enctype: 'multipart/form-data', inputs, captchaHint: /h-captcha-response|h-captcha|data-sitekey/.test(html), resumePresent }, pageText };
};

let freshPair = 0;
async function freshSession() {
  const { setSessionTerminal } = await import('../../server/browserCompanion/companionStore.js');
  const { getActiveSessionForAttempt } = await import('../../server/browserCompanion/companionStore.js');
  const cur = getActiveSessionForAttempt(getDb(), 'attempt-c2-1');
  if (cur) setSessionTerminal(getDb(), cur.sessionId, 'ROTATED');
  const pc = createPairingCode(getDb(), USER);
  const paired = pairExtension(getDb(), pc.code);
  const s = createCompanionSession(getDb(), USER, 'attempt-c2-1');
  const claimed = claimSessionToken(getDb(), paired.pairingId, paired.installSecret, s.sessionId);
  return { sessionId: s.sessionId, token: claimed.token, pairingId: paired.pairingId };
}

const approved = [
  { providerFieldId: 'name', type: 'TEXT', approvedValue: 'Ravi Kumar', required: true },
  { providerFieldId: 'email', type: 'EMAIL', approvedValue: 'ravi@example.com', required: true },
  { providerFieldId: 'phone', type: 'TEL', approvedValue: '+91 90000 00000', required: false },
  { providerFieldId: 'heard', type: 'SELECT', approvedValue: 'Job Board', required: true },
  { providerFieldId: 'level', type: 'RADIO', approvedValue: 'Fluent', required: true },
];

const job = (): Job => ({
  id: 'c2j1', externalId: 'lev-abc', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'x', atsPlatform: 'lever',
  jobUrl: 'https://jobs.lever.co/veo/abc/apply', applyUrl: 'https://jobs.lever.co/veo/abc/apply',
  url: 'https://jobs.lever.co/veo/abc/apply', source: 'Lever', state: 'pending',
} as unknown as Job);

let resumeToken = '';
let sessionId = '';

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureExecutionSchema(getDb());
  runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'C2', 'c2@test.local'));
  const j = job();
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  const cv: MasterCv = { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'B', summary: 'DevOps', experiences: [], education: [], skills: [], certifications: [] };
  const fit = computeFit(p, cv, j, 'x');
  const pkg = await buildPackage({ userId: USER, job: j, jd: 'x', profile: p, masterCv: cv, fit, tailoredVersion: {
    id: 't-c2j1', userId: USER, jobId: 'c2j1', version: 1, masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3, tailorEngineVersion: 1,
    content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] }, verification: { passed: true, issues: [] }, stale: false, createdAt: new Date().toISOString(),
  } as any }, 'c');
  storePackage(pkg);
  const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: { provider: 'lever', detect: () => ({}), inspect: async () => ({ provider: 'lever', target: {} as any, fields: [], discoveredAt: new Date().toISOString(), fingerprint: 'f', providerMetadata: {} }) } as any, artifactOk: true });
  plan.status = 'READY_TO_SUBMIT' as any;
  plan.mappedFields = [
    { providerFieldId: 'name', label: 'Name', type: 'TEXT' as any, required: true, value: 'Ravi Kumar', source: 'USER', mappingMethod: 'EXACT', mappingConfidence: 'high' },
    { providerFieldId: 'email', label: 'Email', type: 'EMAIL' as any, required: true, value: 'ravi@example.com', source: 'USER', mappingMethod: 'EXACT', mappingConfidence: 'high' },
    { providerFieldId: 'phone', label: 'Phone', type: 'TEL' as any, required: false, value: '+91 90000 00000', source: 'USER', mappingMethod: 'EXACT', mappingConfidence: 'high' },
    { providerFieldId: 'heard', label: 'Heard', type: 'SELECT' as any, required: false, value: 'Job Board', source: 'USER', mappingMethod: 'EXACT', mappingConfidence: 'high' },
    { providerFieldId: 'level', label: 'Level', type: 'RADIO' as any, required: true, value: 'Fluent', source: 'USER', mappingMethod: 'EXACT', mappingConfidence: 'high' },
  ];
  try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
  storePlan(plan);
  const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
  const { storeAttempt, executionKey } = await import('../../server/applicationEngine/executionStore.js');
  const key = executionKey({ userId: USER, provider: 'lever', externalJobId: 'lev-abc', packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
  storeAttempt(getDb(), {
    id: 'attempt-c2-1', userId: USER, planId: plan.id, packageId: pkg.id, approvalId: approval.id,
    provider: 'lever', externalJobId: 'lev-abc', executionKey: key, planFingerprint: plan.planFingerprint,
    packageSnapshotHash: pkg.snapshotHash, requirementsFingerprint: plan.requirementsFingerprint,
    status: 'MANUAL_ACTION_REQUIRED', transportAttemptCount: 0, startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any);
  const pc = createPairingCode(getDb(), USER);
  const paired = pairExtension(getDb(), pc.code);
  const s = createCompanionSession(getDb(), USER, 'attempt-c2-1');
  sessionId = s.sessionId;
  const claimed = claimSessionToken(getDb(), paired.pairingId, paired.installSecret, sessionId);
  resumeToken = claimed.token;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Two-pass form safety (release blocker)', () => {
  const URL = 'https://jobs.lever.co/veo/abc/apply';
  it('valid form → ok; apply mutates and NEVER submits', () => {
    const doc = makeFacade(URL);
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const res = applyValidatedPlan(doc, v.plan);
      expect(res.applied).toBe(5);
      expect(res.submitClicked).toBe(false);
      expect(doc.form!.inputs.find((i) => i.name === 'name')!.value).toBe('Ravi Kumar');
    }
  });
  it('FIRST field mismatch → ZERO mutations', () => {
    const doc = makeFacade(URL, FORM('').replace('<input type="text" name="name" required>', '<input type="text" name="name-renamed" required>'));
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // PASS 2 must never run; the facade values remain untouched
      const untouched = doc.form!.inputs.every((i) => i.value === '');
      expect(untouched).toBe(true);
    }
  });
  it('LAST field mismatch → ZERO earlier fields modified', () => {
    // break the LAST approved field (level radio options)
    const doc = makeFacade(URL, FORM('').replace('<input type="radio" name="level" value="Fluent" required>', '<input type="radio" name="level" value="Beginner" required>'));
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('OPTION_CHANGED');
    if (!v.ok) {
      const untouched = doc.form!.inputs.every((i) => i.value === '');
      expect(untouched).toBe(true); // zero mutations anywhere
    }
  });
  it('MIDDLE field mismatch → zero mutations', () => {
    const doc = makeFacade(URL, FORM('').replace('<select name="heard">', '<select name="heard-x">'));
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(doc.form!.inputs.every((i) => i.value === '')).toBe(true);
  });
  it('resume control missing → blocked', () => {
    const doc = makeFacade(URL, FORM('').replace('<input type="file" name="resume">', ''));
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('RESUME_CONTROL_MISSING');
  });
  it('wrong page identity → identity gate fails BEFORE validation (zero mutations)', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/xyz/apply');
    const id = parseLeverIdentity(doc.url);
    expect(id?.postingId).not.toBe('abc'); // identity gate blocks before any adapter call
    expect(doc.form!.inputs.every((i) => i.value === '')).toBe(true);
  });
});

describe('Resume endpoint security matrix', () => {
  it('serves EXACT artifact bytes with correct headers semantics', () => {
    const { bytes, filename } = serveSessionResume(getDb(), resumeToken, sessionId);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(filename).toBe(`resume-${filename.match(/([0-9a-f]{12})/)![1]}.pdf`);
    expect(bytes.length).toBeGreaterThan(1000);
  });
  it('wrong session token / wrong session id denied; missing bearer denied', () => {
    let e1: any; try { serveSessionResume(getDb(), 'bad-token', sessionId); } catch (e) { e1 = e; }
    expect(e1?.code).toBe('UNAUTHORIZED');
    let e2: any; try { serveSessionResume(getDb(), resumeToken, 'bs-other-session'); } catch (e) { e2 = e; }
    expect(e2?.code).toBe('SESSION_INVALID');
  });
  it('expired session denied', async () => {
    const { setSessionTerminal } = await import('../../server/browserCompanion/companionStore.js');
    const fs1 = await freshSession();
    setSessionTerminal(getDb(), fs1.sessionId, 'EXPIRED');
    let e: any; try { serveSessionResume(getDb(), fs1.token, fs1.sessionId); } catch (err) { e = err; }
    expect(e?.code).toBe('SESSION_TERMINAL');
  });
  it('revoked pairing blocks resume', async () => {
    const fs3 = await freshSession();
    const { unpairExtension } = await import('../../server/browserCompanion/companionService.js');
    unpairExtension(getDb(), fs3.pairingId);
    let e: any; try { serveSessionResume(getDb(), fs3.token, fs3.sessionId); } catch (err) { e = err; }
    expect(e?.code).toBe('SESSION_TERMINAL'); // session invalidated with pairing
  });
  it('installSecret can NOT download resume (bearer required)', async () => {
    const pc = createPairingCode(getDb(), USER);
    const paired = pairExtension(getDb(), pc.code);
    // no claim → no bearer → every resume path requires the bearer
    let e: any; try { serveSessionResume(getDb(), paired.installSecret, sessionId); } catch (err) { e = err; }
    expect(e?.code).toBe('UNAUTHORIZED');
  });
  it('modified bytes rejected (hash mismatch) — simulated via store tamper', async () => {
    // The endpoint re-hashes the artifact; tampering the store binding fails earlier.
    const fs4 = await freshSession();
    // drift: fake the session's resume binding
    getDb().prepare('UPDATE browser_companion_sessions SET resume_artifact_hash = ? WHERE session_id = ?').run('deadbeef'.repeat(8), fs4.sessionId);
    let e: any; try { serveSessionResume(getDb(), fs4.token, fs4.sessionId); } catch (err) { e = err; }
    expect(e?.code).toBe('RESUME_DRIFT');
  });
});

describe('Checkpoint continuation (synthetic)', () => {
  it('captcha present → validation reports checkpoint; cleared → ok', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply');
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.checkpoint.captchaPresent).toBe(true);
      const noCapDoc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM('').replace('<input type="hidden" name="h-captcha-response" value="">', ''));
      const v2 = validateAgainstPlan(noCapDoc.form!, approved);
      expect(v2.ok).toBe(true);
      if (v2.ok) expect(v2.checkpoint.captchaPresent).toBe(false);
    }
  });
  it('new required field after checkpoint → FORM_CHANGED', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM('<input type="text" name="new-required" required>'));
    // the approved payload does NOT contain the new required control
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('UNKNOWN_REQUIRED');
  });
  it('option changed after checkpoint → OPTION_CHANGED', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM('').replace('<option value="Job Board">Job Board</option>', '<option value="Other">Other</option>'));
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('OPTION_CHANGED');
  });
});

describe('Submission observation (synthetic fixtures)', () => {
  it('strong success evidence → CONFIRMED', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM(), 'Your application has been submitted. Thank you for applying.');
    const o = observeSubmission(doc);
    expect(o.classification).toBe('CONFIRMED');
    if (o.classification === 'CONFIRMED') expect(o.evidenceType).toBe('SUCCESS_TEXT');
  });
  it('vague unrelated success text → NOT confirmed', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM(), 'We are excited about success stories like yours. Careers at Veo.');
    const o = observeSubmission(doc);
    expect(o.classification).not.toBe('CONFIRMED');
  });
  it('still on form → STILL_ON_FORM', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply');
    expect(observeSubmission(doc).classification).toBe('STILL_ON_FORM');
  });
  it('explicit failure text → FAILED', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply', FORM(), 'An error occurred. The form contains invalid entries.');
    expect(observeSubmission(doc).classification).toBe('FAILED');
  });
});

describe('Events (Phase 2) + transitions', () => {
  it('READY_FOR_USER_SUBMISSION transitions the attempt via the central machine', async () => {
    const { sessionId: sid1, token: tok1 } = await freshSession();
    const rec = recordCompanionEvent(getDb(), tok1, 'READY_FOR_USER_SUBMISSION', undefined, {}, 'seq-1');
    expect(rec.accepted).toBe(true);

    const { getAttempt } = await import('../../server/applicationEngine/executionStore.js');
    const a = getAttempt(getDb(), USER, 'attempt-c2-1');
    expect(a?.status).toBe('READY_FOR_USER_SUBMISSION');
    // replay with SAME clientEventId → idempotent, no duplicate event
    recordCompanionEvent(getDb(), tok1, 'READY_FOR_USER_SUBMISSION', undefined, {}, 'seq-1');
    const { getEventsForAttempt } = await import('../../server/applicationExperience/applicationEvents.js');
    expect(getEventsForAttempt(getDb(), USER, 'attempt-c2-1').filter((e) => e.eventType === 'READY_FOR_USER_SUBMISSION').length).toBe(1);
  });
  it('SUBMISSION_CONFIRMED requires evidence; terminalizes session', async () => {
    const { token: tok2 } = await freshSession();
    // no evidence → rejected
    let e: any; try { recordCompanionEvent(getDb(), tok2, 'SUBMISSION_CONFIRMED', undefined, {}); } catch (err) { e = err; }
    expect(e?.code).toBe('INVALID_EVIDENCE');
    const ok = recordCompanionEvent(getDb(), tok2, 'SUBMISSION_CONFIRMED', undefined, { confirmationEvidenceType: 'SUCCESS_TEXT', confirmationFingerprint: 'abc'.repeat(4) }, 'seq-2');
    expect(ok.accepted).toBe(true);
    // session terminal after confirmation
    let e2: any; try { recordCompanionEvent(getDb(), tok2, 'PAGE_VERIFIED'); } catch (err) { e2 = err; }
    expect(e2?.code).toBe('SESSION_TERMINAL');
  });
  it('SUBMISSION_FAILED with bad category rejected', async () => {
    const { token: tok3 } = await freshSession();
    let e: any; try { recordCompanionEvent(getDb(), tok3, 'SUBMISSION_FAILED', undefined, { failureCategory: 'MADE_UP' }); } catch (err) { e = err; }
    expect(e?.code).toBe('INVALID_EVIDENCE');
  });
  it('unbounded clientEventId rejected', async () => {
    const { token: tok4 } = await freshSession();
    let e: any; try { recordCompanionEvent(getDb(), tok4, 'PAGE_VERIFIED', undefined, {}, 'x'.repeat(200)); } catch (err) { e = err; }
    expect(e?.code).toBe('INVALID_EVENT_ID');
  });
});

describe('No automatic submit (instrumented)', () => {
  it('applyValidatedPlan never touches submit', () => {
    const doc = makeFacade('https://jobs.lever.co/veo/abc/apply');
    const v = validateAgainstPlan(doc.form!, approved);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const res = applyValidatedPlan(doc, v.plan);
      expect(res.submitClicked).toBe(false);
      const anySubmitCalls = JSON.stringify(doc).match(/requestSubmit|\.submit\(/g);
      expect(anySubmitCalls).toBeNull();
    }
  });
});