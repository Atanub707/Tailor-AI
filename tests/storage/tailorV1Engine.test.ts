// V1 user-facing engine — the production tailoring engine (product decision
// 2026-09-03). V1 integrates the JD's missing keywords into bullets/skills
// so the score MOVES — that is the entire requirement. V2 remains dormant.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-engine-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.TAILOR_ENGINE = 'v1';

const { getDb, runWithUser, saveMasterCv, getJobById, getMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { tailorJobWithV2 } = await import('../../server/tailorV2/tailorService.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'v1-user';
const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Kolkata, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [
    { id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'] },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform', 'GitLab CI'] }],
  certifications: [{ id: '1', name: 'CKA' }],
  projects: [{ id: 'p1', name: 'K8s Cluster Autoscaler', description: 'Autoscaling for GKE' }],
};

const JD = 'Required: Kubernetes, AWS, Terraform, Python and Prometheus. Must have 5+ years experience.';

function job(): Job {
  return {
    id: 'v1-j1', externalId: '1', title: 'DevOps Engineer', company: 'FitCo', companyId: 'FitCo', location: 'Remote',
    description: JD, atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1',
    source: 'Greenhouse', state: 'pending', matchScore: 50,
    gapAnalysis: { matchScore: 50, missingSkills: ['Python', 'Prometheus'], missingKeywords: [], matchingSkills: ['Kubernetes', 'AWS', 'Terraform'] },
  } as unknown as Job;
}

function stubLlm(draft: any) {
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    void init;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }), text: async () => '' };
  });
}

describe('V1 engine — the production tailoring engine', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V1', 'v1@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(defaultApplicantProfile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('v1-j1', USER, JSON.stringify(job()));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('KEYWORDS ARE ADDED: missing JD keywords land in the resume and the score MOVES', async () => {
    // V1 prompt expects a TailoredCv-shaped JSON with workExperience, technicalSkills, etc.
    stubLlm({
      candidateName: 'Atanu Biswas',
      targetRole: 'DevOps Engineer',
      professionalSummary: 'DevOps engineer with 7+ years building secure pipelines.',
      coreCompetencies: ['Kubernetes', 'AWS', 'Terraform', 'Python', 'Prometheus'],
      workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Built CI/CD with Python automation and monitored with Prometheus', 'Reduced deployment time by 70%', 'Managed GKE and EKS'] }],
      education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
      technicalSkills: [{ category: 'Languages', skills: ['Python'] }],
      certifications: [],
      projects: [],
      inExperience: ['Python', 'Prometheus'],
      inSkills: [],
      afterScore: 72,
      auditNotes: ['Integrated Python and Prometheus from the JD'],
    });
    const r = await runWithUser(USER, () => tailorJobWithV2(getJobById('v1-j1')!, { userId: USER }));
    expect(r.tailoredCv.audit?.addedAfter?.keywordsIncorporated ?? []).toContain('Python');
    expect(r.tailoredCv.audit?.afterScore ?? 0).toBeGreaterThan(r.tailoredCv.audit?.beforeScore ?? 0);
    const text = JSON.stringify(r.tailoredCv).toLowerCase();
    expect(text).toContain('python');
    expect(text).toContain('prometheus');
    // informative audit fields attached for the UI
    expect((r.tailoredCv.audit as any)?.bulletDiffs?.length).toBeGreaterThan(0);
    expect((r.tailoredCv.audit as any)?.keywordStatus?.some((k: any) => k.kind === 'added_experience')).toBe(true);
  });
});