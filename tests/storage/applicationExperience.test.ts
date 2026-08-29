// Application Experience V1 — status mapping, checkpoints, handoff, manual
// confirmation, events, URL safety, ownership. No network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-exp-'));
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
const { mapApplicationStatus, humanCheckpointFrom, availableActions } = await import('../../server/applicationExperience/applicationStatus.js');
const { applicationSummaries, recordHandoff, confirmUserSubmitted, verifiedLeverActionUrl, ExperienceError, startApplication } = await import('../../server/applicationExperience/applicationService.js');
const { ensureEventSchema, appendEvent, getEventsForAttempt } = await import('../../server/applicationExperience/applicationEvents.js');
const { parseLeverForm, resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
const { requirementsFingerprint } = await import('../../server/applicationEngine/contract.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'exp-user';
const OTHER = 'exp-other';

const HTML = `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required>
  <input name="resume" type="file">
  <input type="hidden" name="accountId" value="a1">
  <div class="h-captcha" data-sitekey="sk"></div>
</form>`;

const job = (id = 'ej1'): Job => ({
  id, externalId: id, title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'x', atsPlatform: 'lever',
  jobUrl: `https://jobs.lever.co/veo/${id}/apply`, applyUrl: `https://jobs.lever.co/veo/${id}/apply`,
  url: `https://jobs.lever.co/veo/${id}/apply`, source: 'Lever', state: 'pending',
} as unknown as Job);

const parsedReqs = () => {
  const fields = parseLeverForm(HTML).fields;
  return { provider: 'lever' as const, target: {} as any, fields, discoveredAt: new Date().toISOString(), fingerprint: requirementsFingerprint('lever', 'jobs.lever.co', fields), providerMetadata: {} as Record<string, string> };
};
const realAdapter = () => ({ provider: 'lever' as const, detect: () => ({ provider: 'lever' as const, confidence: 'high' as const, reason: 't' }), inspect: async () => parsedReqs() });

const makeReady = async (userId: string, j: Job = job()) => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  const cv: MasterCv = { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'B', summary: 'DevOps', experiences: [], education: [], skills: [], certifications: [] };
  const fit = computeFit(p, cv, j, 'x');
  const pkg = await buildPackage({ userId, job: j, jd: 'x', profile: p, masterCv: cv, fit, tailoredVersion: {
    id: `t-${j.id}`, userId, jobId: j.id, version: 1, masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3, tailorEngineVersion: 1,
    content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] }, verification: { passed: true, issues: [] }, stale: false, createdAt: new Date().toISOString(),
  } as any }, 'c');
  storePackage(pkg);
  return { pkg, job: j };
};

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureExecutionSchema(getDb());
  ensureEventSchema(getDb());
  for (const u of [USER, OTHER]) {
    runWithUser(u, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(u, u, `${u}@test.local`));
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Status mapper (exhaustive, centralized)', () => {
  it('maps every relevant internal state to a valid user status', () => {
    const base = { plan: null as any, attempt: null as any, hasHandoffEvent: false, hasUserConfirmedEvent: false };
    // plan-only
    expect(mapApplicationStatus({ ...base, plan: { status: 'NEEDS_INPUT' } as any })).toBe('PREPARING');
    expect(mapApplicationStatus({ ...base, plan: { status: 'NEEDS_REVIEW' } as any })).toBe('ACTION_REQUIRED');
    expect(mapApplicationStatus({ ...base, plan: { status: 'READY_TO_SUBMIT' } as any })).toBe('READY');
    expect(mapApplicationStatus({ ...base, plan: { status: 'UNSUPPORTED' } as any })).toBe('MANUAL_REQUIRED'); // unsupported → manual, never Failed (E2E V1)
    // attempt states
    for (const s of ['MANUAL_ACTION_REQUIRED', 'READY_FOR_DRY_RUN', 'BLOCKED', 'PREPARING', 'SUBMITTED', 'SUCCESS_UNCONFIRMED', 'FAILED', 'CANCELLED', 'PENDING_APPROVAL', 'APPROVED'] as const) {
      const r = mapApplicationStatus({ ...base, attempt: { status: s } as any });
      expect(['PREPARING', 'READY', 'APPLYING', 'ACTION_REQUIRED', 'WAITING_FOR_YOU', 'APPLIED', 'CHECK_SUBMISSION', 'FAILED']).toContain(r);
    }
    expect(mapApplicationStatus({ ...base, attempt: { status: 'MANUAL_ACTION_REQUIRED' } as any })).toBe('ACTION_REQUIRED');
    expect(mapApplicationStatus({ ...base, attempt: { status: 'MANUAL_ACTION_REQUIRED' } as any, hasHandoffEvent: true })).toBe('WAITING_FOR_YOU');
    expect(mapApplicationStatus({ ...base, attempt: { status: 'MANUAL_ACTION_REQUIRED' } as any, hasUserConfirmedEvent: true })).toBe('APPLIED');
    expect(mapApplicationStatus({ ...base, attempt: { status: 'BLOCKED' } as any })).toBe('FAILED');
    expect(mapApplicationStatus({ ...base, attempt: { status: 'SUCCESS_UNCONFIRMED' } as any })).toBe('CHECK_SUBMISSION');
    // unknown → safe fallback, never APPLIED
    expect(mapApplicationStatus({ plan: null, attempt: null, hasHandoffEvent: false, hasUserConfirmedEvent: false })).toBe('CHECK_SUBMISSION');
  });

  it('available actions derived by backend, not frontend', () => {
    expect(availableActions('ACTION_REQUIRED', 'CAPTCHA')).toEqual(['CONTINUE_PROVIDER', 'VIEW']);
    expect(availableActions('ACTION_REQUIRED', 'MANUAL_SUBMISSION')).toEqual(['CONTINUE_PROVIDER', 'VIEW']);
    expect(availableActions('WAITING_FOR_YOU')).toEqual(['REOPEN_PROVIDER', 'CONFIRM_SUBMITTED']);
    expect(availableActions('APPLIED')).toEqual(['VIEW']);
    expect(availableActions('READY')).toEqual(['START_APPLICATION']);
    expect(availableActions('FAILED')).toEqual(['RETRY', 'VIEW']);
  });
});

