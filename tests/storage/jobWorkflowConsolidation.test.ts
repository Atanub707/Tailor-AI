// Job Workflow Consolidation (v2.4.0) — audit conclusions enforced by tests:
// Score vs Fit are DISTINCT; the single Tailor Resume action routes to Tailor V2;
// Apply orchestrates preparation; no automatic submission primitives exist.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-workflow-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { fitCacheKeyFor } = await import('../../server/fit/fitCache.js');
const { ensureTailorV2Schema, storeTailorVersion, getLatestTailorVersion, listTailorVersions } = await import('../../server/tailorV2/versionStore.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { resumePdfHash } = await import('../../server/applicationPackage/packageEngine.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'wfc-user';

const job = (id = 'wfj1'): Job => ({
  id, externalId: id, title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Kubernetes, AWS, Terraform required.', atsPlatform: 'lever',
  jobUrl: `https://jobs.lever.co/veo/${id}/apply`, applyUrl: `https://jobs.lever.co/veo/${id}/apply`,
  url: `https://jobs.lever.co/veo/${id}/apply`, source: 'Lever', state: 'pending',
} as unknown as Job);

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  return p;
};
const cv = (): MasterCv => ({ fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'B', summary: 'DevOps with Kubernetes', experiences: [], education: [], skills: [{ category: 'skills', items: ['Kubernetes'] }], certifications: [] });

const v2Version = (n: number) => ({
  id: `t-${n}`, userId: USER, jobId: 'wfj1', version: n, masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3, tailorEngineVersion: 1,
  content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] } as any,
  verification: { passed: true, issues: [] },
  stale: false, createdAt: new Date().toISOString(),
});

const APP_TSX = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
const CARD = fs.readFileSync(path.join(process.cwd(), 'src/components/JobMatrix.tsx'), 'utf8');
const DETAIL = fs.readFileSync(path.join(process.cwd(), 'src/components/JobDetailModal.tsx'), 'utf8');
const SERVER = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
const FIT_ENGINE = fs.readFileSync(path.join(process.cwd(), 'server/fit/fitEngine.ts'), 'utf8');

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
};

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureTailorV2Schema();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Score vs Fit — DISTINCT engines', () => {
  it('fit is deterministic profile+CV+JD — no LLM dependency', () => {
    expect(FIT_ENGINE).toContain('export function computeFit');
    expect(FIT_ENGINE).not.toMatch(/import .*llm/i);
    const p = profile();
    expect(fitCacheKeyFor(p.updatedAt, 'cvA', 'jd A').jdHash).not.toBe(fitCacheKeyFor(p.updatedAt, 'cvA', 'jd B').jdHash);
    const r1 = computeFit(p, cv(), job(), 'Kubernetes, AWS, Terraform required.');
    const r2 = computeFit(p, cv(), job(), 'Kubernetes, AWS, Terraform required.');
    expect(r1.score).toBe(r2.score);
    expect(r1.grade).toBe(r2.grade);
    expect(typeof r1.score).toBe('number');
    expect(Array.isArray(r1.strengths)).toBe(true);
    expect(Array.isArray(r1.gaps)).toBe(true);
    expect(Array.isArray(r1.blockers)).toBe(true);
  });

  it('Score is a separate LLM resume↔JD metric — matchScore + gapAnalysis, not fit', () => {
    expect(SERVER).toContain("app.post('/api/jobs/:id/match'");
    expect(SERVER).toContain('matchScore');
    expect(SERVER).toContain('gapAnalysis');
    expect(CARD).not.toContain("'Score'");
    expect(CARD).not.toContain('/match');
    expect(CARD).toContain('/api/jobs/${job.id}/fit');
  });

  it('the job card exposes exactly one metric — Candidate Fit (no Score button)', () => {
    expect(CARD).not.toMatch(/'Score'/);
    expect(CARD).not.toMatch(/>Score</);
    expect(CARD).not.toContain("'Re-Score'");
    expect(CARD).not.toContain('/match');
    expect(CARD).toContain('Check match');
    expect(CARD).toContain('{fit.score}% Match');
  });
});

