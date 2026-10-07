// Auto Apply Phase 4A–4E — Candidate Answer Bank, question learning,
// matching policy, and the Submission Readiness Engine.
//
// No browser, no LLM, no network. Pins:
//   * user isolation + CRUD
//   * canonicalization + match statuses (EXACT/CANONICAL/SEMANTIC/NONE)
//   * stale / non-reusable / sensitive policy
//   * readiness gates are SEPARATE from field completion
//   * dry-run resolution order: deterministic → ANSWER BANK → Laya
//   * learned answers are reused on a future equivalent question
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-bank-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.AUTO_APPLY_ENABLED = 'false';
process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';

const { getDb, runWithUser, saveMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
const { resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
const {
  ensureAnswerBankSchema, listAnswers, getAnswerById, upsertAnswer, updateAnswer,
  deleteAnswer, recordUsage, answerBankConfigFromEnv, listRunAnswers,
} = await import('../../server/autoApply/answerBank/answerBankStore.js');
const { normalizeQuestion, canonicalKeyForQuestion } = await import('../../server/autoApply/answerBank/answerCanonicalizer.js');
const { AnswerBankMatcher } = await import('../../server/autoApply/answerBank/answerMatcher.js');
const { answerQuestionForJob, resolveQuestionsFromBank } = await import('../../server/autoApply/answerBank/answerBankService.js');
const { resolveAgentValues } = await import('../../server/autoApply/agentDecision.js');
const { evaluateSubmissionReadiness } = await import('../../server/autoApply/submissionReadiness.js');
const { autoApplyEnabled, runAutoApplyDryRun } = await import('../../server/autoApply/autoApplyService.js');
import type { DecisionEngine, FieldClassificationInput, FieldClassificationResult } from '../../server/autoApply/decisionEngine.js';
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'ab-user';
const OTHER = 'ab-other';

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
  id: 'ab-j1', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes, AWS and Terraform. Must have 4+ years experience building platform infrastructure.',
  atsPlatform: 'lever', applyUrl: 'https://jobs.lever.co/veo/e1', url: 'https://jobs.lever.co/veo/e1',
  source: 'Lever', state: 'pending', ...over,
} as unknown as Job);

const seedJob = (j: Job, userId = USER) => {
  getDb().prepare('INSERT OR REPLACE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run(j.id, userId, JSON.stringify(j));
};

const fixtureOpts = (key = 'fixture-b-custom') => ({ mode: 'fixture' as const, adapter: new FixtureInspectionAdapter(key) });

beforeAll(() => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureAnswerBankSchema();
  runWithUser(USER, () => {
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'ABUser', 'ab@test.local');
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(OTHER, 'Other', 'ab-other@test.local');
  });
  saveApplicantProfile(profile(), USER);
  saveMasterCv(cv, USER);
  saveApplicantProfile(defaultApplicantProfile(), OTHER);
  saveMasterCv({ ...cv, email: 'other@example.com' }, OTHER);
  resetInspectionState();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AUTO_APPLY_ENABLED = 'true';
  process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';
  resetInspectionState();
});

// ── 4A. Store + isolation + CRUD ─────────────────────────────────────────

