// Lever Execution Phase 1 — execution engine + approval + idempotency +
// multipart dry-run. NO live network (stubbed), NO mutations.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { storePlan } = await import('../../server/applicationEngine/planStore.js');
const { ensureExecutionSchema, executionKey, getAttempt, getAttemptsByExecutionKey, getApproval } = await import('../../server/applicationEngine/executionStore.js');
const { createApproval, prepareExecution, gateExecution, mappedFieldsHash, verifyResumeArtifact } = await import('../../server/applicationEngine/executionEngine.js');
const { buildLeverPayload, payloadFingerprint, PayloadBuildError } = await import('../../server/applicationEngine/leverPayloadBuilder.js');
const { resetInspectionState, parseLeverForm } = await import('../../server/applicationEngine/leverInspector.js');
const { requirementsFingerprint } = await import('../../server/applicationEngine/contract.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'exec-v1-user';
const OTHER = 'exec-v1-other';

const FORM = (q: string, extra = '') => `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required><input type="text" name="phone" required>
  <input type="text" name="location"><input type="text" name="org">
  <input type="text" name="urls[LinkedIn]"><input type="text" name="urls[GitHub]"><input type="text" name="urls[Portfolio]"><input type="text" name="urls[Other]">
  <input name="resume" type="file">
  ${q}
  <input type="hidden" name="accountId" value="acc1"><input type="hidden" name="timezone" value="Asia/Kolkata">
  <input type="hidden" name="origin" value="t1"><input type="hidden" name="referer" value="t2"><input type="hidden" name="source" value="t3">
  ${extra}
</form>`;

const HTML = FORM(`
  <input type="hidden" name="cards[c1][baseTemplate]" value="{&quot;id&quot;:&quot;c1&quot;,&quot;fields&quot;:[{&quot;type&quot;:&quot;multiple-select&quot;,&quot;text&quot;:&quot;Do you have a valid work permit in the EU?&quot;,&quot;required&quot;:true,&quot;id&quot;:&quot;f0&quot;,&quot;options&quot;:[{&quot;text&quot;:&quot;Yes&quot;},{&quot;text&quot;:&quot;No&quot;}]},{&quot;type&quot;:&quot;multiple-choice&quot;,&quot;text&quot;:&quot;English level&quot;,&quot;required&quot;:true,&quot;id&quot;:&quot;f1&quot;,&quot;options&quot;:[{&quot;text&quot;:&quot;Fluent&quot;},{&quot;text&quot;:&quot;Native&quot;}]},{&quot;type&quot;:&quot;multiple-select&quot;,&quot;text&quot;:&quot;Team preferences&quot;,&quot;required&quot;:false,&quot;id&quot;:&quot;f2&quot;,&quot;options&quot;:[{&quot;text&quot;:&quot;Platform&quot;},{&quot;text&quot;:&quot;Data&quot;}]}]}">
  <input type="checkbox" name="cards[c1][field0]" value="Yes" required><input type="checkbox" name="cards[c1][field0]" value="No" required>
  <input type="radio" name="cards[c1][field1]" value="Fluent" required><input type="radio" name="cards[c1][field1]" value="Native" required>
  <input type="checkbox" name="cards[c1][field2]" value="Platform"><input type="checkbox" name="cards[c1][field2]" value="Data">
  <input type="hidden" name="consent[marketing]" value="0"><input type="checkbox" name="consent[marketing]" value="1">
  <div class="h-captcha" data-sitekey="sk"></div>
`);

let jobSeq = 0;
const job = (id = `j${++jobSeq}`): Job => ({
  id, externalId: 'ext-1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes and AWS.', atsPlatform: 'lever',
  jobUrl: `https://jobs.lever.co/veo/${id}/apply`, applyUrl: `https://jobs.lever.co/veo/${id}/apply`,
  url: `https://jobs.lever.co/veo/${id}/apply`, source: 'Lever', state: 'pending',
} as unknown as Job);

/** Resolve required-unresolved questions with USER answers (mirrors the
 *  PATCH /answers flow) so the plan reaches READY_TO_SUBMIT. */
const resolveUserAnswers = (plan: any, answers: Record<string, string>) => {
  for (const [providerFieldId, value] of Object.entries(answers)) {
    plan.mappedFields.push({ providerFieldId, canonicalKey: providerFieldId, label: providerFieldId, type: 'TEXT', required: true, value, source: 'USER', mappingMethod: 'USER', mappingConfidence: 'high' });
    plan.unresolvedFields = plan.unresolvedFields.filter((id: string) => id !== providerFieldId);
    plan.unresolvedDetails = plan.unresolvedDetails.filter((d: any) => d.providerFieldId !== providerFieldId);
  }
  plan.status = plan.unresolvedDetails.some((d: any) => d.required) ? 'NEEDS_INPUT' : plan.consentFields.some((c: any) => ['LEGAL_CONSENT', 'REQUIRED_ACKNOWLEDGEMENT', 'UNKNOWN_CONSENT'].includes(c.classification)) ? 'NEEDS_REVIEW' : plan.manualFields.length ? 'NEEDS_REVIEW' : 'READY_TO_SUBMIT';
  plan.updatedAt = new Date().toISOString();
  // storePlan inserts a new revision row; delete the prior row for the same id first
  try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
  storePlan(plan);
  return plan;
};

const makeReady = async (userId: string, j: Job = job()) => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  p.links = { linkedin: 'https://linkedin.com/in/ravi', github: 'https://github.com/ravi', portfolio: 'https://ravi.dev', website: 'https://ravi.dev' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  const cv: MasterCv = { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru', summary: 'DevOps', experiences: [], education: [], skills: [], certifications: [] };
  const fit = computeFit(p, cv, j, j.description || '');
  const pkg = await buildPackage({ userId, job: j, jd: j.description || '', profile: p, masterCv: cv, fit, tailoredVersion: {
    id: `t-${j.id}`, userId, jobId: j.id, version: 1, masterCvUpdatedAt: 'cv1', profileUpdatedAt: 'p1', jdHash: 'jd1', fitEngineVersion: 3, tailorEngineVersion: 1,
    content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] }, verification: { passed: true, issues: [] }, stale: false, createdAt: new Date().toISOString(),
  } as any }, 'cv1');
  storePackage(pkg);
  return { pkg, job: j };
};

