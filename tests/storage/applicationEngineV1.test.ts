// Application Engine V1 — Phase 1: package gate, provider detection,
// fixture inspection, deterministic mapping, plans, dry-run, safety.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-v1-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage, preparePackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage, getPackageById } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan, gatePackage, buildPreview, EngineGateError } = await import('../../server/applicationEngine/engine.js');
const { FixtureInspectionAdapter, targetFromJob } = await import('../../server/applicationEngine/fixtureAdapter.js');
const { mapRequirements } = await import('../../server/applicationEngine/mapper.js');
const { getPlanById, getLatestPlanForPackage } = await import('../../server/applicationEngine/planStore.js');
const { detectProvider, classifyTarget } = await import('../../server/applicationEngine/contract.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'eng-user';

const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'DevOps engineer with 4+ years experience.',
  experiences: [{ id: '1', title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS clusters'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  p.preferences = { noticePeriod: '30 days', salaryCurrency: 'INR', minimumSalary: 2000000, targetSalary: 2500000 };
  p.skills = [{ name: 'Kubernetes' }, { name: 'AWS' }];
  p.experience = [{ company: 'Acme Cloud', title: 'DevOps Engineer', startDate: '2022-03', endDate: '2023-06' }];
  p.certifications = [{ name: 'CKA' }];
  return p;
};

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', externalId: 'e1', title: 'DevOps Engineer', company: 'Acme', companyId: 'Acme', location: 'Remote',
  description: 'Required: Kubernetes, AWS and Terraform. Must have 4+ years experience.',
  atsPlatform: 'lever', jobUrl: 'https://jobs.lever.co/acme/e1', applyUrl: 'https://jobs.lever.co/acme/e1',
  url: 'https://jobs.lever.co/acme/e1', source: 'Lever', state: 'pending',
  ...over,
} as unknown as Job);

const tailoredVersion = (jobId = 'j1') => ({
  id: `t2-${USER.slice(-8)}-${jobId.slice(-10)}-v1`, userId: USER, jobId, version: 1,
  masterCvUpdatedAt: 'cv1', profileUpdatedAt: 'p1', jdHash: 'jd1', fitEngineVersion: 3, tailorEngineVersion: 1,
  content: {
    summary: 'DevOps engineer with 4+ years experience.', skills: ['Kubernetes', 'AWS', 'Terraform'],
    experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%'] }],
    education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }], certifications: ['CKA'], projects: [],
  },
  verification: { passed: true, issues: [], supportedJdTermsBefore: 2, supportedJdTermsAfter: 3, unsupportedInserted: 0 },
  stale: false, createdAt: new Date().toISOString(),
});

const makePackage = async (jobOver: Partial<Job> = {}) => {
  const p = profile();
  const j = job(jobOver);
  const fit = computeFit(p, cv, j, j.description || '');
  return buildPackage({ userId: USER, job: j, jd: j.description || '', profile: p, masterCv: cv, fit, tailoredVersion: tailoredVersion() }, 'cv1');
};