describe('Answer Bank store', () => {
  it('config defaults: enabled only when the flag is true; conservative thresholds', () => {
    delete process.env.AUTO_APPLY_ANSWER_BANK_ENABLED;
    const cfg = answerBankConfigFromEnv();
    expect(cfg.enabled).toBe(false);
    expect(cfg.semanticHigh).toBe(0.92);
    expect(cfg.semanticReview).toBe(0.8);
    expect(cfg.staleDays).toBeGreaterThan(0);
    process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';
  });

  it('stores and lists answers scoped to the user (isolation)', () => {
    runWithUser(USER, () => {
      const rec = upsertAnswer(USER, {
        canonicalQuestion: 'Are you willing to relocate to Berlin?',
        questionCategory: 'location',
        answerType: 'BOOLEAN',
        answerValue: true,
        source: 'USER_PROVIDED',
        sensitivity: 'PERSONAL',
        reusable: true,
      });
      expect(rec.id).toBeTruthy();
      expect(rec.userId).toBe(USER);
      expect(rec.normalizedQuestion).toBe(normalizeQuestion('Are you willing to relocate to Berlin?'));
      expect(rec.verificationStatus).toBe('VERIFIED');
    });
    expect(listAnswers(USER).length).toBeGreaterThan(0);
    expect(listAnswers(OTHER).length).toBe(0); // isolation
  });

  it('updates, deletes, and records usage', () => {
    const rec = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'What is your notice period?', questionCategory: 'availability',
      answerType: 'TEXT', answerValue: '30 days', source: 'USER_PROVIDED', reusable: true,
    }));
    const updated = updateAnswer(USER, rec.id, { answerValue: '60 days', verificationStatus: 'VERIFIED' });
    expect(updated?.answerValue).toBe('60 days');
    recordUsage(USER, rec.id);
    const afterUse = getAnswerById(USER, rec.id);
    expect(afterUse?.usageCount).toBe(1);
    expect(afterUse?.lastUsedAt).toBeTruthy();
    expect(deleteAnswer(USER, rec.id)).toBe(true);
    expect(getAnswerById(USER, rec.id)).toBeUndefined();
  });

  it('upsert by canonical key does not silently duplicate', () => {
    const a = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Will you now or in the future require sponsorship?', questionCategory: 'work_authorization',
      answerType: 'BOOLEAN', answerValue: false, source: 'USER_PROVIDED', reusable: true,
    }));
    const b = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Do you require visa sponsorship?', questionCategory: 'work_authorization',
      answerType: 'BOOLEAN', answerValue: false, source: 'USER_PROVIDED', reusable: true,
    }));
    expect(b.id).toBe(a.id);
    expect(listAnswers(USER).filter((r) => r.questionCategory === 'work_authorization')).toHaveLength(1);
  });

  it('another user cannot update or delete a foreign record', () => {
    const rec = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Portfolio URL', questionCategory: 'links',
      answerType: 'TEXT', answerValue: 'https://atanu.dev', source: 'USER_PROVIDED', reusable: true,
    }));
    expect(updateAnswer(OTHER, rec.id, { answerValue: 'stolen' })).toBeUndefined();
    expect(deleteAnswer(OTHER, rec.id)).toBe(false);
    expect(getAnswerById(USER, rec.id)?.answerValue).toBe('https://atanu.dev');
  });
});

// ── 4C. Canonicalization + matching ──────────────────────────────────────

describe('Answer canonicalization', () => {
  it('normalizes question text deterministically', () => {
    expect(normalizeQuestion('  Will you NOW or in the future require sponsorship?? ')).toBe('will you now or in the future require sponsorship');
  });

  it('maps phrasings to canonical keys via the existing alias ladder', () => {
    expect(canonicalKeyForQuestion('Will you now or in the future require sponsorship?')).toBe('requiresSponsorship');
    expect(canonicalKeyForQuestion('Do you require visa sponsorship?')).toBe('requiresSponsorship');
    expect(canonicalKeyForQuestion('Are you legally authorized to work in the United States?')).toBe('authorizedToWork');
    expect(canonicalKeyForQuestion('LinkedIn profile URL')).toBe('linkedinUrl');
    expect(canonicalKeyForQuestion('Why are you interested in this role?')).toBeUndefined();
  });
});

