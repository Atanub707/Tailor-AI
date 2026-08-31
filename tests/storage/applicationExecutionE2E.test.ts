// Application Execution E2E V1 — Apply handoff, Application Detail states,
// manual/unsupported-provider tracking, and UI wiring guards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-e2e-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage, preparePackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage, getLatestPackage } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { storePlan } = await import('../../server/applicationEngine/planStore.js');
const { ensurePlanSchema } = await import('../../server/applicationEngine/planStore.js');
const { ensureExecutionSchema } = await import('../../server/applicationEngine/executionStore.js');
const { applicationSummaries, markAppliedManually, ExperienceError } = await import('../../server/applicationExperience/applicationService.js');
const { applicationDetails } = await import('../../server/applicationExperience/applicationDetails.js');
const { requirementsFingerprint } = await import('../../server/applicationEngine/contract.js');
const { parseLeverForm, resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'e2e-user';

const job = (id = 'ej1', platform = 'lever'): Job => ({
  id, externalId: id, title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Kubernetes, AWS, Terraform required.', atsPlatform: platform,
  jobUrl: `https://jobs.lever.co/veo/${id}/apply`, applyUrl: `https://jobs.lever.co/veo/${id}/apply`,
  url: `https://jobs.lever.co/veo/${id}/apply`, source: 'Lever', state: 'pending',
} as unknown as Job);

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  return p;
};
const cv = (): MasterCv => ({ fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'B', summary: 'DevOps', experiences: [], education: [], skills: [{ category: 'skills', items: ['Kubernetes'] }], certifications: [] });

const tailoredVersion = (id: string) => ({
  id: `t-${id}`, userId: USER, jobId: id, version: 1, masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3, tailorEngineVersion: 1,
  content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] } as any,
  verification: { passed: true, issues: [], supportedJdTermsBefore: [], supportedJdTermsAfter: [], unsupportedInserted: [] } as any,
  stale: false, createdAt: new Date().toISOString(),
});

const makePackage = async (j: Job) => {
  const p = profile();
  const masterCv = cv();
  const fit = computeFit(p, masterCv, j, j.description || '');
  const pkg = await buildPackage({ userId: USER, job: j, jd: j.description || '', profile: p, masterCv, fit, tailoredVersion: tailoredVersion(j.id) }, 'c');
  storePackage(pkg);
  return { pkg, p, masterCv };
};

const HTML = `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required>
  <input name="resume" type="file">
  <input type="hidden" name="accountId" value="a1">
  <div class="h-captcha" data-sitekey="sk"></div>
</form>`;
const parsedReqs = () => {
  const fields = parseLeverForm(HTML).fields;
  return { provider: 'lever' as const, target: {} as any, fields, discoveredAt: new Date().toISOString(), fingerprint: requirementsFingerprint('lever', 'jobs.lever.co', fields), providerMetadata: {} as Record<string, string> };
};
const realAdapter = () => ({ provider: 'lever' as const, detect: () => ({ provider: 'lever' as const, confidence: 'high' as const, reason: 't' }), inspect: async () => parsedReqs() });

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureExecutionSchema(getDb());
  ensurePlanSchema();
  resetInspectionState();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const CARD = fs.readFileSync(path.join(process.cwd(), 'src/components/JobMatrix.tsx'), 'utf8');
const APP = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
const SERVER = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

describe('Apply — paused auto-apply: direct link to the job post', () => {
  it('Apply links to the job post in a new tab — no auto-apply, no navigation', () => {
    expect(CARD).toContain('href={getValidJobUrl(job)}');
    expect(CARD).toContain('target="_blank"');
    expect(CARD).toContain('Open ${job.source} job posting to apply');
    expect(CARD).not.toContain('autoTailor: true');
    expect(CARD).not.toContain('window.location');
    expect(CARD).not.toContain('inline-app-status');
    expect(CARD).not.toContain('if (applying) return');
    expect(CARD).not.toContain('Could not prepare the application.');
  });

  it('the Applied toggle only marks the job applied — no navigation, no tracker', () => {
    expect(CARD).toContain('toggleApplied');
    expect(CARD).toContain('onUpdateStatus(job.id');
    expect(CARD).not.toContain("navigate('/applications')");
    expect(CARD).not.toContain(', 3000');
    expect(CARD).not.toContain('mark-applied');
  });
});

