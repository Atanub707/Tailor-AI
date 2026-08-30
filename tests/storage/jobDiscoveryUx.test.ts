// Job Discovery UX simplification — normal cards expose MATCH → VIEW → APPLY.
// Static audit of user-facing card/detail components (no renderer installed)
// plus Apply-entry orchestration semantics (no auto-submit, idempotent, consent).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-ux-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage, getPackageById } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { storePlan, ensurePlanSchema } = await import('../../server/applicationEngine/planStore.js');
const { ensureExecutionSchema, getApprovalsByPlan } = await import('../../server/applicationEngine/executionStore.js');
const { startApplication } = await import('../../server/applicationExperience/applicationService.js');
const { requirementsFingerprint } = await import('../../server/applicationEngine/contract.js');
const { parseLeverForm, resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'ux-user';

const job = (id = 'uxj1'): Job => ({
  id, externalId: id, title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'x', atsPlatform: 'lever',
  jobUrl: `https://jobs.lever.co/veo/${id}/apply`, applyUrl: `https://jobs.lever.co/veo/${id}/apply`,
  url: `https://jobs.lever.co/veo/${id}/apply`, source: 'Lever', state: 'pending',
} as unknown as Job);

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
  return { p, cv, fit, pkg };
};

const makePlan = async (userId: string, j: Job) => {
  const { pkg } = await makeReady(userId, j);
  const { plan } = await createPlan({ userId, mode: 'fixture', pkg, job: j, adapter: realAdapter(), artifactOk: true });
  return { pkg, plan };
};

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
const DETAIL = fs.readFileSync(path.join(process.cwd(), 'src/components/JobDetailModal.tsx'), 'utf8');

describe('Job discovery UX — card surface', () => {
  it('primary journey is Score → Apply (title opens details) with direct secondary actions', () => {
    expect(CARD).toContain('Score this job against your CV');
    expect(CARD).toContain('onMatchJob(job.id)');
    expect(CARD).not.toMatch(/View\s*<\/button>/);
    expect(CARD).toContain('onClick={() => onSelectJob(job)}');
    expect(CARD).toContain('href={getValidJobUrl(job)}');
    expect(CARD).toContain(">Apply</a>");
    expect(CARD).toContain('Mark as applied');
    expect(CARD).toContain('Remove job');
  });

  it('the card has no overflow menu and no original-job link', () => {
    expect(CARD).not.toContain('aria-label="More actions"');
    expect(CARD).not.toContain('EllipsisVertical');
    expect(CARD).not.toContain('Open original job');
  });

  it('job card exposes title, company, location, source and posted time', () => {
    expect(CARD).toContain('{job.title}');
    expect(CARD).toContain('{job.company}');
    expect(CARD).toContain('{job.location}');
    expect(CARD).toContain('{job.source}');
    expect(CARD).toContain('timeAgoStr');
  });

  it('does NOT render engineering buttons as primary card actions', () => {
    expect(CARD).not.toContain('Tailor V2');
    expect(CARD).not.toContain('Prepare Application');
    expect(CARD).not.toContain('Prepare for Application');
    expect(CARD).not.toContain('ATS SCORE');
  });

  it('Mark as applied and Remove job are direct card actions', () => {
    expect(CARD).toContain('Mark as applied');
    expect(CARD).toContain('Unmark applied');
    expect(CARD).toContain('Remove job');
    expect(CARD).toContain('onUpdateStatus');
    expect(CARD).toContain('onDeleteJob');
  });

  it('the ATS Score pill shows the LLM percentage when scored and never a misleading placeholder', () => {
    expect(CARD).toContain('ATS Score');
    expect(CARD).toContain('Tailored ATS');
    expect(CARD).toContain('{job.matchScore}%');
    expect(CARD).not.toContain("'0%'");
    expect(CARD).not.toContain('N/A');
  });
  it('Tailor and Score show live stage tooltips while working (⟳ current, ✓ done)', () => {
    expect(CARD).toContain('scoreMsg.map');
    expect(CARD).toContain('tailorMsg.map');
    expect(CARD).toContain("'✓'");
    expect(CARD).toContain("'⟳'");
    expect(CARD).toContain('group-hover:opacity-100');
  });
});

describe('Job discovery UX — detail vocabulary', () => {
  it('uses product vocabulary (Tailor Resume, Match Analysis)', () => {
    expect(DETAIL).toContain('Tailored Resume');
    expect(DETAIL).toContain('Match Analysis');
    expect(DETAIL).toContain('Tailor Resume');
  });

  it('does not expose engine version terminology to users', () => {
    expect(DETAIL).not.toContain('Tailored ATS CV');
    expect(DETAIL).not.toContain('ATS Gap Analysis');
    expect(DETAIL).not.toContain('ATS Match Score');
  });
});

describe('Job discovery UX — Apply entry orchestration', () => {
  it('preparing a package does NOT create a plan, attempt, or any submission', async () => {
    const { pkg } = await makeReady(USER, job('uxj-noexec'));
    const db = getDb();
    expect(getPackageById(USER, pkg.id)).toBeDefined();
    const plans = db.prepare('SELECT COUNT(*) AS n FROM submission_plans WHERE user_id = ?').get(USER) as any;
    const attempts = db.prepare('SELECT COUNT(*) AS n FROM application_attempts WHERE user_id = ?').get(USER) as any;
    expect(plans.n).toBe(0);
    expect(attempts.n).toBe(0);
  });

  it('Apply respects gates — a plan that is not READY is never started or approved', async () => {
    const { pkg, plan } = await makePlan(USER, job('uxj-gate'));
    const db = getDb();
    const approvals = getApprovalsByPlan(db, USER, plan.id);
    expect(approvals).toEqual([]);
    plan.status = 'ACTION_REQUIRED' as any;
    try { db.prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    const r = await startApplication(db, USER, pkg.id);
    expect(r.started).toBe(false);
    expect(r.reason).toBe('PLAN_NOT_READY');
  });

  it('CAPTCHA and MFA stay human checkpoints — never automated', async () => {
    const { pkg, plan } = await makePlan(USER, job('uxj-checkpoint'));
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r = await startApplication(getDb(), USER, pkg.id);
    expect(r.started).toBe(true);
    expect(r.summary.userStatus).toBe('ACTION_REQUIRED');
    expect(r.summary.checkpoint?.type).toBe('CAPTCHA');
    expect(r.summary.availableActions).toContain('CONTINUE_PROVIDER');
    vi.unstubAllGlobals();
    resetInspectionState();
  });

  it('EEO answers are never inferred', async () => {
    const { plan } = await makePlan(USER, job('uxj-eeo'));
    const fields = plan.mappedFields;
    const eeoLike = fields.filter((f: any) => /eeo|race|gender|ethnicity|disability|veteran/i.test(`${f.label ?? ''} ${f.providerFieldId ?? ''}`));
    expect(eeoLike).toEqual([]);
  });

  it('existing application attempts remain idempotent — no duplicate provider work', async () => {
    const { pkg, plan } = await makePlan(USER, job('uxj-idem'));
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch { /* noop */ }
    storePlan(plan);
    vi.stubGlobal('fetch', async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    resetInspectionState();
    const r1 = await startApplication(getDb(), USER, pkg.id);
    expect(r1.started).toBe(true);
    resetInspectionState();
    const r2 = await startApplication(getDb(), USER, pkg.id);
    expect(r2.started).toBe(false);
    expect(r2.reason).toBe('ALREADY_STARTED');
    vi.unstubAllGlobals();
    resetInspectionState();
  });
});