describe('AnswerBankMatcher', () => {
  const matcher = new AnswerBankMatcher({ semanticHigh: 0.92, semanticReview: 0.8 });

  const records = () => [
    {
      id: 'rec-exact', userId: USER, canonicalKey: undefined,
      canonicalQuestion: 'Are you willing to relocate to Berlin?', normalizedQuestion: normalizeQuestion('Are you willing to relocate to Berlin?'),
      questionCategory: 'location', answerType: 'BOOLEAN' as const, answerValue: true,
      source: 'USER_PROVIDED' as const, verificationStatus: 'VERIFIED' as const, sensitivity: 'PERSONAL' as const,
      reusable: true, aliases: [], createdAt: '', updatedAt: new Date().toISOString(), usageCount: 0,
    },
    {
      id: 'rec-canon', userId: USER, canonicalKey: 'requiresSponsorship',
      canonicalQuestion: 'Will you now or in the future require sponsorship?', normalizedQuestion: normalizeQuestion('Will you now or in the future require sponsorship?'),
      questionCategory: 'work_authorization', answerType: 'BOOLEAN' as const, answerValue: false,
      source: 'USER_PROVIDED' as const, verificationStatus: 'VERIFIED' as const, sensitivity: 'PERSONAL' as const,
      reusable: true, aliases: [], createdAt: '', updatedAt: new Date().toISOString(), usageCount: 0,
    },
    {
      id: 'rec-stale', userId: USER, canonicalKey: undefined,
      canonicalQuestion: 'What is your notice period?', normalizedQuestion: normalizeQuestion('What is your notice period?'),
      questionCategory: 'availability', answerType: 'TEXT' as const, answerValue: '30 days',
      source: 'USER_PROVIDED' as const, verificationStatus: 'STALE' as const, sensitivity: 'PERSONAL' as const,
      reusable: true, aliases: [], createdAt: '', updatedAt: new Date().toISOString(), usageCount: 0,
    },
    {
      id: 'rec-no-reuse', userId: USER, canonicalKey: undefined,
      canonicalQuestion: 'Describe a project you are proud of.', normalizedQuestion: normalizeQuestion('Describe a project you are proud of.'),
      questionCategory: 'motivation', answerType: 'TEXTAREA' as const, answerValue: 'A private answer',
      source: 'USER_PROVIDED' as const, verificationStatus: 'VERIFIED' as const, sensitivity: 'NORMAL' as const,
      reusable: false, aliases: [], createdAt: '', updatedAt: new Date().toISOString(), usageCount: 0,
    },
  ];

  it('EXACT match by normalized question', () => {
    const m = matcher.match({ question: 'are you willing to relocate to berlin', fieldType: 'BOOLEAN' }, records());
    expect(m.matchStatus).toBe('EXACT');
    expect(m.answer?.answerValue).toBe(true);
    expect(m.requiresReview).toBe(false);
  });

  it('CANONICAL match via the alias ladder when verified', () => {
    const m = matcher.match({ question: 'Do you require visa sponsorship?', fieldType: 'BOOLEAN', canonicalKey: 'requiresSponsorship' }, records());
    expect(m.matchStatus).toBe('CANONICAL');
    expect(m.answer?.answerValue).toBe(false);
    expect(m.requiresReview).toBe(false);
  });

  it('canonical beats fuzzy (relocate phrasings unify); below review confidence returns NONE', () => {
    const high = matcher.match({ question: 'Are you willing to relocate?', fieldType: 'BOOLEAN' }, records());
    expect(high.matchStatus).toBe('CANONICAL'); // read-time canonical keys unify phrasings
    expect(high.requiresReview).toBe(false);
    expect(high.answer?.id).toBe('rec-exact');
    const none = matcher.match({ question: 'Do you have experience with Kubernetes?', fieldType: 'TEXT' }, records());
    expect(none.matchStatus).toBe('NONE');
  });

  it('stale answers are matched but require review (never silently reused)', () => {
    const m = matcher.match({ question: 'What is your notice period?', fieldType: 'TEXT' }, records());
    expect(m.answer?.id).toBe('rec-stale');
    expect(m.requiresReview).toBe(true);
  });

  it('non-reusable records are never matched automatically', () => {
    const m = matcher.match({ question: 'Describe a project you are proud of.', fieldType: 'TEXTAREA' }, records());
    expect(m.matchStatus).toBe('NONE');
  });

  it('expired time-sensitive answers are treated as stale', () => {
    const expired = records().map((r) => (r.id === 'rec-exact' ? { ...r, expiresAt: new Date(Date.now() - 86400e3).toISOString() } : r));
    const m = matcher.match({ question: 'Are you willing to relocate to Berlin?', fieldType: 'BOOLEAN' }, expired);
    expect(m.requiresReview).toBe(true);
  });
});