describe('Tailor — ONE concept routing to Tailor V2', () => {
  it('the normal UI has a single Tailor Resume action, wired to tailor-v2', () => {
    expect(DETAIL).toContain('Tailor Resume');
    expect(DETAIL).not.toContain('Tailor V2');
    expect(CARD).not.toContain('Tailor Resume');
    expect(CARD).not.toContain('Tailor V2');
    expect(CARD).not.toContain('Re-Tailor');
    expect(CARD).not.toContain("'Tailor'");
    expect(APP_TSX).toContain('`/api/jobs/${jobId}/tailor-v2`');
    expect(APP_TSX).not.toContain('`/api/jobs/${jobId}/tailor`');
  });

  it('Tailor V2 fact verification is preserved and versions remain accessible', async () => {
    storeTailorVersion(USER, 'wfj1', v2Version(1).content as any, { passed: true, issues: [] } as any, { masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3 });
    const v = getLatestTailorVersion(USER, 'wfj1');
    expect(v).toBeDefined();
    expect(v!.version).toBe(1);
    expect(v!.verification.passed).toBe(true);
    expect(listTailorVersions(USER, 'wfj1').length).toBe(1);
  });

  it('the Application Package binds the exact verified V2 version deterministically', async () => {
    const p = profile();
    const masterCv = cv();
    const j = job();
    const fit = computeFit(p, masterCv, j, j.description || '');
    const v = getLatestTailorVersion(USER, 'wfj1')!;
    const pkg = await buildPackage({ userId: USER, job: j, jd: j.description || '', profile: p, masterCv, fit, tailoredVersion: v }, 'c');
    expect(pkg.resumeSnapshot?.tailoredResumeVersionId).toBe(v.id);
    expect(pkg.resumeSnapshot?.resumeUserId).toBe(USER);
    expect(resumePdfHash(v, masterCv)).toBe(resumePdfHash(v, masterCv));
  });

  it('the detail tab renders verified V2 output with no fabricated scores', () => {
    expect(DETAIL).toContain('/api/jobs/${job.id}/tailor-v2/latest');
    expect(DETAIL).toContain('Verified against Master CV');
    expect(DETAIL).toContain('/api/jobs/${job.id}/tailor-v2/pdf');
    expect(DETAIL).toContain('No Tailored Resume');
  });
});

describe('Application preparation — orchestrated behind Apply', () => {
  it('job cards expose no preparation controls', () => {
    expect(CARD).not.toContain('Prepare Application');
    expect(CARD).not.toContain('Prepare for Application');
  });

  it('Apply is the single entry point and preparation endpoints remain intact', () => {
    expect(CARD).toMatch(/Apply\s*<\/button>/);
    expect(SERVER).toContain("app.post('/api/jobs/:id/application-package'");
    expect(SERVER).toContain("app.post('/api/application-packages/:packageId/plan'");
  });
});

describe('Apply safety — no automatic submission primitives anywhere', () => {
  it('src/ and browser-extension/ contain zero form.submit/requestSubmit/synthetic submit patterns', () => {
    const dirs = [path.join(process.cwd(), 'src'), path.join(process.cwd(), 'browser-extension')];
    const bad = ['form.submit(', '.requestSubmit(', "new Event('submit'", "new SubmitEvent('submit'", "submit.click()"];
    const hits: string[] = [];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of walk(d)) {
        const text = fs.readFileSync(f, 'utf8');
        for (const b of bad) {
          if (text.includes(b)) hits.push(`${f}: ${b}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('CAPTCHA / OTP handling is human-checkpoint only (no solver endpoints)', () => {
    const g = execSync('grep -rn "solveCaptcha\\|captchaSolver\\|autoOtp\\|consumeOtp" server/ browser-extension/ src/ 2>/dev/null || true').toString();
    expect(g.trim()).toBe('');
  });
});

describe('Delete — direct removal without confirmation', () => {
  it('Remove job deletes immediately — no second confirmation', () => {
    expect(CARD).toContain('Remove job');
    expect(CARD).not.toContain('window.confirm');
  });
});