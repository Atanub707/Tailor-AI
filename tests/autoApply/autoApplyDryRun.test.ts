// Auto Apply POC — Lever-only read-only dry run. Submission is disabled by
// construction; these tests pin the safety boundaries:
//   * feature flag defaults OFF and the endpoint disappears when disabled
//   * Lever-only (unsupported ATS → safe result, never inspected)
//   * ownership (another user's job is never visible)
//   * existing package/plan/artifact engines are reused (no duplicates)
//   * required unresolved questions stay requiresUser (never guessed)
//   * consent fields are never auto-answered
//   * EEO fields are never inferred
//   * submission.enabled is ALWAYS false
//   * zero network in fixture mode
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.AUTO_APPLY_ENABLED = 'false';

const { getDb, runWithUser, saveMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
const { resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
const { autoApplyEnabled, runAutoApplyDryRun, AutoApplyError } = await import('../../server/autoApply/autoApplyService.js');
const { createAutoApplyRouter } = await import('../../server/autoApply/autoApplyRouter.js');
import type { MasterCv, Job } from '../../src/types.js';
import type { DecisionEngine, FieldClassificationInput, FieldClassificationResult } from '../../server/autoApply/decisionEngine.js';
import type { GenerativeAnswerEngine, GenerativeAnswerInput, GeneratedAnswer } from '../../server/autoApply/generativeAnswerEngine.js';

const USER = 'aa-user';
const OTHER_USER = 'aa-other';
const NO_PHONE_USER = 'aa-nophone';

const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'DevOps engineer with 4+ years experience.',
  experiences: [{ id: '1', title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', responsibilities: ['Reduced deployment time by 70%'] }],
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
  id: 'aa-j1', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes, AWS and Terraform. Must have 4+ years experience building platform infrastructure.',
  atsPlatform: 'lever', jobUrl: 'https://jobs.lever.co/veo/e1', applyUrl: 'https://jobs.lever.co/veo/e1',
  url: 'https://jobs.lever.co/veo/e1', source: 'Lever', state: 'pending',
  ...over,
} as unknown as Job);

const seedJob = (j: Job, userId = USER) => {
  getDb().prepare('INSERT OR REPLACE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run(j.id, userId, JSON.stringify(j));
};

const fixtureOpts = (key = 'fixture-b-custom') => ({ mode: 'fixture' as const, adapter: new FixtureInspectionAdapter(key) });

// ── Router test app (mirrors server.ts's session middleware contract) ────
async function startApp(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithUser(String(req.headers['x-test-user'] || ''), () => next()));
  app.use('/api/auto-apply', createAutoApplyRouter());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

beforeAll(() => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  runWithUser(USER, () => {
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'AAUser', 'aa@test.local');
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(OTHER_USER, 'Other', 'other@test.local');
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(NO_PHONE_USER, 'NoPhone', 'nophone@test.local');
  });
  saveApplicantProfile(profile(), USER);
  saveMasterCv(cv, USER);
  // A user with NO phone anywhere: a known-key field with no configured answer
  // (deterministically classified — Laya must NOT be consulted for it).
  saveApplicantProfile(defaultApplicantProfile(), NO_PHONE_USER);
  saveMasterCv({ ...cv, phone: '' }, NO_PHONE_USER);
  resetInspectionState();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AUTO_APPLY_ENABLED = 'true';
  resetInspectionState();
});

// ── 1. Feature flag ──────────────────────────────────────────────────────

describe('Auto Apply — feature flag', () => {
  it('defaults to disabled and the dry-run endpoint is unavailable', async () => {
    process.env.AUTO_APPLY_ENABLED = 'false';
    expect(autoApplyEnabled()).toBe(false);
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/api/auto-apply/dry-run`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': USER }, body: JSON.stringify({ jobId: 'aa-j1' }),
      });
      expect(res.status).toBe(404);
      const status = await fetch(`${app.base}/api/auto-apply/status`);
      expect(await status.json()).toMatchObject({ enabled: false, executionTransport: 'tailor_browser' });
    } finally {
      await app.close();
    }
  });

  it('service refuses to run when disabled', async () => {
    process.env.AUTO_APPLY_ENABLED = 'false';
    await expect(runAutoApplyDryRun('aa-j1')).rejects.toMatchObject({ code: 'AUTO_APPLY_DISABLED' });
  });
});

// ── 2-9. Dry-run behavior ────────────────────────────────────────────────

describe('Auto Apply — Lever dry run (read-only)', () => {
  it('Lever job → DRY_RUN_READY with mapped fields, exact resume and submission disabled', async () => {
    const j = job({ id: 'aa-ready' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.provider).toBe('lever');
    expect(result.job).toEqual({ id: 'aa-ready', title: 'Platform Engineer', company: 'Veo' });
    expect(result.targetUrl).toBe('https://jobs.lever.co/veo/e1');
    expect(result.submission).toEqual({ enabled: false });
    // Deterministic identity answers come from the canonical profile.
    const name = result.fields.find((f) => f.providerFieldId === 'name');
    expect(name?.proposedValue).toBe('Ravi Kumar');
    // Deterministic identity answer — from the canonical profile or Master CV.
    expect(['PROFILE', 'MASTER_CV']).toContain(name?.source);
    expect(name?.requiresUser).toBe(false);
    const email = result.fields.find((f) => f.providerFieldId === 'email');
    expect(email?.proposedValue).toBe('ravi@example.com');
    // Resume is the package's exact artifact.
    expect(result.resume.available).toBe(true);
    expect(result.resume.artifactHash).toBeTruthy();
    expect(result.resume.fileName).toMatch(/_CV\.pdf$/);
  });

  it('unsupported ATS → safe UNSUPPORTED_ATS result, never inspected', async () => {
    const j = {
      ...job({
        id: 'aa-gh', atsPlatform: 'workday', source: 'Workday',
        applyUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/9', url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/9',
      }),
      jobUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/9',
    } as Job;
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(result.status).toBe('UNSUPPORTED_ATS');
    expect(result.provider).toBe('unknown');
    expect(result.fields).toEqual([]);
    expect(result.submission).toEqual({ enabled: false });
    expect(result.message).toMatch(/not supported/i);
  });

  it("another user's job is never visible", async () => {
    const j = job({ id: 'aa-foreign' });
    seedJob(j, USER);
    await expect(runWithUser(OTHER_USER, () => runAutoApplyDryRun(j.id, fixtureOpts()))).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  it('missing tailored resume → Master CV fallback artifact is respected', async () => {
    const j = job({ id: 'aa-mastercv' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.resume.source).toBe('MASTER_CV');
    expect(result.resume.available).toBe(true);
  });

  it('a tailored CV on the job is preferred and used exactly', async () => {
    const j = job({ id: 'aa-tailored' });
    seedJob(j);
    const content = {
      summary: 'Platform engineer.', skills: ['Kubernetes', 'AWS'],
      experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%'] }],
      education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
      certifications: ['CKA'], projects: [],
    };
    const tailoredCv = {
      candidateName: 'Ravi Kumar', targetRole: 'Platform Engineer', professionalSummary: content.summary,
      coreCompetencies: content.skills, workExperience: content.experience, education: content.education,
      technicalSkills: [{ category: 'Skills', skills: content.skills }], certifications: content.certifications, projects: [],
    } as any;
    const { updateJobInStorage } = await import('../../server/storage/fileStorage.js');
    runWithUser(USER, () => updateJobInStorage({ ...j, tailoredCv } as any));
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.resume.source).toBe('TAILORED');
    expect(result.resume.available).toBe(true);
  });

  it('required unresolved question → requiresUser true, never guessed', async () => {
    const j = job({ id: 'aa-unresolved' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts('fixture-b-custom')));
    // fixture-b has a required free-text "Why are you interested in this role?"
    // with no package answer — it must surface as requiresUser.
    const why = result.unresolvedFields.find((f) => f.providerFieldId === 'why_interested');
    expect(why).toBeTruthy();
    expect(why?.required).toBe(true);
    expect(why?.requiresUser).toBe(true);
    expect(result.fields.some((f) => f.providerFieldId === 'why_interested')).toBe(false);
  });

  it('consent field → REQUIRES_REVIEW, never auto-answered', async () => {
    const j = job({ id: 'aa-consent' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts('fixture-c-complex')));
    const consent = result.consentFields.find((f) => f.providerFieldId === 'privacy_consent');
    expect(consent).toBeTruthy();
    expect(consent?.status).toBe('REQUIRES_REVIEW');
    expect(result.fields.some((f) => f.providerFieldId === 'privacy_consent')).toBe(false);
  });

  it('EEO fields → voluntary unresolved only, never inferred', async () => {
    const j = job({ id: 'aa-eeo' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts('fixture-c-complex')));
    const ids = result.unresolvedFields.map((f) => f.providerFieldId);
    expect(ids).toContain('gender');
    expect(ids).toContain('veteran');
    // Voluntary and optional — they never block, and they are never inferred.
    expect(result.unresolvedFields.filter((f) => f.providerFieldId === 'gender').every((f) => f.requiresUser === false)).toBe(true);
    expect(result.fields.some((f) => f.providerFieldId === 'gender' || f.providerFieldId === 'veteran')).toBe(false);
  });

  it('missing usable JD → PACKAGE_NOT_READY, no inspection attempted', async () => {
    const j = job({ id: 'aa-nojd', description: 'Too short.' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
    expect(result.status).toBe('PACKAGE_NOT_READY');
    expect(result.submission).toEqual({ enabled: false });
    expect(result.message).toMatch(/description/i);
  });

  it('submission.enabled is false in every outcome', async () => {
    const ready = job({ id: 'aa-always-ready' });
    seedJob(ready);
    const gh = job({
      id: 'aa-always-gh', atsPlatform: 'greenhouse', source: 'Greenhouse',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/9', url: 'https://boards.greenhouse.io/acme/jobs/9',
    });
    seedJob(gh);
    const nojd = job({ id: 'aa-always-nojd', description: 'Too short.' });
    seedJob(nojd);
    for (const id of ['aa-always-ready', 'aa-always-gh', 'aa-always-nojd']) {
      const result = await runWithUser(USER, () => runAutoApplyDryRun(id, fixtureOpts()));
      expect(result.submission.enabled).toBe(false);
    }
  });

  it('fixture-mode dry run performs zero network calls', async () => {
    const j = job({ id: 'aa-nonet' });
    seedJob(j);
    let fetches = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { fetches++; return (orig as any)(...a); };
    try {
      const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts()));
      expect(result.status).toBe('DRY_RUN_READY');
    } finally {
      (globalThis as any).fetch = orig;
    }
    expect(fetches).toBe(0);
  });
});

// ── Router auth/ownership mapping ────────────────────────────────────────

describe('Auto Apply — router guards', () => {
  it('unauthenticated dry-run → 401', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/api/auto-apply/dry-run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'aa-j1' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('unknown or foreign job → 404 (ownership enforced by user-scoped lookup)', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/api/auto-apply/dry-run`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': OTHER_USER }, body: JSON.stringify({ jobId: 'aa-ready' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('missing jobId → 400', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/api/auto-apply/dry-run`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': USER }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('status endpoint reflects the flag when enabled', async () => {
    const app = await startApp();
    try {
      const status = await fetch(`${app.base}/api/auto-apply/status`);
      expect(await status.json()).toMatchObject({ enabled: true, executionTransport: 'tailor_browser' });
    } finally {
      await app.close();
    }
  });
});

// ── Laya decision engine integration (advisory only) ─────────────────────

const fakeEngine = (resolver: (input: FieldClassificationInput) => FieldClassificationResult | null): DecisionEngine & { calls: FieldClassificationInput[] } => {
  const calls: FieldClassificationInput[] = [];
  return {
    name: 'fake-laya',
    calls,
    async classifyField(input: FieldClassificationInput) {
      calls.push(input);
      return resolver(input);
    },
  };
};

describe('Auto Apply — Laya decision engine (advisory)', () => {
  it('LAYA disabled (default) → no suggestions, engine "none", identical result shape', async () => {
    delete process.env.LAYA_ENABLED;
    const j = job({ id: 'aa-laya-off' });
    seedJob(j);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, fixtureOpts('fixture-b-custom')));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.aiSuggestions).toEqual([]);
    expect(result.decision).toMatchObject({ engine: 'none', enabled: false, evaluated: 0 });
    expect(result.submission).toEqual({ enabled: false });
    // deterministic behavior unchanged
    expect(result.fields.find((f) => f.providerFieldId === 'name')?.proposedValue).toBe('Ravi Kumar');
  });

  it('deterministic fields never reach Laya; only ambiguous fields are sent', async () => {
    const j = job({ id: 'aa-laya-scope' });
    seedJob(j);
    const engine = fakeEngine(() => null);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    const labels = engine.calls.map((c) => c.label);
    // resolved deterministically → never sent
    expect(labels).not.toContain('Name');
    expect(labels).not.toContain('Email');
    expect(labels).not.toContain('Resume');
    // ambiguous → sent
    expect(labels).toContain('Why are you interested in this role?');
    expect(labels).toContain('Preferred location');
    expect(engine.calls).toHaveLength(2);
    expect(result.decision).toMatchObject({ engine: 'fake-laya', enabled: true, evaluated: 2 });
  });

  it('known-key field with no configured answer is classified deterministically — Laya not called', async () => {
    const j = job({ id: 'aa-laya-knownkey' });
    seedJob(j, NO_PHONE_USER);
    const engine = fakeEngine(() => null);
    const result = await runWithUser(NO_PHONE_USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-a-simple'), decisionEngine: engine }));
    expect(result.status).toBe('DRY_RUN_READY');
    // Phone is deterministically classifiable but has no answer → stays
    // unresolved, and Laya is never consulted for it (deterministic first).
    expect(engine.calls).toHaveLength(0);
    const phone = result.unresolvedFields.find((f) => f.providerFieldId === 'phone');
    expect(phone).toBeTruthy();
    expect(result.aiSuggestions).toEqual([]);
    expect(result.decision.evaluated).toBe(0);
  });

  it('high-confidence benign suggestion → AI_SUGGESTED with the value from the existing answer catalog', async () => {
    const j = job({ id: 'aa-laya-high' });
    seedJob(j);
    const engine = fakeEngine((input) =>
      input.label === 'Preferred location'
        ? { canonicalKey: 'currentCity', category: 'LOCATION', confidence: 0.95, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : null
    );
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'location_pref');
    expect(s).toBeTruthy();
    expect(s!.mappingMethod).toBe('AI_SUGGESTED');
    expect(s!.proposedValue).toBe('Bengaluru'); // from the profile — Laya never generates values
    expect(s!.requiresUser).toBe(false);
    expect(s!.hardBlocked).toBe(false);
    expect(s!.confidence).toBeCloseTo(0.95);
    expect(result.submission.enabled).toBe(false);
  });

  it('medium confidence → suggestion shown but requiresUser=true', async () => {
    const j = job({ id: 'aa-laya-medium' });
    seedJob(j);
    const engine = fakeEngine((input) =>
      input.label === 'Preferred location'
        ? { canonicalKey: 'currentCity', category: 'LOCATION', confidence: 0.78, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : null
    );
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'location_pref');
    expect(s).toBeTruthy();
    expect(s!.requiresUser).toBe(true);
    expect(result.decision.requiresUser).toBeGreaterThanOrEqual(1);
  });

  it('low confidence → no suggestion, field stays unresolved', async () => {
    const j = job({ id: 'aa-laya-low' });
    seedJob(j);
    const engine = fakeEngine((input) =>
      input.label === 'Preferred location'
        ? { canonicalKey: 'currentCity', category: 'LOCATION', confidence: 0.4, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : null
    );
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    expect(result.aiSuggestions.find((x) => x.providerFieldId === 'location_pref')).toBeUndefined();
    expect(result.unresolvedFields.find((f) => f.providerFieldId === 'location_pref')?.requiresUser).toBe(false); // optional
  });

  it('sensitive key (sponsorship) at 0.99 → value may show, always requires the user', async () => {
    const j = job({ id: 'aa-laya-sensitive' });
    seedJob(j);
    const engine = fakeEngine((input) =>
      input.label === 'Why are you interested in this role?'
        ? { canonicalKey: 'requiresSponsorship', category: 'SPONSORSHIP', confidence: 0.99, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : null
    );
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'why_interested');
    expect(s).toBeTruthy();
    expect(s!.proposedValue).toBe('No');
    expect(s!.requiresUser).toBe(true);
  });

  it('EEO at 0.99 through the pipeline → hard-blocked, no value ever attached', async () => {
    const j = job({ id: 'aa-laya-eeo' });
    seedJob(j);
    const engine = fakeEngine((input) =>
      input.label === 'Why are you interested in this role?'
        ? { canonicalKey: 'gender', category: 'EEO', confidence: 0.99, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : null
    );
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'why_interested');
    expect(s).toBeTruthy();
    expect(s!.hardBlocked).toBe(true);
    expect(s!.proposedValue).toBeNull();
    expect(s!.requiresUser).toBe(true);
  });

  it('engine failure (null for every field) → dry run still succeeds safely', async () => {
    const j = job({ id: 'aa-laya-down' });
    seedJob(j);
    const engine = fakeEngine(() => null);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: engine }));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.aiSuggestions).toEqual([]);
    expect(result.decision.failed).toBe(2);
    expect(result.submission).toEqual({ enabled: false });
    // unresolved fields remain actionable for the user
    expect(result.unresolvedFields.some((f) => f.requiresUser)).toBe(true);
  });
});