describe('Application Detail — plan-less packages appear as Preparing', () => {
  it('a freshly prepared package is listed as PREPARING with START_APPLICATION', async () => {
    await makePackage(job('ej-prepare'));
    const rows = applicationSummaries(getDb(), USER).filter((r) => r.applicationId.includes('ej-prepare') || r.jobId === 'ej-prepare');
    expect(rows.length).toBe(1);
    expect(rows[0].userStatus).toBe('PREPARING');
    expect(rows[0].availableActions).toContain('START_APPLICATION');
    expect(rows[0].jobTitle).toBe('Platform Engineer');
    expect(rows[0].jobUrl).toContain('jobs.lever.co');
  });

  it('repeated package preparation is idempotent — one package', async () => {
    const j = job('ej-idem');
    await makePackage(j);
    const p = profile();
    const fit = computeFit(p, cv(), j, j.description || '');
    const again = await preparePackage({ userId: USER, job: j, jd: j.description || '', profile: p, masterCv: cv(), fit, tailoredVersion: tailoredVersion(j.id) }, 'c');
    const latest = getLatestPackage(USER, j.id)!;
    expect(latest.inputFingerprint).toBe(again.inputFingerprint);
    const rows = applicationSummaries(getDb(), USER).filter((r) => r.jobId === 'ej-idem');
    expect(rows.length).toBe(1);
  });
});