// ── 4E. Submission Readiness Engine ──────────────────────────────────────

describe('SubmissionReadinessEngine', () => {
  const base = () => ({
    provider: 'lever',
    planStatus: 'READY_TO_SUBMIT' as const,
    totalRequiredFields: 6,
    resolvedRequiredFields: 6,
    unresolvedRequired: [] as string[],
    reviewRequired: [] as Array<{ label: string; reason: string }>,
    manualOnlyFields: [] as string[],
    consentFields: [] as Array<{ label: string; required: boolean }>,
    sensitiveFields: [] as string[],
    captchaPresent: false,
    otpRequired: false,
    loginRequired: false,
    unsupportedRequiredUpload: false,
    resumeReady: true,
    artifactVerified: true,
    pageStillMatchesPlan: true,
    companionReady: true,
    autoSubmitGlobalEnabled: false,
    autoSubmitThisApplication: false,
    executionMode: 'dry_run' as 'dry_run' | 'fill_only' | 'auto_submit',
    duplicateRisk: false,
    uncertainSubmissionExists: false,
  });

  it('100% normal fields → READY, canFill true, canSubmit false by default', () => {
    const r = evaluateSubmissionReadiness(base());
    expect(r.status).toBe('READY');
    expect(r.canFill).toBe(true);
    expect(r.canSubmit).toBe(false); // auto-submit is opt-in and OFF by default
  });

  it('field completion is NOT submission readiness: all fields filled but generated draft unapproved → NEEDS_REVIEW', () => {
    const r = evaluateSubmissionReadiness({ ...base(), reviewRequired: [{ label: 'Why this role?', reason: 'generated draft requires approval' }] });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.canSubmit).toBe(false);
  });

  it('unresolved required → NEEDS_USER_INPUT', () => {
    const r = evaluateSubmissionReadiness({ ...base(), resolvedRequiredFields: 5, unresolvedRequired: ['Are you willing to relocate to Berlin?'] });
    expect(r.status).toBe('NEEDS_USER_INPUT');
    expect(r.canFill).toBe(true); // can still fill what is known
  });

  it('CAPTCHA / OTP / missing resume / fingerprint mismatch → BLOCKED', () => {
    expect(evaluateSubmissionReadiness({ ...base(), captchaPresent: true }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), otpRequired: true }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), resumeReady: false }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), artifactVerified: false }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), pageStillMatchesPlan: false }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), unsupportedRequiredUpload: true }).status).toBe('BLOCKED');
  });

  it('duplicate or uncertain previous submission → BLOCKED', () => {
    expect(evaluateSubmissionReadiness({ ...base(), duplicateRisk: true }).status).toBe('BLOCKED');
    expect(evaluateSubmissionReadiness({ ...base(), uncertainSubmissionExists: true }).status).toBe('BLOCKED');
  });

  it('canSubmit requires: mode auto_submit + BOTH opt-ins + zero blockers', () => {
    const ready = { ...base(), executionMode: 'auto_submit' as const, autoSubmitGlobalEnabled: true, autoSubmitThisApplication: true };
    const r = evaluateSubmissionReadiness(ready);
    expect(r.canSubmit).toBe(true);
    expect(r.status).toBe('READY');
    expect(evaluateSubmissionReadiness({ ...ready, autoSubmitThisApplication: false }).canSubmit).toBe(false);
    expect(evaluateSubmissionReadiness({ ...ready, autoSubmitGlobalEnabled: false }).canSubmit).toBe(false);
    expect(evaluateSubmissionReadiness({ ...ready, executionMode: 'fill_only' as const }).canSubmit).toBe(false);
    expect(evaluateSubmissionReadiness({ ...ready, captchaPresent: true }).canSubmit).toBe(false);
    expect(evaluateSubmissionReadiness({ ...ready, reviewRequired: [{ label: 'x', reason: 'unapproved' }] }).canSubmit).toBe(false);
  });

  it('non-Lever/Greenhouse/Ashby provider → UNSUPPORTED', () => {
    expect(evaluateSubmissionReadiness({ ...base(), provider: 'workday' }).status).toBe('UNSUPPORTED');
    expect(evaluateSubmissionReadiness({ ...base(), provider: 'ashby' }).status).not.toBe('UNSUPPORTED');
  });

  it('consent fields block submission but are reported separately', () => {
    const r = evaluateSubmissionReadiness({ ...base(), consentFields: [{ label: 'I agree to the privacy policy', required: true }] });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.canSubmit).toBe(false);
    expect(r.reviewRequiredFields).toBeGreaterThanOrEqual(1);
  });
});

