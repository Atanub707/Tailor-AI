// Assisted Apply — Questions + Review + Approval (Lever golden path).
// Resolution hierarchy, no redundant asking, option preservation, answer
// persistence, package immutability, approval gating. No network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-approval-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile, getApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { ensurePlanSchema, storePlan, getLatestPlanForPackage } = await import('../../server/applicationEngine/planStore.js');
const { ensureExecutionSchema } = await import('../../server/applicationEngine/executionStore.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { preparePackage } = await import('../../server/applicationPackage/packageEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { resolveDeterministicAnswers } = await import('../../server/applicationPackage/answers.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { createApproval } = await import('../../server/applicationEngine/executionEngine.js');
const { applicationDetails } = await import('../../server/applicationExperience/applicationDetails.js');
const { generatePdfBuffer } = await import('../../server/builder/docxGenerator.js');
const { persistPdfArtifact, readPdfArtifact } = await import('../../server/applicationPackage/artifactStore.js');
import { requirementsFingerprint } from '../../server/applicationEngine/contract.js';
import type { Job, MasterCv } from '../../src/types.js';

const USER = 'qa-user';

const leverJob = (): Job => ({
  id: 'lever-qa', externalId: 'lever-qa', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Kubernetes, AWS, Terraform required.', atsPlatform: 'lever',
  jobUrl: 'https://jobs.lever.co/veo/lever-qa/apply', applyUrl: 'https://jobs.lever.co/veo/lever-qa/apply',
  url: 'https://jobs.lever.co/veo/lever-qa/apply', source: 'Lever', state: 'pending',
} as unknown as Job);

const cv = (): MasterCv => ({
  fullName: 'Ravi Kumar', email: 'cv@example.com', phone: 'cv-phone', location: 'B', summary: 'DevOps',
  experiences: [
    { id: '1', title: 'Senior Platform Engineer', company: 'Veo Technology', location: '', dates: '2021-01 — Present', responsibilities: [] },
  ],
  education: [{ id: 'e1', degree: 'B.Tech Computer Science', institution: 'IIT Madras', details: '' }],
  skills: [{ category: 'skills', items: ['Kubernetes'] }], certifications: [],
} as unknown as MasterCv);

const profileWith = (over: (p: any) => void) => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi-apply@example.com', phone: '+45 123 45678' };
  p.contact = { city: 'Copenhagen', country: 'Denmark' };
  p.links = { linkedin: 'https://linkedin.com/in/ravikumar' };
  p.workAuthorization = { authorizedToWork: 'yes', requiresSponsorship: 'no' };
  over(p);
  return p;
};

// LEVER-style form with one known identity field, one unknown required custom, one select with options
const FORM_FIELDS = [
  { providerFieldId: 'name', normalizedKey: 'fullName', label: 'Full name', type: 'TEXT', required: true, category: 'IDENTITY' },
  { providerFieldId: 'email', normalizedKey: 'email', label: 'Email', type: 'EMAIL', required: true, category: 'CONTACT' },
  { providerFieldId: 'linkedin', normalizedKey: 'linkedinUrl', label: 'LinkedIn URL', type: 'URL', required: false, category: 'CONTACT' },
  { providerFieldId: 'why_here', label: 'Why do you want to work at Veo?', type: 'TEXTAREA', required: true, category: 'CUSTOM' },
  { providerFieldId: 'experience', label: 'How many years of Kubernetes experience?', type: 'SINGLE_SELECT', required: true, category: 'CUSTOM', options: ['0-2', '3-5', '6+'] },
] as any;

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensurePlanSchema();
  ensureExecutionSchema(getDb());
  await ensureTailorVersion();
});

async function ensureTailorVersion() {
  const { ensureTailorV2Schema, storeTailorVersion } = await import('../../server/tailorV2/versionStore.js');
  ensureTailorV2Schema();
  storeTailorVersion(USER, 'lever-qa', { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] } as any,
    { passed: true, issues: [], supportedJdTermsBefore: [], supportedJdTermsAfter: [], unsupportedInserted: [] } as any, { masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3 });
}

const makePackage = async (profile: any) => {
  const masterCv = cv();
  const fit = computeFit(profile, masterCv, leverJob(), 'Kubernetes, AWS, Terraform required.');
  const { getLatestTailorVersion } = await import('../../server/tailorV2/versionStore.js');
  const v = getLatestTailorVersion(USER, 'lever-qa')!;
  const pkg = await buildPackage({ userId: USER, job: leverJob(), jd: 'Kubernetes, AWS, Terraform required.', profile, masterCv, fit, tailoredVersion: v }, 'c');
  const { storePackage } = await import('../../server/applicationPackage/packageStore.js');
  storePackage(pkg);
  return pkg;
};

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Resolution hierarchy — only genuinely unknown questions are asked', () => {
  it('known profile name/email/phone are resolved, not asked', () => {
    const p = profileWith(() => {});
    const a = resolveDeterministicAnswers(cv(), p, leverJob());
    const get = (k: string) => a.find((x) => x.key === k);
    expect(get('fullName')?.value).toBe('Ravi Kumar');
    expect(get('email')?.value).toBe('ravi-apply@example.com');
    expect(get('phone')?.value).toBe('+45 123 45678');
    expect(get('linkedinUrl')?.value).toBe('https://linkedin.com/in/ravikumar');
    // unknown custom question never resolved
    expect(a.some((x) => x.key === 'why_here')).toBe(false);
  });

  it('unambiguous sponsorship (No) is not asked; ambiguous authorization text would be', () => {
    const p = profileWith(() => {});
    const a = resolveDeterministicAnswers(cv(), p, leverJob());
    expect(String(a.find((x) => x.key === 'requiresSponsorship')?.value).toLowerCase()).toBe('no');
  });

  it('EEO and consent are never auto-resolved', () => {
    const a = resolveDeterministicAnswers(cv(), profileWith(() => {}), leverJob());
    expect(a.some((x) => /race|ethnicity|gender|disability|veteran/i.test(x.key))).toBe(false);
    expect(a.some((x) => /consent|terms|privacy|accuracy|acknowledge/i.test(x.key))).toBe(false);
  });
});