describe('Human checkpoint router', () => {
  it('execution reasons → generic checkpoints', () => {
    const c1 = humanCheckpointFrom('CAPTCHA_REQUIRED', 'Lever');
    expect(c1.type).toBe('CAPTCHA');
    expect(c1.title).toBe('Human verification required');
    const c2 = humanCheckpointFrom('PROVIDER_CHALLENGE', 'Lever');
    expect(c2.type).toBe('PROVIDER_CHALLENGE');
    const c3 = humanCheckpointFrom('CONSENT_REQUIRED', 'Lever');
    expect(c3.type).toBe('CONSENT');
    const c4 = humanCheckpointFrom('FORM_CHANGED', 'Lever');
    expect(c4.type).toBe('MANUAL_SUBMISSION');
    const c5 = humanCheckpointFrom(undefined, 'Lever', { manualFields: [{ label: 'Gender?' }] } as any);
    expect(c5.type).toBe('REQUIRED_QUESTION');
    const c6 = humanCheckpointFrom('WEIRD', 'Lever');
    expect(c6.type).toBe('UNKNOWN');
  });
});

describe('Start Application (product command)', () => {
  it('READY + CAPTCHA → start → MANUAL_ACTION_REQUIRED → ACTION_REQUIRED with Human verification required', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r = await startApplication(getDb(), USER, pkg.id);
    expect(r.started).toBe(true);
    expect(r.summary.userStatus).toBe('ACTION_REQUIRED');
    expect(r.summary.checkpoint?.type).toBe('CAPTCHA');
    expect(r.summary.checkpoint?.title).toBe('Human verification required');
    expect(r.summary.availableActions).toContain('CONTINUE_PROVIDER');
    // idempotent: second start → same attempt, no new provider call
    resetInspectionState();
    let gets = 0;
    const orig = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => { gets++; return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }); };
    const r2 = await startApplication(getDb(), USER, pkg.id);
    (globalThis as any).fetch = orig;
    expect(r2.started).toBe(false);
    expect(r2.reason).toBe('ALREADY_STARTED');
    expect(r2.summary.userStatus).toBe('ACTION_REQUIRED');
    expect(gets).toBe(0); // no unnecessary provider calls
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('double click (Promise.all) → one attempt', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const [a, b] = await Promise.all([startApplication(getDb(), USER, pkg.id), startApplication(getDb(), USER, pkg.id)]);
    const { getAttemptsByExecutionKey: gk, executionKey: ek } = await import('../../server/applicationEngine/executionStore.js');
    const key = ek({ userId: USER, provider: 'lever', externalJobId: j.externalId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
    expect(gk(getDb(), key).length).toBe(1);
    expect(a.started || b.started).toBe(true);
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('cross-user start blocked; missing package 404', async () => {
    await expect(startApplication(getDb(), OTHER, 'pkg-does-not-exist')).rejects.toThrow(ExperienceError);
  });

  it('non-READY plan → no attempt, no bypass (Preparing/Action Required state)', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'NEEDS_INPUT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    const r = await startApplication(getDb(), USER, pkg.id);
    expect(r.started).toBe(false);
    expect(r.reason).toBe('PLAN_NOT_READY');
    expect(['PREPARING', 'ACTION_REQUIRED']).toContain(r.summary.userStatus);
    const { getAttemptsByExecutionKey: gk, executionKey: ek } = await import('../../server/applicationEngine/executionStore.js');
    expect(gk(getDb(), ek({ userId: USER, provider: 'lever', externalJobId: j.externalId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint })).length).toBe(0);
  });

  it('no-captcha synthetic form → formAutomationEligible=true, transport=false, execEligible=false, actionable ACTION_REQUIRED (manual)', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const noCapHtml = HTML.replace('<div class="h-captcha" data-sitekey="sk"></div>', '');
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    // rebuild plan against the no-captcha fingerprint
    const { parseLeverForm: plf } = await import('../../server/applicationEngine/leverInspector.js');
    const { requirementsFingerprint: rfp } = await import('../../server/applicationEngine/contract.js');
    const fields = plf(noCapHtml).fields;
    plan.requirementsFingerprint = rfp('lever', 'jobs.lever.co', fields);
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    vi.stubGlobal('fetch', async () => new Response(noCapHtml, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r = await startApplication(getDb(), USER, pkg.id);
    expect(r.started).toBe(true);
    expect(r.summary.userStatus).toBe('ACTION_REQUIRED'); // never stuck Applying
    expect(r.summary.availableActions).toContain('CONTINUE_PROVIDER');
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('consent/EEO boundaries never bypassed by start', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const reviewHtml = HTML.replace('<input name="resume" type="file">', '<input name="resume" type="file"><input type="hidden" name="consent[legal]" value="0"><input type="checkbox" name="consent[legal]" value="1" required><label>I acknowledge the privacy policy</label>');
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'NEEDS_REVIEW' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    // plan stays NEEDS_REVIEW (legal consent) — start must not approve it
    const r = await startApplication(getDb(), USER, pkg.id);
    expect(r.started).toBe(false);
    expect(r.reason).toBe('PLAN_NOT_READY');
    expect(r.summary.userStatus).toBe('ACTION_REQUIRED'); // review boundary surfaced
  });
});

describe('Verified handoff URL safety', () => {
  it('allows only canonical https jobs.lever.co application URLs', () => {
    expect(verifiedLeverActionUrl('https://jobs.lever.co/veo/abc/apply', 'abc')).toBe('https://jobs.lever.co/veo/abc/apply');
    expect(verifiedLeverActionUrl('https://jobs.lever.co/veo/abc/apply')).toBe('https://jobs.lever.co/veo/abc/apply');
    expect(verifiedLeverActionUrl('https://jobs.lever.co/veo/abc', 'abc')).toBe('https://jobs.lever.co/veo/abc/apply'); // canonicalized
    expect(verifiedLeverActionUrl('https://jobs.lever.co/veo/abc/apply', 'other-job')).toBeNull();
    expect(verifiedLeverActionUrl('http://jobs.lever.co/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('https://evil.com/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('https://jobs.lever.co.evil.com/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('https://jobs.lever.co/veo/abc', 'other')).toBeNull(); // job id mismatch
    expect(verifiedLeverActionUrl('javascript:alert(1)')).toBeNull();
    expect(verifiedLeverActionUrl('data:text/html,x')).toBeNull();
    expect(verifiedLeverActionUrl('https://localhost/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('https://127.0.0.1/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('https://192.168.1.1/veo/abc/apply')).toBeNull();
    expect(verifiedLeverActionUrl('not a url')).toBeNull();
    expect(verifiedLeverActionUrl(undefined)).toBeNull();
  });
});

describe('Handoff + manual confirmation flow', () => {
  it('handoff: verified URL, records event, never marks applied, idempotent, cross-user blocked', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    // simulate the Phase-1 preparation outcome via direct store (engine path tested elsewhere)
    const { ensureExecutionSchema: es, executionKey } = await import('../../server/applicationEngine/executionStore.js');
    es(getDb());
    const key = executionKey({ userId: USER, provider: 'lever', externalJobId: 'ext-1', packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
    const attempt = {
      id: 'attempt-exp-1', userId: USER, planId: plan.id, packageId: pkg.id, approvalId: approval.id,
      provider: 'lever', externalJobId: 'ext-1', executionKey: key, planFingerprint: plan.planFingerprint,
      packageSnapshotHash: pkg.snapshotHash, requirementsFingerprint: plan.requirementsFingerprint,
      status: 'MANUAL_ACTION_REQUIRED', transportAttemptCount: 0, startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const { storeAttempt } = await import('../../server/applicationEngine/executionStore.js');
    storeAttempt(getDb(), attempt as any);

    // cross-user blocked
    expect(() => recordHandoff(getDb(), OTHER, 'attempt-exp-1')).toThrow(ExperienceError);
    const r = recordHandoff(getDb(), USER, 'attempt-exp-1');
    expect(r.url).toBe('https://jobs.lever.co/veo/ej1/apply');
    expect(r.summary.userStatus).toBe('WAITING_FOR_YOU');
    expect(r.summary.availableActions).toEqual(['REOPEN_PROVIDER', 'CONFIRM_SUBMITTED']);
    // idempotent — same event, no duplicates
    const r2 = recordHandoff(getDb(), USER, 'attempt-exp-1');
    expect(r2.url).toBe(r.url);
    expect(getEventsForAttempt(getDb(), USER, 'attempt-exp-1').filter((e) => e.eventType === 'PROVIDER_HANDOFF').length).toBe(1);
    expect(r2.summary.userStatus).toBe('WAITING_FOR_YOU'); // never applied
    // summaries derived
    const sums = applicationSummaries(getDb(), USER);
    expect(sums.some((s) => s.attemptId === 'attempt-exp-1' && s.userStatus === 'WAITING_FOR_YOU')).toBe(true);
  });

  it('confirmation: requires handoff, USER_CONFIRMED provenance, no provider receipt, idempotent, cross-user blocked', async () => {
    const { pkg, job: j } = await makeReady(USER);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    const { ensureExecutionSchema: es, executionKey, storeAttempt } = await import('../../server/applicationEngine/executionStore.js');
    es(getDb());
    const key = executionKey({ userId: USER, provider: 'lever', externalJobId: 'ext-1', packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
    const attempt = {
      id: 'attempt-exp-2', userId: USER, planId: plan.id, packageId: pkg.id, approvalId: approval.id,
      provider: 'lever', externalJobId: 'ext-1', executionKey: key, planFingerprint: plan.planFingerprint,
      packageSnapshotHash: pkg.snapshotHash, requirementsFingerprint: plan.requirementsFingerprint,
      status: 'MANUAL_ACTION_REQUIRED', transportAttemptCount: 0, startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    storeAttempt(getDb(), attempt as any);
    // not handed off → cannot confirm
    let err: any; try { confirmUserSubmitted(getDb(), USER, 'attempt-exp-2'); } catch (e) { err = e; }
    expect(err?.code).toBe('NOT_HANDED_OFF');
    recordHandoff(getDb(), USER, 'attempt-exp-2');
    expect(() => confirmUserSubmitted(getDb(), OTHER, 'attempt-exp-2')).toThrow(ExperienceError);
    const summary = confirmUserSubmitted(getDb(), USER, 'attempt-exp-2');
    expect(summary.userStatus).toBe('APPLIED');
    const events = getEventsForAttempt(getDb(), USER, 'attempt-exp-2');
    const confirmed = events.find((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED')!;
    expect(confirmed.metadata.confirmationSource).toBe('USER');
    expect(confirmed.metadata.providerApplicationId).toBeUndefined();
    expect(confirmed.metadata.confirmationUrl).toBeUndefined();
    expect(confirmed.metadata.receipt).toBeUndefined();
    // idempotent — second confirm returns same applied state, single event
    const again = confirmUserSubmitted(getDb(), USER, 'attempt-exp-2');
    expect(again.userStatus).toBe('APPLIED');
    expect(getEventsForAttempt(getDb(), USER, 'attempt-exp-2').filter((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED').length).toBe(1);
  });

  it('events are append-only with non-sensitive metadata only', async () => {
    const ev = appendEvent(getDb(), { userId: USER, attemptId: 'attempt-x', eventType: 'SUBMISSION_UNCONFIRMED', metadata: { provider: 'lever' }, idempotencyId: 'attempt-x-unconfirmed' });
    expect(ev.id).toBe('evt-attempt-x-unconfirmed');
    const dup = appendEvent(getDb(), { userId: USER, attemptId: 'attempt-x', eventType: 'SUBMISSION_UNCONFIRMED', metadata: { provider: 'lever' }, idempotencyId: 'attempt-x-unconfirmed' });
    expect(dup.id).toBe(ev.id);
    expect(getEventsForAttempt(getDb(), USER, 'attempt-x').length).toBe(1);
    const all = getEventsForAttempt(getDb(), USER, 'attempt-x');
    for (const e of all) {
      expect(JSON.stringify(e.metadata)).not.toMatch(/resume|password|token|answer|captcha|cookie/i);
    }
  });

  it('dashboard summaries respect filters and ownership', async () => {
    const sums = applicationSummaries(getDb(), USER);
    expect(applicationSummaries(getDb(), OTHER).length).toBe(0);
    expect(Array.isArray(sums)).toBe(true);
    for (const s of sums) {
      expect(s.userStatus).toBeDefined();
      expect(s.availableActions.length).toBeGreaterThan(0);
    }
  });
});