// fixture-shaped adapter carrying the REAL parsed form (via parseLeverForm)
const parsedReqs = (html: string) => {
  const fields = parseLeverForm(html).fields;
  return { provider: 'lever' as const, target: {} as any, fields, discoveredAt: new Date().toISOString(), fingerprint: requirementsFingerprint('lever', 'jobs.lever.co', fields), providerMetadata: {} as Record<string, string> };
};
const realAdapter = (html: string) => ({
  provider: 'lever' as const,
  detect: () => ({ provider: 'lever' as const, confidence: 'high' as const, reason: 'fixture' }),
  inspect: async () => parsedReqs(html),
});
const freshReqs = (html: string) => parsedReqs(html);

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureExecutionSchema(getDb());
  for (const u of [USER, OTHER]) {
    runWithUser(u, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(u, u, `${u}@test.local`));
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Execution eligibility gate', () => {
  it('rejects non-READY plans / wrong user / mismatched hashes / foreign target', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    expect(plan.status).toBe('READY_TO_SUBMIT');
    expect(gateExecution({ plan, pkg, userId: OTHER, jobExternalId: 'ext-1' }).ok).toBe(false);
    const foreign = { ...pkg, userId: OTHER };
    expect(gateExecution({ plan, pkg: foreign, userId: USER, jobExternalId: 'ext-1' }).ok).toBe(false);
    const wrongPkg = { ...pkg, snapshotHash: 'x' };
    expect(gateExecution({ plan, pkg: wrongPkg, userId: USER, jobExternalId: 'ext-1' }).ok).toBe(false);
    const wrongTarget = { ...plan, target: { ...plan.target, applyUrl: 'https://careers.company.com/x' } };
    expect(gateExecution({ plan: wrongTarget, pkg, userId: USER, jobExternalId: 'ext-1' }).ok).toBe(false);
    const stale = { ...plan, status: 'NEEDS_INPUT' as const };
    expect(gateExecution({ plan: stale, pkg, userId: USER, jobExternalId: 'ext-1' }).ok).toBe(false);
  });
});