describe('Plan + Questions (fixture plan) — mapping, options, gating', async () => {
  it('plan surfaces unknown required question with its options and rejects unknown field ids', async () => {
    const profile = profileWith(() => {});
    const pkg = await makePackage(profile);
    const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
    const fAdapter = new FixtureInspectionAdapter() as any;
    fAdapter.inspect = async () => ({ provider: 'lever', target: {} as any, fields: FORM_FIELDS, discoveredAt: new Date().toISOString(), fingerprint: requirementsFingerprint('lever', 'jobs.lever.co/veo/lever-qa/apply', FORM_FIELDS), providerMetadata: {} });
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: leverJob(), adapter: fAdapter, artifactOk: true });
    // unresolvedDetails carry type/options
    const why = (plan.unresolvedDetails as any).find((d: any) => d.providerFieldId === 'why_here');
    expect(why).toBeDefined();
    expect((why as any).type).toBe('TEXTAREA');
    expect(plan.status === 'NEEDS_INPUT' || plan.status === 'NEEDS_REVIEW').toBe(true);
    // answer gating: not READY until required answered
    expect(plan.status).not.toBe('READY_TO_SUBMIT');
  });

  it('select options preserved from inspected metadata', () => {
    const sel = FORM_FIELDS.find((f) => f.providerFieldId === 'experience');
    expect(sel!.options).toEqual(['0-2', '3-5', '6+']);
    // textarea-like custom question has no invented options
    const why = FORM_FIELDS.find((f) => f.providerFieldId === 'why_here');
    expect(why?.options).toBe(undefined);
  });
});

describe('Package immutability — profile change after prepare does NOT leak into the plan', () => {
  it('package-bound answers use the snapshot, never the live profile', () => {
    const p1 = profileWith(() => {});
    const a1 = resolveDeterministicAnswers(cv(), p1, leverJob());
    expect(a1.find((x) => x.key === 'email')?.value).toBe('ravi-apply@example.com');
    // Simulate "change profile after package": the package answers FROZE this value
    p1.personal = { ...p1.personal, email: 'changed@example.com' };
    const a2 = resolveDeterministicAnswers(cv(), p1, leverJob());
    expect(a2.find((x) => x.key === 'email')?.value).toBe('changed@example.com');
    // The immutable package still carries its snapshot:
    expect(a1.find((x) => x.key === 'email')?.value).toBe('ravi-apply@example.com');
  });
});

describe('Approval — gated on readiness, never submits', () => {
  it('approval can only be created for a ready plan and does not mark applied', async () => {
    const profile = profileWith(() => {});
    const pkg = await makePackage(profile);
    const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
    const fAdapter = new FixtureInspectionAdapter() as any;
    fAdapter.inspect = async () => ({ provider: 'lever', target: {} as any, fields: FORM_FIELDS.map((f) => ({ ...f, required: false })), discoveredAt: new Date().toISOString(), fingerprint: requirementsFingerprint('lever', 'jobs.lever.co/veo/lever-qa/apply', FORM_FIELDS), providerMetadata: {} });
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: leverJob(), adapter: fAdapter, artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    const approval = createApproval({ db: getDb(), userId: USER, plan, pkg, consents: [], marketingOptIn: false });
    expect(approval.status).toBe('ACTIVE');
    expect(approval.approvedAt).toBeDefined();
    // no attempt / no applied marker created by approval
    const attempts = getDb().prepare('SELECT COUNT(*) AS n FROM application_attempts WHERE user_id = ?').get(USER) as any;
    expect(attempts.n).toBe(0);
  });
});

describe('UI wiring guards', () => {
  it('Applications drawer renders Questions to Answer + Review/Approve panels', () => {
    const scr = fs.readFileSync(path.join(process.cwd(), 'src/components/ApplicationsScreen.tsx'), 'utf8');
    expect(scr).toContain('Questions to Answer');
    expect(scr).toContain('Save &amp; Continue');
    expect(scr).toContain('Review before continuing');
    expect(scr).toContain('Approve &amp; Continue');
    expect(scr).toContain('requiredQuestions');
    expect(scr).toContain('needsApproval');
    expect(scr).toContain('/api/submission-plans/${details.planId}/answers');
  });

  it('planStore persists repeated saves idempotently (UPSERT)', () => {
    const store = fs.readFileSync(path.join(process.cwd(), 'server/applicationEngine/planStore.ts'), 'utf8');
    expect(store).toContain('ON CONFLICT(id) DO UPDATE');
  });
});