// ── 4D. Question learning + resolution order integration ─────────────────

const fakeDecisionEngine = (impl: (input: FieldClassificationInput) => FieldClassificationResult | null): DecisionEngine & { calls: FieldClassificationInput[] } => {
  const calls: FieldClassificationInput[] = [];
  return { name: 'fake-laya', calls, async classifyField(input) { calls.push(input); return impl(input); } };
};

describe('Answer Bank resolution + question learning', () => {
  it('dry-run resolution order: deterministic → ANSWER BANK → Laya (bank wins, Laya not called for it)', async () => {
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Why are you interested in this role?',
      questionCategory: 'motivation',
      answerType: 'TEXTAREA',
      answerValue: 'Because platform engineering is where I do my best work.',
      source: 'USER_PROVIDED',
      reusable: true,
    }));
    const j = job({ id: 'ab-order' });
    seedJob(j);
    const engine = fakeDecisionEngine(() => null);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts(), decisionEngine: engine }));
    const bank = result.answerBank.matched.find((m) => m.providerFieldId === 'why_interested');
    expect(bank).toBeTruthy();
    expect(bank!.value).toBe('Because platform engineering is where I do my best work.');
    expect(bank!.source).toBe('ANSWER_BANK');
    expect(bank!.requiresReview).toBe(false);
    // The bank answered it → the classification engine never sees that question.
    expect(engine.calls.map((c) => c.label)).not.toContain('Why are you interested in this role?');
    expect(result.submission.enabled).toBe(false);
  });

  it('unmatched questions still go to the classification engine', async () => {
    const j = job({ id: 'ab-unmatched' });
    seedJob(j);
    const engine = fakeDecisionEngine(() => null);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts(), decisionEngine: engine }));
    expect(engine.calls.map((c) => c.label)).toContain('Preferred location');
    expect(result.answerBank.matched.find((m) => m.providerFieldId === 'location_pref')).toBeUndefined();
  });

  it('learning: answering a question stores it and it is reused for a future equivalent question', async () => {
    const j1 = job({ id: 'ab-learn-1' });
    seedJob(j1);
    // Idempotent across repeated suite runs: the question THIS test banks is
    // cleared first, so 'before' always starts genuinely unanswered.
    for (const a of listAnswers(USER).filter((x) => /why are you interested in this role/i.test(x.canonicalQuestion))) {
      deleteAnswer(USER, a.id);
    }
    const before = await runWithUser(USER, () => runAutoApplyDryRun(j1.id, { ...fixtureOpts(), decisionEngine: fakeDecisionEngine(() => null) }));
    expect(before.unresolvedFields.some((f) => f.providerFieldId === 'why_interested')).toBe(true);

    // User answers it once, with "remember" enabled.
    const learned = await runWithUser(USER, () => answerQuestionForJob(USER, {
      jobId: j1.id,
      question: 'Why are you interested in this role?',
      answer: 'I enjoy building reliable developer platforms.',
      answerType: 'TEXTAREA',
      questionCategory: 'motivation',
      remember: true,
    }));
    expect(learned.stored).toBe(true);
    expect(learned.answer?.verificationStatus).toBe('VERIFIED');
    expect(learned.answer?.source).toBe('USER_PROVIDED');

    // Future equivalent application (different phrasing, same canonical question).
    const j2 = job({ id: 'ab-learn-2' });
    seedJob(j2);
    const after = await runWithUser(USER, () => runAutoApplyDryRun(j2.id, { ...fixtureOpts(), decisionEngine: fakeDecisionEngine(() => null) }));
    const reused = after.answerBank.matched.find((m) => m.providerFieldId === 'why_interested');
    expect(reused?.value).toBe('I enjoy building reliable developer platforms.');
  });

  it('learning without remember stores a RUN-SCOPED answer (never the reusable bank)', async () => {
    const j = job({ id: 'ab-noremember' });
    seedJob(j);
    const before = listAnswers(USER).length;
    const learned = await runWithUser(USER, () => answerQuestionForJob(USER, {
      jobId: j.id,
      question: 'What is your favorite database?',
      answer: 'Postgres',
      answerType: 'TEXT',
      remember: false,
    }));
    // Stored for THIS run (the loop must resume), explicitly not reusable.
    expect(learned.stored).toBe(true);
    expect(learned.reason).toBe('RUN_ONLY');
    expect(listAnswers(USER).length).toBe(before);
    const runOnly = listRunAnswers(USER, j.id);
    expect(runOnly).toHaveLength(1);
    expect(runOnly[0].answerValue).toBe('Postgres');
    // Another job never sees it.
    expect(listRunAnswers(USER, 'some-other-job')).toHaveLength(0);
    // This job's run resolves it through the exact same matching path.
    const [res] = resolveQuestionsFromBank(
      USER,
      [{ providerFieldId: 'f1', label: 'What is your favorite database?', fieldType: 'TEXT' }],
      runOnly,
    );
    expect(res.matchStatus).not.toBe('NONE');
    expect(res.value).toBe('Postgres');
  });

  it('agent value resolution: a RUN-ONLY answer resolves for its job — and only that job', async () => {
    const j = job({ id: 'ab-runonly-agent' });
    seedJob(j);
    await runWithUser(USER, () => answerQuestionForJob(USER, {
      jobId: j.id,
      question: 'Describe your ideal work environment.',
      answer: 'Remote-first with deep focus time.',
      remember: false,
    }));
    const fields = [{ ref: 'f1', kind: 'textarea', label: 'Describe your ideal work environment.' }];
    const mine = await resolveAgentValues(USER, fields, j.id);
    expect(mine.get('f1')).toBe('Remote-first with deep focus time.');
    const other = await resolveAgentValues(USER, fields, 'ab-learn-2');
    expect(other.get('f1')).toBeUndefined();
  });

  it('phone numbers never land in phone dial-code pickers', async () => {
    const fields = [
      { ref: 'p1', kind: 'text', label: 'Phone*', name: 'phone' },
      { ref: 'p2', kind: 'custom-select', label: 'Please select your Country Phone Code*', name: 'q1' },
    ];
    const vals = await resolveAgentValues(USER, fields);
    expect(String(vals.get('p1') || '')).toMatch(/[0-9]/); // the real phone fills
    expect(vals.get('p2')).toBeUndefined(); // the dial-code picker never gets the number
  });

  it('resolveQuestionsFromBank reports review-required for stale answers', () => {
    const rec = runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'When can you start?', questionCategory: 'availability',
      answerType: 'TEXT', answerValue: '2 weeks', source: 'USER_PROVIDED', reusable: true,
    }));
    runWithUser(USER, () => updateAnswer(USER, rec.id, { verificationStatus: 'STALE' }));
    const resolved = resolveQuestionsFromBank(USER, [{ providerFieldId: 'f1', label: 'When can you start?', fieldType: 'TEXT' }]);
    expect(resolved[0].matchStatus).not.toBe('NONE');
    expect(resolved[0].requiresReview).toBe(true);
  });

  it('answer bank disabled → dry run ignores it entirely', async () => {
    process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'false';
    const j = job({ id: 'ab-disabled' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts(), decisionEngine: fakeDecisionEngine(() => null) }));
    expect(result.answerBank.enabled).toBe(false);
    expect(result.answerBank.matched).toEqual([]);
  });
});