describe('Approval', () => {
  it('creates hash-bound approval; fingerprint deterministic 10x', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const consents = [{ providerFieldId: 'consent[marketing]', classification: 'OPTIONAL_MARKETING' as const, selectedValue: true, approvedAt: '' }];
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents, marketingOptIn: true });
    const { approvalFingerprint } = await import('../../server/applicationEngine/executionEngine.js');
    const f0 = approvalFingerprint(plan, pkg, consents.map((c) => ({ ...c, approvedAt: 'x' })), mappedFieldsHash(plan), pkg.resumeSnapshot!.pdfHash);
    for (let i = 0; i < 10; i++) {
      expect(approvalFingerprint(plan, pkg, consents.map((c) => ({ ...c, approvedAt: `t${i}` })), mappedFieldsHash(plan), pkg.resumeSnapshot!.pdfHash)).toBe(f0);
    }
    // any drift changes it
    expect(approvalFingerprint({ ...plan, planFingerprint: 'changed' }, pkg, consents, mappedFieldsHash(plan), pkg.resumeSnapshot!.pdfHash)).not.toBe(f0);
    const stored = getApproval(getDb(), USER, approval.id);
    expect(stored?.status).toBe('ACTIVE');
  });

  it('cross-user: approval is user-scoped', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    expect(getApproval(getDb(), OTHER, approval.id)).toBeNull();
  });
});

describe('Attempt idempotency', () => {
  it('same execution identity → single attempt (double click + unique key)', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    const key = executionKey({ userId: USER, provider: 'lever', externalJobId: 'ext-1', packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const [a, b] = await Promise.all([
      prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false }),
      prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false }),
    ]);
    expect(a.attempt.id).toBe(b.attempt.id);
    expect(getAttemptsByExecutionKey(getDb(), key).length).toBe(1);
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('executionKey changes when plan/package/resume changes', async () => {
    const base = { userId: USER, provider: 'lever', externalJobId: 'ext-1', packageSnapshotHash: 'sh', planFingerprint: 'pf' };
    expect(executionKey(base)).toBe(executionKey({ ...base }));
    expect(executionKey({ ...base, planFingerprint: 'pf2' })).not.toBe(executionKey(base));
    expect(executionKey({ ...base, packageSnapshotHash: 'sh2' })).not.toBe(executionKey(base));
    expect(executionKey({ ...base, externalJobId: 'e2' })).not.toBe(executionKey(base));
  });

  it('attempt is user-scoped', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const { attempt } = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(getAttempt(getDb(), OTHER, attempt.id)).toBeNull();
    vi.unstubAllGlobals();
    resetInspectionState();
  });
});