// ── Grounded generative drafts (advisory, review-required) ───────────────

const fakeGen = (
  impl: (input: GenerativeAnswerInput) => Promise<GeneratedAnswer | null>
): GenerativeAnswerEngine & { calls: GenerativeAnswerInput[] } => {
  const calls: GenerativeAnswerInput[] = [];
  return {
    name: 'fake-gen',
    calls,
    async generateAnswer(input) {
      calls.push(input);
      return impl(input);
    },
  };
};

const genDraft = (value: string): GeneratedAnswer => ({
  value,
  source: 'GENERATED_FROM_CANDIDATE_FACTS',
  requiresUserReview: true,
  supportingFacts: [{ id: 'exp-1', source: 'MASTER_CV', summary: 'DevOps Engineer at Acme Cloud' }],
  warnings: [],
  questionCategory: 'why_role',
});

const generativeClassify = (input: FieldClassificationInput): FieldClassificationResult | null =>
  input.label === 'Why are you interested in this role?'
    ? { category: 'CUSTOM', answerSource: 'GENERATIVE_REQUIRED', confidence: 0.97, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
    : null;

describe('Auto Apply — grounded generative drafts', () => {
  it('generative disabled (default) → no drafts, meta disabled, behavior unchanged', async () => {
    delete process.env.AUTO_APPLY_GENERATIVE_ENABLED;
    const j = job({ id: 'aa-gen-off' });
    seedJob(j);
    const decision = fakeEngine(generativeClassify);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, { ...fixtureOpts('fixture-b-custom'), decisionEngine: decision }));
    expect(result.generative).toMatchObject({ engine: 'none', enabled: false, requested: 0, generated: 0 });
    expect(result.aiSuggestions.find((s) => s.providerFieldId === 'why_interested')?.generatedDraft).toBeUndefined();
    expect(result.submission).toEqual({ enabled: false });
  });

  it('GENERATIVE_REQUIRED → engine called once; grounded draft attached with review required', async () => {
    const j = job({ id: 'aa-gen-on' });
    seedJob(j);
    const decision = fakeEngine(generativeClassify);
    const gen = fakeGen(async () => genDraft('I build Kubernetes platforms at Acme Cloud and would bring that focus to Veo.'));
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, {
      ...fixtureOpts('fixture-b-custom'), decisionEngine: decision, generativeEngine: gen,
    }));
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0].question).toBe('Why are you interested in this role?');
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'why_interested');
    expect(s?.generatedDraft?.value).toContain('Acme Cloud');
    expect(s?.generatedDraft?.source).toBe('GENERATED_FROM_CANDIDATE_FACTS');
    expect(s?.generatedDraft?.requiresUserReview).toBe(true);
    expect(s?.requiresUser).toBe(true); // never auto-resolved
    expect(result.generative).toMatchObject({ engine: 'fake-gen', enabled: true, requested: 1, generated: 1, failed: 0 });
    expect(result.submission.enabled).toBe(false);
  });

  it('PROFILE / USER_REQUIRED suggestions never call the generative engine', async () => {
    const j = job({ id: 'aa-gen-profile' });
    seedJob(j);
    const decision = fakeEngine((input) =>
      input.label === 'Preferred location'
        ? { canonicalKey: 'currentCity', category: 'LOCATION', answerSource: 'PROFILE', confidence: 0.95, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
        : input.label === 'Why are you interested in this role?'
          ? { category: 'CUSTOM', answerSource: 'USER_REQUIRED', confidence: 0.9, mappingMethod: 'AI_SUGGESTED', requiresUser: true }
          : null
    );
    const gen = fakeGen(async () => genDraft('should not happen'));
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, {
      ...fixtureOpts('fixture-b-custom'), decisionEngine: decision, generativeEngine: gen,
    }));
    expect(gen.calls).toHaveLength(0);
    expect(result.generative.requested).toBe(0);
    expect(result.aiSuggestions.every((s) => !s.generatedDraft)).toBe(true);
  });

  it('generation failure → suggestion stays review-required, dry run continues', async () => {
    const j = job({ id: 'aa-gen-fail' });
    seedJob(j);
    const decision = fakeEngine(generativeClassify);
    const gen = fakeGen(async () => null);
    const result = await runWithUser(USER, () => runAutoApplyDryRun(j.id, {
      ...fixtureOpts('fixture-b-custom'), decisionEngine: decision, generativeEngine: gen,
    }));
    expect(result.status).toBe('DRY_RUN_READY');
    expect(result.generative).toMatchObject({ requested: 1, generated: 0, failed: 1 });
    const s = result.aiSuggestions.find((x) => x.providerFieldId === 'why_interested');
    expect(s?.generatedDraft).toBeUndefined();
    expect(s?.requiresUser).toBe(true);
    expect(result.submission.enabled).toBe(false);
  });

});