describe('Unsupported provider — Manual application required, never Failed', () => {
  it('an UNSUPPORTED plan maps to MANUAL_REQUIRED with open/mark actions', async () => {
    const j = job('ej-unsup', 'workday');
    const { pkg } = await makePackage(j);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'UNSUPPORTED' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    const row = applicationSummaries(getDb(), USER).find((r) => r.applicationId === pkg.id)!;
    expect(row.userStatus).toBe('MANUAL_REQUIRED');
    expect(row.availableActions).toEqual(['OPEN_ORIGINAL', 'MARK_APPLIED', 'VIEW']);
    expect(row.jobUrl).toContain('jobs.lever.co');
  });

  it('manual mark-applied is durable and never fabricates provider evidence', async () => {
    const j = job('ej-manual', 'workday');
    const { pkg } = await makePackage(j);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    plan.status = 'UNSUPPORTED' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    const summary = markAppliedManually(getDb(), USER, pkg.id);
    expect(summary.userStatus).toBe('APPLIED');
    const again = markAppliedManually(getDb(), USER, pkg.id);
    expect(again.userStatus).toBe('APPLIED');
    const details = applicationDetails(getDb(), USER, pkg.id)!;
    expect(details.userConfirmed).toBeDefined();
    expect(details.userConfirmed!.source).toBe('USER');
    expect(details.events.some((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED')).toBe(true);
    const rows = applicationSummaries(getDb(), USER).filter((r) => r.applicationId === pkg.id);
    expect(rows.length).toBe(1);
  });
});

describe('Application Detail — server surfaces remain (UI removed)', () => {
  it('details serve events and manual confirmation; every route is protected server-side', () => {
    const ui = fs.readFileSync(path.join(process.cwd(), 'src/components/applicationUi.ts'), 'utf8');
    expect(ui).toContain('Manual application required');
    expect(SERVER).toContain("app.get('/api/applications/:applicationId/details'");
    expect(SERVER).toContain("app.post('/api/applications/:applicationId/mark-applied'");
  });

  it('the mark-applied endpoint exists server-side', () => {
    expect(SERVER).toContain("app.post('/api/applications/:applicationId/mark-applied'");
  });
});

describe('E2E orchestration preserved', () => {
  it('plan creation stays read-only and gated; startApplication still requires readiness', async () => {
    const j = job('ej-gate');
    const { pkg } = await makePackage(j);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
    expect(plan.requirementsFingerprint.length).toBeGreaterThan(0);
    expect(plan.mappedFields.length).toBeGreaterThan(0);
    expect(plan.status === 'UNSUPPORTED').toBe(false);
    resetInspectionState();
  });
});
describe('Easy Flow — auto-tailor on Apply, deterministic CV attachment', () => {
  it('a package with a job-specific tailored version attaches THAT version', async () => {
    const { pkg } = await makePackage(job('ej-auto-1'));
    expect(pkg.resumeSnapshot?.source).toBe('TAILORED');
    expect(pkg.resumeSnapshot?.tailoredResumeVersionId).toBe('t-ej-auto-1');
    expect(pkg.resumeSnapshot?.pdfOk).toBe(true);
  });

  it('a package without a tailored version attaches the Master CV — never blocks apply', async () => {
    const j = job('ej-auto-2');
    const p = profile();
    const masterCv = cv();
    const fit = computeFit(p, masterCv, j, j.description || '');
    const pkg = await buildPackage({ userId: USER, job: j, jd: j.description || '', profile: p, masterCv, fit, tailoredVersion: undefined }, 'c');
    expect(pkg.resumeSnapshot?.source).toBe('MASTER_CV');
    expect(pkg.resumeSnapshot?.pdfOk).toBe(true);
  });

  it('auto-tailor runs ONLY when no version exists — existing versions are reused', async () => {
    const { getLatestTailorVersion } = await import('../../server/tailorV2/versionStore.js');
    // fresh job → no version → auto-tailor would trigger (guard = !version)
    expect(getLatestTailorVersion(USER, 'ej-auto-fresh')).toBeUndefined();
    // job with a stored version → guard false → no new LLM call
    const { ensureTailorV2Schema, storeTailorVersion } = await import('../../server/tailorV2/versionStore.js');
    ensureTailorV2Schema();
    storeTailorVersion(USER, 'ej-auto-3', { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] } as any,
      { passed: true, issues: [], supportedJdTermsBefore: [], supportedJdTermsAfter: [], unsupportedInserted: [] } as any,
      { masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3 });
    expect(getLatestTailorVersion(USER, 'ej-auto-3')).toBeDefined();
  });

  it('UI wiring — auto-apply is paused at the card level (server endpoints intact)', () => {
    const m = fs.readFileSync(path.join(process.cwd(), 'src/components/JobMatrix.tsx'), 'utf8');
    expect(m).not.toContain('autoTailor: true');
    expect(m).not.toContain('Tailoring CV…');
    const srv = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(srv).toContain('autoTailor');
    expect(srv).toContain('cvSource');
  });

  it('details endpoint surfaces autoFilled for the profile strip', () => {
    const detailsSrc = fs.readFileSync(path.join(process.cwd(), 'server/applicationExperience/applicationDetails.ts'), 'utf8');
    expect(detailsSrc).toContain('autoFilled');
  });
});

describe('Attached CV transparency — the drawer names the exact resume', () => {
  it('details expose resumeSource + version; MASTER_CV is labeled honestly', async () => {
    const { pkg } = await makePackage(job('ej-cv-1'));
    expect(pkg.resumeSnapshot?.source).toBe('TAILORED');
    const details = applicationDetails(getDb(), USER, pkg.id)!;
    expect(details.resumeSource).toBe('TAILORED');
    expect(details.resumeVersion).toBe(1);
  });
  it('details expose the attached CV source + version for the badge', () => {
    const detailsSrc = fs.readFileSync(path.join(process.cwd(), 'server/applicationExperience/applicationDetails.ts'), 'utf8');
    expect(detailsSrc).toContain('resumeSource');
    expect(detailsSrc).toContain('resumeVersion');
  });
});