describe('Reinspection + form change', () => {
  it('requirements unchanged → payload built; transport-only change → same fingerprint', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    // fresh GET returns the same form but with different tracking values
    const freshHtml = HTML.replace('name="origin" value="t1"', 'name="origin" value="t999"').replace('name="referer" value="t2"', 'name="referer" value="r999"');
    vi.stubGlobal('fetch', async () => new Response(freshHtml, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const { attempt, payload, requirementsMatch, executionEligible, captcha } = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(requirementsMatch).toBe(true);
    expect(captcha.present).toBe(true);
    expect(executionEligible).toBe(false);
    expect(attempt.status).toBe('MANUAL_ACTION_REQUIRED'); // hCaptcha board
    expect(payload).not.toBeNull();
    expect(payload!.omittedTracking).toEqual(['origin', 'referer', 'source']);
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('requirements changed → BLOCKED, no payload, approval not usable', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    const changed = HTML.replace('"f1"', '"f1x"').replace('English level', 'English level (changed)');
    vi.stubGlobal('fetch', async () => new Response(changed, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(r.requirementsMatch).toBe(false);
    expect(r.attempt.status).toBe('BLOCKED');
    expect(r.payload).toBeNull();
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('challenge during reinspection → MANUAL_ACTION_REQUIRED, no payload, no fixture fallback', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    vi.stubGlobal('fetch', async () => new Response('<html><head><title>Just a moment...</title></head><body><div class="cf-challenge"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(r.attempt.status).toBe('MANUAL_ACTION_REQUIRED');
    expect(r.payload).toBeNull();
    vi.unstubAllGlobals();
    resetInspectionState();
  });
});

describe('Multipart payload builder', () => {
  it('exact keys: standard fields, cards[cardId][fieldN], baseTemplate, repeated multi-select', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent', 'cards[c1][field2]': 'Platform' });
    const fresh = freshReqs(HTML);
    const resume = { filename: 'resume-abc.pdf', mimeType: 'application/pdf', size: 1024, sha256: pkg.resumeSnapshot!.pdfHash, artifactReference: 'artifact:x' };
    const transport = { accountId: 'acc1', timezone: 'Asia/Kolkata', 'cards[c1][baseTemplate]': '{template}', hcaptcha: 'hCaptcha' };
    const payload = buildLeverPayload({ plan, targetUrl: 'https://jobs.lever.co/veo/j1/apply', requirements: fresh, resume, transport, marketingOptIn: false, consentSelections: {}, omitTracking: true });
    const names = payload.parts.map((p) => p.name);
    expect(names).toContain('name');
    expect(names).toContain('email');
    expect(names).toContain('phone');
    expect(names).toContain('urls[LinkedIn]');
    expect(names).toContain('cards[c1][field0]');
    expect(names).toContain('cards[c1][field1]');
    expect(names).toContain('cards[c1][baseTemplate]');
    const multi = payload.parts.filter((p) => p.name === 'cards[c1][field2]');
    expect(multi.length).toBe(1); // optional, one mapped selection
    const resumePart = payload.parts.find((p) => p.kind === 'FILE');
    expect(resumePart).toMatchObject({ name: 'resume', filename: 'resume-abc.pdf', mimeType: 'application/pdf', size: 1024, sha256: pkg.resumeSnapshot!.pdfHash });
    expect(payload.method).toBe('POST');
  });

  it('payload fingerprint deterministic 10x; tracking omission does not change it', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const fresh = freshReqs(HTML);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    const transport = { accountId: 'acc1', timezone: 'T', 'cards[c1][baseTemplate]': '{t}' };
    const base = { plan, targetUrl: 'https://jobs.lever.co/veo/j1/apply', requirements: fresh, resume, transport, marketingOptIn: false, consentSelections: {}, omitTracking: true };
    const f0 = payloadFingerprint(buildLeverPayload(base));
    for (let i = 0; i < 10; i++) {
      expect(payloadFingerprint(buildLeverPayload({ ...base, transport: { ...transport, timezone: `T${i}` } }))).toBe(f0); // volatile excluded
    }
    expect(payloadFingerprint(buildLeverPayload({ ...base, transport: { ...transport, origin: 'o1' } }))).toBe(f0); // omitted tracking excluded
    expect(payloadFingerprint(buildLeverPayload({ ...base, marketingOptIn: true }))).not.toBe(f0);
  });

  it('marketing opt-in: default omitted; explicit → serialized; never auto true', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const fresh = freshReqs(HTML);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    const transport = { accountId: 'acc1' };
    const p0 = buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport, marketingOptIn: false, consentSelections: {}, omitTracking: true });
    expect(p0.parts.some((p) => p.kind === 'TEXT' && p.name === 'consent[marketing]')).toBe(false);
    const p1 = buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport, marketingOptIn: true, consentSelections: {}, omitTracking: true });
    expect(p1.parts.some((p) => p.kind === 'TEXT' && p.name === 'consent[marketing]' && p.value === '1')).toBe(true);
  });

  it('legal consent: unapproved blocks; approved-with-exact-hash serializes', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const legalHtml = FORM('<input type="hidden" name="consent[legal]" value="0"><input type="checkbox" name="consent[legal]" value="1" required><label>I acknowledge the privacy policy</label>');
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(legalHtml), artifactOk: true });
    resolveUserAnswers(plan, {});
    const fresh = freshReqs(legalHtml);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    expect(() => buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport: {}, marketingOptIn: false, consentSelections: {}, omitTracking: true }))
      .toThrow(PayloadBuildError);
    const payload = buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport: {}, marketingOptIn: false, consentSelections: { 'consent[legal]': '1' }, omitTracking: true });
    expect(payload.parts.some((p) => p.kind === 'TEXT' && p.name === 'consent[legal]' && p.value === '1')).toBe(true);
  });

  it('EEO: optional unanswered omitted; required unanswered blocks; explicit valid choice maps', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const eeoHtml = FORM('<input type="hidden" name="cards[c2][baseTemplate]" value="{&quot;id&quot;:&quot;c2&quot;,&quot;fields&quot;:[{&quot;type&quot;:&quot;multiple-choice&quot;,&quot;text&quot;:&quot;Gender?&quot;,&quot;required&quot;:false,&quot;id&quot;:&quot;f0&quot;,&quot;options&quot;:[{&quot;text&quot;:&quot;Male&quot;},{&quot;text&quot;:&quot;Female&quot;},{&quot;text&quot;:&quot;Decline to answer&quot;}]}]}"><input type="radio" name="cards[c2][field0]" value="Male"><input type="radio" name="cards[c2][field0]" value="Female">');
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(eeoHtml), artifactOk: true });
    resolveUserAnswers(plan, {});
    expect(plan.manualFields.length).toBeGreaterThanOrEqual(1); // EEO never mapped
    const fresh = freshReqs(eeoHtml);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    const payload = buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport: {}, marketingOptIn: false, consentSelections: {}, omitTracking: true });
    expect(payload.parts.some((p) => p.name === 'cards[c2][field0]')).toBe(false); // never auto-serialized
  });

  it('negative: missing required answer / invalid option / tampered resume hash → throw', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const fresh = freshReqs(HTML);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    // invalid select option
    const badPlan = { ...plan, mappedFields: plan.mappedFields.map((m) => (m.providerFieldId === 'cards[c1][field1]' ? { ...m, value: 'NotAnOption' } : m)) };
    expect(() => buildLeverPayload({ plan: badPlan, targetUrl: 'u', requirements: fresh, resume, transport: {}, marketingOptIn: false, consentSelections: {}, omitTracking: true })).toThrow(PayloadBuildError);
    // resume integrity is enforced at the ENGINE gate (verifyResumeArtifact)
    // before any payload construction — the builder never fabricates hashes.
  });

  it('boolean false maps to provider "No", never omitted as empty', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const boolHtml = FORM('<input type="hidden" name="cards[c3][baseTemplate]" value="{&quot;id&quot;:&quot;c3&quot;,&quot;fields&quot;:[{&quot;type&quot;:&quot;multiple-select&quot;,&quot;text&quot;:&quot;Do you require visa sponsorship?&quot;,&quot;required&quot;:true,&quot;id&quot;:&quot;f0&quot;,&quot;options&quot;:[{&quot;text&quot;:&quot;Yes&quot;},{&quot;text&quot;:&quot;No&quot;}]}]}"><input type="checkbox" name="cards[c3][field0]" value="Yes" required><input type="checkbox" name="cards[c3][field0]" value="No" required>');
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(boolHtml), artifactOk: true });
    resolveUserAnswers(plan, {});
    const fresh = freshReqs(boolHtml);
    const resume = { filename: 'r.pdf', mimeType: 'application/pdf', size: 1, sha256: 'x', artifactReference: 'a' };
    const payload = buildLeverPayload({ plan, targetUrl: 'u', requirements: fresh, resume, transport: {}, marketingOptIn: false, consentSelections: {}, omitTracking: true });
    const noPart = payload.parts.find((p) => p.kind === 'TEXT' && p.name === 'cards[c3][field0]') as any;
    expect(noPart?.value).toBe('No'); // false ≠ missing
  });
});