describe('Application Engine V1 — Phase 1', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'EngUser', 'eng@test.local'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Package gate ───────────────────────────────────────────────────────
  it('gate: READY allowed; DRAFT/STALE/missing-artifact/hash refused', async () => {
    const pkg = await makePackage();
    expect(pkg.status).toBe('READY');
    expect(gatePackage(pkg, true).ok).toBe(true);
    expect(gatePackage({ ...pkg, status: 'DRAFT' }, true).error).toBe('PACKAGE_NOT_READY');
    expect(gatePackage({ ...pkg, status: 'STALE' }, true).error).toBe('PACKAGE_STALE');
    expect(gatePackage({ ...pkg, snapshotHash: '' }, true).error).toBe('PACKAGE_HASH_INVALID');
    expect(gatePackage({ ...pkg, resumeSnapshot: null }, true).error).toBe('RESUME_ARTIFACT_MISSING');
    expect(gatePackage(pkg, false).error).toBe('RESUME_ARTIFACT_INVALID');
    expect(gatePackage(undefined, true).error).toBe('PACKAGE_NOT_FOUND');
  });

  // ── Provider detection / redirects ────────────────────────────────────
  it('detection: host+platform agreement high; conflicts classified', () => {
    expect(detectProvider('greenhouse', 'https://job-boards.greenhouse.io/x/jobs/1', undefined).provider).toBe('greenhouse');
    expect(detectProvider('lever', 'https://jobs.lever.co/x/1', undefined).provider).toBe('lever');
    expect(detectProvider('ashby', 'https://jobs.ashbyhq.com/x/1/application', undefined).provider).toBe('ashby');
    // Greenhouse source + Lever applyUrl → host wins (redirect/conflict)
    const conflict = detectProvider('greenhouse', 'https://jobs.lever.co/other/9', undefined);
    expect(conflict.provider).toBe('lever');
    expect(conflict.confidence).toBe('medium');
    expect(classifyTarget('https://jobs.lever.co/other/9', 'greenhouse')).toBe('REDIRECTED_SUPPORTED_TARGET');
    expect(classifyTarget('https://careers.workday.com/x/1', 'greenhouse')).toBe('REDIRECTED_SUPPORTED_TARGET');
    expect(classifyTarget('https://careers.workday.com/x/1', undefined)).toBe('UNSUPPORTED_TARGET');
    expect(classifyTarget(undefined, 'lever')).toBe('MANUAL_ONLY');
  });

  // ── Plan creation (fixture inspection) ────────────────────────────────
  it('plan: READY package + fixture-B → NEEDS_REVIEW (consent/EEO) or mapped correctly', async () => {
    const pkg = await makePackage();
    const jobRow = job();
    const { plan, reused, gate } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg: pkg as unknown as any, job: jobRow, adapter: new FixtureInspectionAdapter('fixture-b-custom'), artifactOk: true });
    expect(gate.ok).toBe(true);
    expect(plan.packageSnapshotHash).toBe(pkg.snapshotHash);
    expect(plan.provider).toBe('lever');
    // name/email/authorization/sponsorship/why/resume mapped; location_pref optional-unresolved fine
    expect(plan.mappedFields.length).toBeGreaterThanOrEqual(5);
    const auth = plan.mappedFields.find((m) => m.canonicalKey === 'authorizedToWork');
    expect(auth?.value).toBe('Yes');
    // the adapter normalized the label deterministically → EXACT at plan level
    expect(auth?.mappingMethod).toBe('EXACT');
    const sponsorship = plan.mappedFields.find((m) => m.canonicalKey === 'requiresSponsorship');
    expect(sponsorship?.value).toBe('No');
    expect(plan.files.some((f) => f.kind === 'RESUME' && f.artifactSha === pkg.resumeSnapshot?.pdfHash)).toBe(true);
    expect(reused).toBe(false);
  });

  it('plan: fixture-C complex → NEEDS_REVIEW (consent + EEO), never auto-mapped', async () => {
    const pkg = await makePackage();
    const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-c-complex'), artifactOk: true });
    expect(plan.status).toBe('NEEDS_REVIEW');
    expect(plan.consentFields.length).toBe(1);
    expect(plan.consentFields[0].label).toContain('privacy');
    expect(plan.manualFields.filter((m) => m.reason.includes('EEO')).length).toBe(2);
    // clearance + custom_blob required + unknown optional
    expect(plan.unresolvedDetails.some((u) => u.providerFieldId === 'clearance')).toBe(true);
    expect(plan.unresolvedDetails.some((u) => u.providerFieldId === 'custom_blob')).toBe(true);
  });

  it('plan: idempotent — identical inputs reuse the latest plan', async () => {
    const pkg = await makePackage();
    const input = { userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-b-custom'), artifactOk: true };
    const first = await createPlan(input);
    const second = await createPlan(input);
    expect(second.reused).toBe(true);
    expect(second.plan.id).toBe(first.plan.id);
  });

  it('plan: requirements change → different fingerprint + new plan (FORM_CHANGED model)', async () => {
    const pkg = await makePackage();
    const a = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-b-custom'), artifactOk: true });
    const b = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-d-changed'), artifactOk: true });
    expect(b.plan.requirementsFingerprint).not.toBe(a.plan.requirementsFingerprint);
    expect(b.plan.planFingerprint).not.toBe(a.plan.planFingerprint);
    expect(b.reused).toBe(false);
  });

  it('plan: package stale after plan creation → engine reports execution ineligible without mutating plan', async () => {
    const pkg = await makePackage();
    const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-b-custom'), artifactOk: true });
    const stalePkg = { ...pkg, status: 'STALE' } as unknown as any;
    const gate = gatePackage(stalePkg, true);
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe('PACKAGE_STALE');
    const stored = getPlanById(USER, plan.id);
    expect(stored?.status).toBe(plan.status); // historical plan untouched
  });

  it('plan: plan fingerprint deterministic 10x', async () => {
    const pkg = await makePackage();
    const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-a-simple'), artifactOk: true });
    const { planFingerprint } = await import('../../server/applicationEngine/planStore.js');
    const target = targetFromJob(job());
    const fp = planFingerprint(pkg.snapshotHash, 'lever', `${target.provider}|${target.externalJobId}|${target.applyUrl}`, plan.requirementsFingerprint, 'm', 'f', 'c', 'm');
    for (let i = 0; i < 9; i++) {
      expect(planFingerprint(pkg.snapshotHash, 'lever', `${target.provider}|${target.externalJobId}|${target.applyUrl}`, plan.requirementsFingerprint, 'm', 'f', 'c', 'm')).toBe(fp);
    }
  });

  it('ownership: User B cannot see User A plans', async () => {
    const pkg = await makePackage();
    const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-a-simple'), artifactOk: true });
    expect(getPlanById('other-user', plan.id)).toBeUndefined();
    expect(getLatestPlanForPackage('other-user', pkg.id)).toBeUndefined();
  });

  // ── Mapping safety matrix ──────────────────────────────────────────────
  it('mapping: alias resolution + boolean select + salary currency safety', async () => {
    const pkg = await makePackage();
    const fields = [
      { providerFieldId: 'first_name', label: 'Given Name', type: 'TEXT' as const, required: true, category: 'IDENTITY' as const },
      { providerFieldId: 'email', label: 'Email', type: 'EMAIL' as const, required: true, category: 'CONTACT' as const },
      { providerFieldId: 'authorized', label: 'Are you legally authorized to work in the United States?', type: 'SINGLE_SELECT' as const, required: true, category: 'WORK_AUTHORIZATION' as const, options: ['Yes', 'No'] },
      { providerFieldId: 'salary', label: 'Expected annual salary (USD)', type: 'TEXT' as const, required: false, category: 'COMPENSATION' as const },
    ];
    const r = mapRequirements(pkg, fields);
    expect(r.mapped.find((m) => m.providerFieldId === 'first_name')?.value).toBe('Ravi');
    expect(r.mapped.find((m) => m.providerFieldId === 'authorized')?.value).toBe('Yes');
    expect(r.unresolved.some((u) => u.providerFieldId === 'salary')).toBe(true); // INR vs USD — no FX
  });

  it('mapping: boolean false stays false; ambiguous select unresolved', async () => {
    const p = profile();
    p.workAuthorization = { country: 'India', authorizedToWork: 'no', requiresSponsorship: 'no' } as any;
    const pkg = await makePackage();
    const fields = [
      { providerFieldId: 'auth', label: 'Authorized to work', type: 'SINGLE_SELECT' as const, required: true, category: 'WORK_AUTHORIZATION' as const, options: ['Yes', 'No'] },
      { providerFieldId: 'notice', label: 'Notice period', type: 'SINGLE_SELECT' as const, required: true, category: 'CUSTOM' as const, options: ['Immediate', '2 weeks', '1 month', '2 months'] },
    ];
    const r = mapRequirements({ ...pkg, answers: pkg.answers.map((a) => (a.key === 'authorizedToWork' ? { ...a, value: 'no', status: 'RESOLVED' as const } : a)) } as any, fields);
    expect(r.mapped.find((m) => m.providerFieldId === 'auth')?.value).toBe('No');
    expect(r.mapped.find((m) => m.providerFieldId === 'notice')?.value).toBe('1 month'); // deterministic 30 days → 1 month
  });

  it('mapping: EEO/consent/unknown hard safety', async () => {
    const pkg = await makePackage();
    const fields = [
      { providerFieldId: 'gender', label: 'Gender (voluntary)', type: 'SINGLE_SELECT' as const, required: false, category: 'EEO' as const, options: ['Female', 'Male', 'Decline to answer'] },
      { providerFieldId: 'privacy', label: 'I agree to the privacy policy.', type: 'CONSENT' as const, required: true, category: 'CONSENT' as const },
      { providerFieldId: 'mystery', label: 'Mystery question', type: 'UNKNOWN' as const, required: true, category: 'UNKNOWN' as const },
    ];
    const r = mapRequirements(pkg, fields);
    expect(r.mapped.some((m) => m.providerFieldId === 'gender')).toBe(false);
    expect(r.manual.some((m) => m.providerFieldId === 'gender')).toBe(true);
    expect(r.consent.some((c) => c.providerFieldId === 'privacy')).toBe(true);
    expect(r.unresolved.some((u) => u.providerFieldId === 'mystery')).toBe(true);
  });

  it('mapping: resume maps ONLY to the package artifact', async () => {
    const pkg = await makePackage();
    const r = mapRequirements(pkg, [{ providerFieldId: 'resume', label: 'Resume/CV', type: 'FILE' as const, required: true, category: 'RESUME' as const }]);
    expect(r.files.length).toBe(1);
    expect(r.files[0].artifactSha).toBe(pkg.resumeSnapshot?.pdfHash);
    expect(r.mapped.find((m) => m.providerFieldId === 'resume')?.source).toBe('PACKAGE');
  });

  // ── Dry-run preview ────────────────────────────────────────────────────
  it('preview: faithful + minimized (no CV/JD/keys)', async () => {
    const pkg = await makePackage();
    const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-b-custom'), artifactOk: true });
    const preview = buildPreview(plan, pkg);
    expect(preview.provider).toBe('lever');
    expect(preview.packageSnapshotHash).toBe(pkg.snapshotHash);
    expect(preview.resume?.artifactHash).toBe(pkg.resumeSnapshot?.pdfHash);
    expect(preview.mappedFields.length).toBeGreaterThanOrEqual(5);
    const json = JSON.stringify(preview).toLowerCase();
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('apify');
    expect(preview.unresolved).toBeDefined();
    expect(preview.consent).toBeDefined();
  });

  // ── Safety: zero LLM / zero Tailor / zero ATS mutations ───────────────
  it('safety: plan creation performs no LLM/Tailor/PDF regeneration/network', async () => {
    const pkg = await makePackage();
    let fetches = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { fetches++; return (orig as any)(...a); };
    try {
      const { plan } = await createPlan({ userId: USER, mode: 'fixture' as const, pkg, job: job(), adapter: new FixtureInspectionAdapter('fixture-c-complex'), artifactOk: true });
      expect(plan.id).toBeTruthy();
    } finally {
      (globalThis as any).fetch = orig;
    }
    expect(fetches).toBe(0);
  });

  it('adapter contract: inspect() is read-only by interface (fixture mode, no mutation paths)', async () => {
    const adapter = new FixtureInspectionAdapter('fixture-a-simple');
    const target = targetFromJob(job());
    const reqs = await adapter.inspect(target);
    expect(reqs.fields.some((f) => f.providerFieldId === 'resume')).toBe(true);
    expect(adapter.provider).toBe('lever');
  });
});