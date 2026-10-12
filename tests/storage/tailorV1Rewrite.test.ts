// V1 engine — REWRITE enforcement. Regression tests for the reported bug:
// "before Tailor 45%, after Tailor 97%, but the tailored resume is identical
// to the master CV." Root causes pinned by the audit:
//   1. The LLM can echo the master bullets verbatim — nothing requires or
//      verifies a rewrite, so "tailoring" never happens.
//   2. The old matcher stripped ALL non-alphanumerics ("C++" -> "c"), so any
//      keyword was "verified" and the score inflated with zero real work.
//   3. Gap analysis could flag keywords already present in the CV (e.g. the
//      LLM listed "CI/CD" as missing while the CV says "CI/CD pipeline").
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-rewrite-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.TAILOR_ENGINE = 'v1';

const { getDb, runWithUser, saveMasterCv, getJobById, getMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { tailorJob } = await import('../../server/tailor/tailorService.js');
const { containsKeyword } = await import('../../server/tailor/keywordMatch.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'v1-rewrite-user';
const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Kolkata, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [
    { id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters'] },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
  projects: [],
};

const JD = 'Required: Kubernetes, AWS, Terraform, Python, Prometheus and C++. Must have 5+ years experience.';

function job(): Job {
  return {
    id: 'v1-rw1', externalId: '1', title: 'DevOps Engineer', company: 'FitCo', companyId: 'FitCo', location: 'Remote',
    description: JD, atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1',
    source: 'Greenhouse', state: 'pending', matchScore: 45,
    gapAnalysis: { matchScore: 45, missingSkills: ['Python', 'Prometheus'], missingKeywords: ['C++'], matchingSkills: ['Kubernetes', 'AWS', 'Terraform'] },
  } as unknown as Job;
}

function stubLlm(draft: any) {
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    void init;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }), text: async () => '' };
  });
}

function verbatimDraft(): any {
  return {
    candidateName: 'Atanu Biswas',
    targetRole: 'Senior DevSecOps Engineer',
    professionalSummary: 'DevOps engineer with 7+ years experience.',
    coreCompetencies: ['Kubernetes', 'AWS', 'Terraform'],
    workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters'] }],
    education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
    technicalSkills: [{ category: 'Languages', skills: [] }],
    inExperience: ['C++', 'Python', 'Prometheus'],
    inSkills: [],
    afterScore: 97,
    auditNotes: [],
  };
}

describe('V1 engine — tailoring must actually tailor', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V1RW', 'v1rw@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(defaultApplicantProfile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('v1-rw1', USER, JSON.stringify(job()));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('honest matcher: C++ is NOT present in plain text, CI/CD is present in "CI/CD pipeline"', () => {
    expect(containsKeyword('Built pipelines in Python and Go', 'C++')).toBe(false);
    expect(containsKeyword('Programmed in C++', 'C++')).toBe(true);
    expect(containsKeyword('Managed the CI/CD pipeline', 'CI/CD')).toBe(true);
    expect(containsKeyword('Managed the pipeline', 'CI/CD')).toBe(false);
    expect(containsKeyword('I use go', 'Go')).toBe(true);
    expect(containsKeyword('Google Cloud is fine', 'Go')).toBe(false);
  });

  it('FAILS CLOSED when the LLM echoes the master bullets verbatim (no rewrite, no keyword added)', async () => {
    stubLlm(verbatimDraft());
    await expect(runWithUser(USER, () => tailorJob(getJobById('v1-rw1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] })))
      .rejects.toMatchObject({ name: 'TailorVerificationFailedError' });
  });

  it('score only moves when genuinely-missing keywords are genuinely integrated', async () => {
    stubLlm({
      ...verbatimDraft(),
      workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70% with Python automation and Prometheus alerting', 'Managed GKE and EKS production clusters'] }],
      inExperience: ['Python', 'Prometheus'],
      inSkills: [],
      technicalSkills: [{ category: 'Languages', skills: [] }],
    });
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-rw1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));
    const audit = r.tailoredCv.audit!;
    // Python + Prometheus genuinely woven in -> score moves; C++ NOT added.
    expect(audit.afterScore).toBeGreaterThan(audit.beforeScore);
    expect(audit.addedAfter.keywordsIncorporated).toEqual(expect.arrayContaining(['Python', 'Prometheus']));
    expect(audit.addedAfter.keywordsIncorporated).not.toContain('C++');
    expect(audit.notIntegrable).toContain('C++');
    // The tailored bullets actually changed and contain the keywords.
    expect(r.tailoredCv.workExperience[0].highlights[0]).not.toBe('Reduced deployment time by 70%');
    expect(r.tailoredCv.workExperience[0].highlights[0].toLowerCase()).toContain('python');
    // keywordStatus is honest: added_experience for the woven ones.
    const added = audit.keywordStatus?.filter((k: any) => k.kind === 'added_experience').map((k: any) => k.term);
    expect(added).toEqual(expect.arrayContaining(['Python', 'Prometheus']));
  });

  it('keyword woven into the SUMMARY is credited and moves the score', async () => {
    stubLlm({
      ...verbatimDraft(),
      professionalSummary: 'DevOps engineer with 7+ years experience building C++ tooling for CI/CD automation.',
      workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70% with Prometheus alerting', 'Managed GKE and EKS production clusters'] }],
      inExperience: ['Prometheus'],
      inSummary: ['C++'],
      inSkills: [],
      technicalSkills: [{ category: 'Languages', skills: [] }],
    });
    // C++ is woven into the SUMMARY -> it must be consented for that to be
    // credited (a named tech the user explicitly selected).
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-rw1')!, { userId: USER, includeSkills: ['Python', 'Prometheus', 'C++'] }));
    const audit = r.tailoredCv.audit!;
    expect(audit.afterScore).toBeGreaterThan(audit.beforeScore);
    expect(audit.addedAfter.keywordsInSummary).toContain('C++');
    expect(audit.addedAfter.keywordsInExperience).toContain('Prometheus');
    expect(audit.notIntegrable).toEqual(expect.arrayContaining(['Python']));
    // summary was actually rewritten and carries the keyword
    expect(r.tailoredCv.professionalSummary).toContain('C++');
    expect(r.tailoredCv.professionalSummary).not.toBe('DevOps engineer with 7+ years experience.');
    const summaryHit = audit.keywordStatus?.find((k: any) => k.term === 'C++');
    expect(summaryHit?.kind).toBe('added_experience');
  });

  it('keyword already present in the master CV is NOT counted as missing or newly integrated', async () => {
    const master = runWithUser(USER, () => getMasterCv()) as MasterCv;
    expect(JSON.stringify(master).toLowerCase()).toContain('kubernetes');
    expect(containsKeyword(JSON.stringify(master), 'Kubernetes')).toBe(true);
    expect(containsKeyword(JSON.stringify(master), 'Prometheus')).toBe(false);
  });
});