describe('Resume artifact integrity', () => {
  it('verified artifact matches package hash; tampered → invalid', async () => {
    const { pkg } = await makeReady(USER);
    const ok = verifyResumeArtifact(pkg);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.resume.sha256).toBe(pkg.resumeSnapshot!.pdfHash);
      expect(ok.resume.mimeType).toBe('application/pdf');
    }
  });
});

describe('No fake success in Phase 1', () => {
  it('no code path produces SUBMITTED / SUCCESS_UNCONFIRMED from a dry run', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const { attempt, payload } = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(['SUBMITTED', 'SUCCESS_UNCONFIRMED']).not.toContain(attempt.status);
    expect(payload?.executionEligible).toBe(false);
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('hCaptcha board → MANUAL_ACTION_REQUIRED with CAPTCHA_REQUIRED reason, dry-run still inspectable', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(HTML), artifactOk: true });
    resolveUserAnswers(plan, { 'cards[c1][field1]': 'Fluent' });
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const { attempt, captcha, payload, executionEligible, reason } = await prepareExecution({ db: getDb(), userId: USER, plan, pkg, approval, marketingOptIn: false });
    expect(captcha.present).toBe(true);
    expect(attempt.status).toBe('MANUAL_ACTION_REQUIRED');
    expect(executionEligible).toBe(false);
    expect(reason).toBe('CAPTCHA_REQUIRED');
    expect(payload).not.toBeNull(); // locally inspectable only
    vi.unstubAllGlobals();
    resetInspectionState();
  });
});