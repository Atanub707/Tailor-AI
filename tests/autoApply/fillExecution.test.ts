// Auto Apply Phase 4F–4G — Lever Browser Companion FILL-ONLY execution and
// post-fill validation.
//
// Offline: no live Lever, no browser. The execution-engine seam is injected
// for the attempt/prepare step (existing engine suites cover the real one);
// companion sessions, approvals, plan freezing and validation are REAL code.
//
// Non-negotiable: filling is not submitting. Every path returns
// submissionPerformed:false and submissionTransportEnabled:false.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-exec-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.AUTO_APPLY_ENABLED = 'true';
process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';

const { getDb, runWithUser, saveMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
const { resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
const { upsertAnswer, listAnswers, deleteAnswer } = await import('../../server/autoApply/answerBank/answerBankStore.js');
const { runAutoApplyDryRun } = await import('../../server/autoApply/autoApplyService.js');
const {
  startFillExecution, freezeFillPlan, fillFeatureState, SUBMISSION_TRANSPORT_ENABLED,
} = await import('../../server/autoApply/fillExecution.js');
const {
  buildFillOutcome, normalizeForComparison, validateFieldOutcome,
} = await import('../../server/autoApply/fillValidation.js');
const { storeAttempt, getAttempt, getAttemptsByExecutionKey, executionKey } = await import('../../server/applicationEngine/executionStore.js');
const { transitionAttempt } = await import('../../server/applicationEngine/executionEngine.js');
import type { DryRunResult } from '../../server/applicationEngine/executionEngine.js';
const { requirementsFingerprint } = await import('../../server/applicationEngine/contract.js');
import type { ApplicationField, ApplicationTarget } from '../../server/applicationEngine/contract.js';
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'fill-user';

const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'Platform engineer with 5+ years of Kubernetes and AWS experience.',
  experiences: [{ id: '1', title: 'Senior Platform Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: '2021 – Present', responsibilities: ['Reduced deployment time by 70%'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  return p;
};

const job = (over: Partial<Job> = {}): Job => ({
  id: 'fill-j1', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes, AWS and Terraform. Must have 4+ years experience building platform infrastructure.',
  atsPlatform: 'lever', applyUrl: 'https://jobs.lever.co/veo/e1', url: 'https://jobs.lever.co/veo/e1',
  source: 'Lever', state: 'pending', ...over,
} as unknown as Job);

const seedJob = (j: Job) => {
  getDb().prepare('INSERT OR REPLACE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run(j.id, USER, JSON.stringify(j));
};

const fixtureOpts = (key = 'fixture-b-custom') => ({ mode: 'fixture' as const, adapter: new FixtureInspectionAdapter(key) });

/** Test double for the live-GET prepare step: creates the REAL attempt row
 *  (same execution key / store / transitions the engine uses), no network. */
const fakePrepare = (opts: { captcha?: boolean; requirementsMatch?: boolean } = {}) =>
  async ({ db, userId, plan, pkg, approval }: any): Promise<DryRunResult> => {
    const key = executionKey({ userId, provider: plan.provider, externalJobId: plan.target.externalJobId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
    const existing = getAttemptsByExecutionKey(db, key);
    if (existing.length) {
      return {
        attempt: existing[0], payload: null, payloadFingerprint: null,
        requirementsMatch: opts.requirementsMatch !== false,
        captcha: { present: opts.captcha === true, provider: opts.captcha ? 'hCaptcha' : undefined },
        dryRunAvailable: false, formAutomationEligible: !opts.captcha,
        submissionTransportEnabled: false, executionEligible: false,
      };
    }
    const now = new Date().toISOString();
    const attempt = {
      id: `attempt-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userId, planId: plan.id, packageId: pkg.id, provider: plan.provider, externalJobId: plan.target.externalJobId,
      executionKey: key, planFingerprint: plan.planFingerprint, packageSnapshotHash: pkg.snapshotHash,
      requirementsFingerprint: plan.requirementsFingerprint, approvalId: approval.id,
      status: 'PREPARING' as const, transportAttemptCount: 0, startedAt: now, createdAt: now, updatedAt: now,
    };
    storeAttempt(db, attempt);
    const finalStatus = opts.captcha ? 'MANUAL_ACTION_REQUIRED' : 'READY_FOR_DRY_RUN';
    transitionAttempt(db, userId, attempt.id, finalStatus as never);
    const stored = getAttempt(db, userId, attempt.id)!;
    return {
      attempt: stored, payload: null, payloadFingerprint: null,
      requirementsMatch: opts.requirementsMatch !== false,
      captcha: { present: opts.captcha === true, provider: opts.captcha ? 'hCaptcha' : undefined },
      dryRunAvailable: false, formAutomationEligible: !opts.captcha,
      submissionTransportEnabled: false, executionEligible: false,
    };
  };

const setFillMode = (enabled = true, mode = 'fill_only') => {
  process.env.AUTO_APPLY_BROWSER_FILL_ENABLED = enabled ? 'true' : 'false';
  process.env.AUTO_APPLY_EXECUTION_MODE = mode;
};

beforeAll(() => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  runWithUser(USER, () => {
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'FillUser', 'fill@test.local');
  });
  saveApplicantProfile(profile(), USER);
  saveMasterCv(cv, USER);
  resetInspectionState();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AUTO_APPLY_ENABLED = 'true';
  process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';
  resetInspectionState();
  setFillMode(true, 'fill_only');
  // Shared SQLite between tests → start each test with an empty Answer Bank.
  runWithUser(USER, () => {
    for (const a of listAnswers(USER)) deleteAnswer(USER, a.id);
  });
});

// ── Feature gating ───────────────────────────────────────────────────────

describe('Fill execution — feature gating', () => {
  it('browser fill disabled → no fill action, no session', async () => {
    setFillMode(false, 'fill_only');
    const j = job({ id: 'fill-off' });
    seedJob(j);
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FILL_DISABLED');
    expect(r.sessionId).toBeUndefined();
    expect(r.submissionPerformed).toBe(false);
  });

  it('execution mode dry_run → no fill action', async () => {
    setFillMode(true, 'dry_run');
    const j = job({ id: 'fill-dry' });
    seedJob(j);
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FILL_DISABLED');
  });

  it('fill_only + ready → attempt bound and companion session created (fill started)', async () => {
    const j = job({ id: 'fill-ready' });
    seedJob(j);
    // Resolve the required free-text question via the bank so readiness is READY.
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'Platform engineering is my craft.', source: 'USER_PROVIDED', reusable: true,
    }));
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FILL_STARTED');
    expect(r.attemptId).toBeTruthy();
    expect(r.sessionId).toBeTruthy();
    expect(r.expiresAt).toBeTruthy();
    expect(r.frozenFieldCount).toBeGreaterThanOrEqual(3);
    expect(r.submissionTransportEnabled).toBe(false);
    expect(r.submissionPerformed).toBe(false);
    // Job state untouched — filling is not applying.
    const stored = getDb().prepare('SELECT data FROM jobs WHERE id = ? AND user_id = ?').get(j.id, USER) as { data: string };
    expect(JSON.parse(stored.data).state).toBe('pending');
  });

  it('unsupported ATS → blocked', async () => {
    const j = job({ id: 'fill-gh', atsPlatform: 'workday', source: 'Workday', applyUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/9', url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/9' });
    seedJob(j);
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FILL_NOT_ELIGIBLE');
    expect(r.blockers.join(' ')).toMatch(/workday|unsupported/i);
  });

  it('unresolved required field → blocked before any session', async () => {
    const j = job({ id: 'fill-unresolved' });
    seedJob(j); // no bank answer for why_interested → NEEDS_USER_INPUT
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FILL_NOT_ELIGIBLE');
    expect(r.sessionId).toBeUndefined();
  });
});

// ── Plan freezing + field policy ─────────────────────────────────────────

describe('Fill plan freezing — field allowlist', () => {
  it('freezes deterministic + verified Answer Bank values; excludes drafts/consent/EEO', async () => {
    const j = job({ id: 'fill-freeze' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'Grounded bank answer.', source: 'USER_PROVIDED', reusable: true,
    }));
    // Unapproved generated draft exists in the dry-run preview but must NOT fill.
    const gen = {
      name: 'fake-gen',
      async generateAnswer() {
        return {
          value: 'Unapproved draft answer.', source: 'GENERATED_FROM_CANDIDATE_FACTS' as const,
          requiresUserReview: true as const, supportingFacts: [], warnings: [], questionCategory: 'why_role',
        };
      },
    };
    const dry = await runWithUser(USER, () => runAutoApplyDryRun(j.id, {
      ...fixtureOpts(),
      decisionEngine: { name: 'fake-laya', async classifyField() { return { category: 'CUSTOM', answerSource: 'GENERATIVE_REQUIRED', confidence: 0.97, mappingMethod: 'AI_SUGGESTED', requiresUser: true }; } },
      generativeEngine: gen,
    }));
    expect(dry.readiness?.status).toBe('READY');
    expect(dry.execution?.planId).toBeTruthy();

    const { getPackageById } = await import('../../server/applicationPackage/packageStore.js');
    const { getPlanById } = await import('../../server/applicationEngine/engine.js');
    const pkg = getPackageById(USER, dry.execution!.packageId)!;
    const plan = getPlanById(USER, dry.execution!.planId)!;
    const frozen = freezeFillPlan({ plan, pkg, bankMatched: dry.answerBank.matched.filter((m) => !m.requiresReview) });

    const byId = new Map(frozen.plan.mappedFields.map((m) => [m.providerFieldId, m]));
    expect(byId.get('name')?.value).toBe('Ravi Kumar'); // deterministic
    expect(byId.get('why_interested')?.value).toBe('Grounded bank answer.'); // verified bank
    expect(byId.get('why_interested')?.source).toBe('ANSWER_BANK');
    expect(byId.get('resume')?.canonicalKey).toBe('resume');
    expect(frozen.plan.status).toBe('READY_TO_SUBMIT');
    // Unapproved draft never enters the frozen plan.
    expect(JSON.stringify(frozen.plan.mappedFields)).not.toContain('Unapproved draft answer.');
    // No consent/EEO fields are ever fillable.
    expect(frozen.plan.mappedFields.some((m) => m.canonicalKey === 'gender')).toBe(false);
    expect(frozen.plan.consentFields.every((c) => c.status === 'REQUIRES_REVIEW')).toBe(true);
  });

  it('approved generated answer (GENERATED_APPROVED in bank) fills; stale bank does not', async () => {
    const j = job({ id: 'fill-approved' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'User-approved generated answer.', source: 'GENERATED_APPROVED', reusable: true,
    }));
    const dry = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    const { getPackageById } = await import('../../server/applicationPackage/packageStore.js');
    const { getPlanById } = await import('../../server/applicationEngine/engine.js');
    const pkg = getPackageById(USER, dry.execution!.packageId)!;
    const plan = getPlanById(USER, dry.execution!.planId)!;
    const frozen = freezeFillPlan({ plan, pkg, bankMatched: dry.answerBank.matched.filter((m) => !m.requiresReview) });
    const field = frozen.plan.mappedFields.find((m) => m.providerFieldId === 'why_interested');
    expect(field?.value).toBe('User-approved generated answer.');

    // Stale bank answers are review-required → never frozen as clean values.
    const stale = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Preferred location', questionCategory: 'location',
      answerType: 'TEXT', answerValue: 'Berlin', source: 'USER_PROVIDED', reusable: true,
    }));
    const { updateAnswer } = await import('../../server/autoApply/answerBank/answerBankStore.js');
    runWithUser(USER, () => updateAnswer(USER, stale.id, { verificationStatus: 'STALE' }));
    const dry2 = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(dry2.answerBank.matched.find((m) => m.providerFieldId === 'location_pref')?.requiresReview).toBe(true);
    const pkg2 = getPackageById(USER, dry2.execution!.packageId)!;
    const plan2 = getPlanById(USER, dry2.execution!.planId)!;
    const frozen2 = freezeFillPlan({ plan: plan2, pkg: pkg2, bankMatched: dry2.answerBank.matched.filter((m) => !m.requiresReview) });
    expect(frozen2.plan.mappedFields.find((m) => m.providerFieldId === 'location_pref')).toBeUndefined();
  });

  it('Laya-only classification (no verified value) never fills', async () => {
    const j = job({ id: 'fill-laya-only' });
    seedJob(j);
    const dry = await runWithUser(USER, () => runAutoApplyDryRun(j.id, {
      ...fixtureOpts(),
      decisionEngine: { name: 'fake-laya', async classifyField() { return { canonicalKey: 'portfolioUrl', category: 'CONTACT', answerSource: 'PROFILE', confidence: 0.99, mappingMethod: 'AI_SUGGESTED', requiresUser: true }; } },
    }));
    // No portfolio answer exists anywhere → nothing to freeze from a classification.
    const { getPackageById } = await import('../../server/applicationPackage/packageStore.js');
    const { getPlanById } = await import('../../server/applicationEngine/engine.js');
    const pkg = getPackageById(USER, dry.execution!.packageId)!;
    const plan = getPlanById(USER, dry.execution!.planId)!;
    const frozen = freezeFillPlan({ plan, pkg, bankMatched: [] });
    expect(frozen.plan.mappedFields.some((m) => m.canonicalKey === 'portfolioUrl')).toBe(false);
  });

  it('EEO/consent fixtures are never fillable and block readiness', async () => {
    const j = job({ id: 'fill-eeo' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'x', source: 'USER_PROVIDED', reusable: true,
    }));
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts('fixture-c-complex') }));
    expect(r.status).toBe('FILL_NOT_ELIGIBLE');
    // fixture-c also has unresolved required custom questions, so either
    // state is correct — what matters: never READY, never a session.
    expect(['NEEDS_USER_INPUT', 'NEEDS_REVIEW']).toContain(r.readiness?.status);
    expect(r.sessionId).toBeUndefined();
    expect(r.submissionPerformed).toBe(false);
  });
});

// ── CAPTCHA / fingerprint / resume gates ─────────────────────────────────

describe('Fill execution — blockers', () => {
  it('CAPTCHA at prepare time → USER_ACTION_REQUIRED WITH a companion session (designed handoff), never a submission', async () => {
    const j = job({ id: 'fill-captcha' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'x', source: 'USER_PROVIDED', reusable: true,
    }));
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare({ captcha: true }) as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('USER_ACTION_REQUIRED');
    expect(r.blockers).toEqual(['CAPTCHA_REQUIRED']);
    // The session exists so the extension can fill safe fields + resume, then
    // pause for the human checkpoint and continue after it clears.
    expect(r.sessionId).toBeTruthy();
    expect(r.attemptId).toBeTruthy();
    expect(r.submissionPerformed).toBe(false);
    expect(r.submissionTransportEnabled).toBe(false);
  });

  it('requirements fingerprint mismatch → FORM_CHANGED, no session', async () => {
    const j = job({ id: 'fill-changed' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'x', source: 'USER_PROVIDED', reusable: true,
    }));
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare({ requirementsMatch: false }) as never, dryRunOptions: fixtureOpts() }));
    expect(r.status).toBe('FORM_CHANGED');
    expect(r.sessionId).toBeUndefined();
  });

  it('retry is idempotent: same attempt reused, submission never performed', async () => {
    const j = job({ id: 'fill-retry' });
    seedJob(j);
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?', questionCategory: 'motivation',
      answerType: 'TEXTAREA', answerValue: 'x', source: 'USER_PROVIDED', reusable: true,
    }));
    const first = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    const second = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: fixtureOpts() }));
    expect(second.status).toBe('FILL_STARTED');
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.submissionPerformed).toBe(false);
    expect(second.submissionTransportEnabled).toBe(false);
  });

  it('submission transport is a frozen constant; mode auto_submit is NOT activated by this increment', () => {
    expect(SUBMISSION_TRANSPORT_ENABLED).toBe(false);
    setFillMode(true, 'auto_submit');
    expect(fillFeatureState().mode).toBe('auto_submit');
    expect(fillFeatureState().fillOnlyActive).toBe(false); // fill only runs in fill_only mode
  });
});

// ── Post-fill validation (4G) ────────────────────────────────────────────

describe('Post-fill validation', () => {
  it('normalizes equivalent values without false mismatches', () => {
    expect(normalizeForComparison('  Ravi   Kumar ', 'TEXT')).toBe('ravi kumar');
    expect(normalizeForComparison('+91 90000-00000', 'PHONE')).toBe('919000000000');
    expect(normalizeForComparison('yes', 'BOOLEAN')).toBe('yes');
    expect(normalizeForComparison('Yes', 'SINGLE_SELECT')).toBe('yes');
    expect(validateFieldOutcome('Ravi Kumar', ' ravi  kumar ', 'TEXT')).toBe('VERIFIED');
    expect(validateFieldOutcome('+91 90000 00000', '+919000000000', 'PHONE')).toBe('VERIFIED');
  });

  it('classifies VERIFIED / ALREADY_CORRECT / MISMATCH / NOT_FOUND', () => {
    expect(validateFieldOutcome('Ravi', 'Ravi', 'TEXT')).toBe('VERIFIED');
    expect(validateFieldOutcome('Ravi', 'Ravi', 'TEXT', true)).toBe('ALREADY_CORRECT');
    expect(validateFieldOutcome('Ravi', 'Someone Else', 'TEXT')).toBe('MISMATCH');
    expect(validateFieldOutcome('Ravi', undefined, 'TEXT')).toBe('NOT_FOUND');
  });

  it('builds the Section-22 outcome; readyForUserSubmission only when everything verifies', () => {
    const outcome = buildFillOutcome({
      attemptId: 'a1', provider: 'lever',
      attempted: [
        { providerFieldId: 'name', canonicalKey: 'fullName', source: 'MASTER_CV', expected: 'Ravi Kumar', observed: 'Ravi Kumar', fieldType: 'TEXT' },
        { providerFieldId: 'why_interested', canonicalKey: undefined, source: 'ANSWER_BANK', expected: 'x', observed: 'x', fieldType: 'TEXTAREA' },
      ],
      skipped: [{ providerFieldId: 'gender', reason: 'EEO — manual only' }],
      requiredFieldIds: ['name', 'why_interested'],
      resume: { expectedHash: 'abc', uploaded: true, verified: true },
      blockers: [],
    });
    expect(outcome.filled.every((f) => f.status === 'VERIFIED')).toBe(true);
    expect(outcome.mismatches).toEqual([]);
    expect(outcome.readyForUserSubmission).toBe(true);
    expect(outcome.submissionPerformed).toBe(false);
  });

  it('mismatch / missing required / newly appeared required / resume failure → not ready', () => {
    const base = {
      attemptId: 'a1', provider: 'lever',
      attempted: [{ providerFieldId: 'name', canonicalKey: 'fullName', source: 'MASTER_CV', expected: 'Ravi', observed: 'Ravi', fieldType: 'TEXT' }],
      skipped: [], requiredFieldIds: ['name'],
      resume: { expectedHash: 'abc', uploaded: true, verified: true }, blockers: [],
    };
    expect(buildFillOutcome(base).readyForUserSubmission).toBe(true);
    expect(buildFillOutcome({ ...base, attempted: [{ ...base.attempted[0], observed: 'Wrong' }] }).readyForUserSubmission).toBe(false);
    expect(buildFillOutcome({ ...base, attempted: [{ ...base.attempted[0], observed: undefined }] }).readyForUserSubmission).toBe(false);
    expect(buildFillOutcome({ ...base, requiredFieldIds: ['name', 'new_required'] }).readyForUserSubmission).toBe(false);
    expect(buildFillOutcome({ ...base, resume: { expectedHash: 'abc', uploaded: true, verified: false } }).readyForUserSubmission).toBe(false);
    expect(buildFillOutcome({ ...base, blockers: ['CAPTCHA_REQUIRED'] }).readyForUserSubmission).toBe(false);
  });

  it('never claims submission', () => {
    const outcome = buildFillOutcome({
      attemptId: 'a1', provider: 'lever', attempted: [], skipped: [], requiredFieldIds: [],
      resume: { expectedHash: 'abc', uploaded: true, verified: true }, blockers: [],
    });
    expect(outcome.submissionPerformed).toBe(false);
    expect(outcome.readyForUserSubmission).toBe(true); // ready for the USER to submit
  });
});

// ── Optional vs required consent (Section 7 / 21) ────────────────────────

const consentAdapter = (fields: ApplicationField[]) => ({
  provider: 'lever' as const,
  detect: () => ({ provider: 'lever' as const, confidence: 'high' as const, reason: 'test adapter' }),
  inspect: async (target: ApplicationTarget) => ({
    provider: 'lever' as const,
    target,
    fields,
    discoveredAt: new Date().toISOString(),
    fingerprint: requirementsFingerprint('lever', 'jobs.lever.co', fields),
    providerMetadata: {},
  }),
});

const baseFields = (): ApplicationField[] => [
  { providerFieldId: 'name', normalizedKey: 'fullName', label: 'Name', type: 'TEXT', required: true, category: 'IDENTITY' },
  { providerFieldId: 'email', normalizedKey: 'email', label: 'Email', type: 'EMAIL', required: true, category: 'CONTACT' },
  { providerFieldId: 'resume', normalizedKey: 'resume', label: 'Resume', type: 'FILE', required: true, category: 'RESUME' },
];

describe('Optional consent policy (fill-only)', () => {
  it('optional marketing consent never blocks filling and stays untouched', async () => {
    const fields: ApplicationField[] = [
      ...baseFields(),
      { providerFieldId: 'consent[marketing]', label: 'Yes, Veo can contact me about future job opportunities for up to 2 years', type: 'CONSENT', required: false, category: 'CONSENT' },
    ];
    const j = job({ id: 'fill-consent-opt' });
    seedJob(j);
    const opts = { mode: 'fixture' as const, adapter: consentAdapter(fields) as never };

    const dry = await runWithUser(USER, () => runAutoApplyDryRun(j.id, opts));
    expect(dry.status).toBe('DRY_RUN_READY');
    expect(dry.readiness?.status).toBe('READY'); // optional consent does NOT block
    const consent = dry.consentFields.find((c) => c.providerFieldId === 'consent[marketing]');
    expect(consent?.classification).toBe('OPTIONAL_MARKETING');
    expect(consent?.status).toBe('REQUIRES_REVIEW'); // never auto-accepted
    expect(dry.warnings.some((w) => /optional consent/i.test(w))).toBe(true);

    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: opts }));
    expect(r.status).toBe('FILL_STARTED'); // ordinary approved fields still fill
    expect(r.submissionPerformed).toBe(false);
    const { getPackageById } = await import('../../server/applicationPackage/packageStore.js');
    const { getPlanById } = await import('../../server/applicationEngine/engine.js');
    const plan = getPlanById(USER, r.planId!)!;
    // Ordinary fields present; the optional consent is never in the fill plan.
    expect(plan.mappedFields.find((m) => m.providerFieldId === 'name')?.value).toBe('Ravi Kumar');
    expect(plan.mappedFields.some((m) => m.providerFieldId === 'consent[marketing]')).toBe(false);
    void getPackageById;
  });

  it('required legal consent still blocks — protection preserved', async () => {
    const fields: ApplicationField[] = [
      ...baseFields(),
      { providerFieldId: 'consent[legal]', label: 'I agree to the privacy policy and terms of use', type: 'CONSENT', required: true, category: 'CONSENT' },
    ];
    const j = job({ id: 'fill-consent-leg' });
    seedJob(j);
    const opts = { mode: 'fixture' as const, adapter: consentAdapter(fields) as never };
    const dry = await runWithUser(USER, () => runAutoApplyDryRun(j.id, opts));
    expect(dry.readiness?.status).toBe('NEEDS_REVIEW');
    const r = await runWithUser(USER, () => startFillExecution(j.id, { prepareExecutionFn: fakePrepare() as never, dryRunOptions: opts }));
    expect(r.status).toBe('FILL_NOT_ELIGIBLE');
    expect(r.sessionId).toBeUndefined();
    expect(r.submissionPerformed).toBe(false);
  });
});
