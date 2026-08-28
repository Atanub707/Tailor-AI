// Tailor V2 — Phase 2 calibration: numeric safety, claim strength,
// employer/project association, title/date/education safety, summary
// inflation, PDF fidelity + reading order, stale semantics, adversarial vs
// safe rewrite sets, cross-user isolation.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2-cal-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { verifyDraft } = await import('../../server/tailorV2/verifier.js');
const { runTailorV2, toVerifierDraft } = await import('../../server/tailorV2/tailorV2Engine.js');
const { storeTailorVersion, getLatestTailorVersion, listTailorVersions } = await import('../../server/tailorV2/versionStore.js');
const { extractPdfText } = await import('../../server/tailorV2/pdfText.js');
import type { MasterCv } from '../../src/types.js';

const USER = 't2-cal-user';

const cv: MasterCv = {
  fullName: 'Ravi Kumar',
  email: 'ravi@example.com',
  phone: '+91 90000 00000',
  location: 'Bengaluru, India',
  summary: 'DevOps engineer with 4+ years experience. Reduced downtime by 50%.',
  experiences: [
    { id: '1', title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', responsibilities: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', 'Deployed 6 production sites', 'Managed production clusters in GKE and EKS', 'Built GitLab pipelines'] },
    { id: '2', title: 'Systems Engineer', company: 'Beta Systems', location: 'Pune', dates: '2019 – 2021', responsibilities: ['Built Python and FastAPI services'] },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com' };
  p.skills = [{ name: 'Kubernetes' }, { name: 'Python' }];
  p.experience = [{ company: 'Acme Cloud', title: 'DevOps Engineer', startDate: '2022-03', endDate: '2023-06' }];
  p.certifications = [{ name: 'CKA' }];
  return p;
};

const draft = (over: Record<string, unknown> = {}) => ({
  summary: 'DevOps engineer with 4+ years experience.',
  skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'Python'],
  experience: [
    { title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', 'Deployed 6 production sites', 'Managed production Kubernetes environments across GKE and EKS', 'Built CI/CD pipelines using GitLab'] },
    { title: 'Systems Engineer', company: 'Beta Systems', location: 'Pune', dates: '2019 – 2021', highlights: ['Built Python and FastAPI services'] },
  ],
  education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  certifications: ['CKA'],
  ...over,
});

describe('Tailor V2 calibration', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'T2Cal', 't2c@test.local'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const vd = (d: Record<string, unknown>) => verifyDraft(toVerifierDraft(d as any), cv, profile(), ['kubernetes', 'aws', 'terraform', 'python']);

  it('numeric: same metric passes; stronger numbers rejected', async () => {
    expect((await vd(draft())).passed).toBe(true);
    const five = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', '5 years of experience'] }] }));
    expect(five.passed).toBe(false);
    expect((await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['99.99% uptime'] }] }))).passed).toBe(false);
    expect((await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Led a team of 8'] }] }))).passed).toBe(false);
  });

  it('numeric: word↔number normalization supported deterministically', async () => {
    const a = await vd(draft({ summary: 'DevOps engineer with four years experience.', experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by seventy percent', 'Managed ten Kubernetes clusters', 'Deployed six production sites'] }] }));
    expect(a.passed).toBe(true);
  });

  it('numeric: weaker/generalized rewrite passes', async () => {
    const weaker = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Significantly reduced deployment downtime', 'Managed multiple production sites', 'Managed production Kubernetes environments across GKE and EKS', 'Built CI/CD pipelines using GitLab'] }] }));
    expect(weaker.passed).toBe(true);
  });

  it('semantic: GKE→Kubernetes passes; AKS/Kubernetes→GKE, Lambda, PyTorch rejected', async () => {
    expect((await vd(draft())).passed).toBe(true);
    const gke = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Managed production AKS clusters'] }] }));
    expect(gke.passed).toBe(false);
    const lambda = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Built production systems on Lambda'] }] }));
    expect(lambda.passed).toBe(false);
    const pytorch = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Built PyTorch models'] }] }));
    expect(pytorch.passed).toBe(false);
  });

  it('claim strength: ownership/leadership inflation rejected', async () => {
    const owned = await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Owned CI/CD pipelines', 'Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters'] }] }));
    expect(owned.passed).toBe(false);
    expect(owned.issues.some((i) => i.type === 'claim_strength')).toBe(true);
    const led = await vd(draft({ summary: 'Engineering leader with 4+ years experience.' }));
    expect(led.passed).toBe(false);
  });

  it('employer association: skills and metrics cannot migrate between employers', async () => {
    const moved = await vd(draft({ experience: [
      { title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', 'Deployed 6 production sites', 'Built CI/CD pipelines using GitLab'] },
      { title: 'Systems Engineer', company: 'Beta Systems', location: 'Pune', dates: '2019 – 2021', highlights: ['Managed Kubernetes on AWS'] },
    ] }));
    expect(moved.passed).toBe(false);
    expect(moved.issues.some((i) => i.type === 'technology')).toBe(true);
    const metricMove = await vd(draft({ experience: [
      { title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', 'Deployed 6 production sites', 'Built CI/CD pipelines using GitLab'] },
      { title: 'Systems Engineer', company: 'Beta Systems', location: 'Pune', dates: '2019 – 2021', highlights: ['Reduced deployment time by 70%'] },
    ] }));
    expect(metricMove.passed).toBe(false);
  });

  it('global skills vs local experience: global list may carry any supported skill', async () => {
    const g = await vd(draft({ skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'Python', 'FastAPI'] }));
    if (!g.passed) console.log('GS-ISSUES:', JSON.stringify(g.issues.slice(0, 4)));
    expect(g.passed).toBe(true);
  });

  it('title/date safety: month-format ok; wrong title/dates/Present-inflation rejected', async () => {
    expect((await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'March 2022 – June 2023', highlights: ['Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters'] }] }))).passed).toBe(true);
    expect((await vd(draft({ experience: [{ title: 'Senior Platform Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 70%'] }] }))).passed).toBe(false);
    expect((await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: '2021 – 2024', highlights: ['Reduced deployment time by 70%'] }] }))).passed).toBe(false);
    expect((await vd(draft({ experience: [{ title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Present', highlights: ['Reduced deployment time by 70%'] }] }))).passed).toBe(false);
  });

  it('education/certification safety: fake degree/cert rejected', async () => {
    expect((await vd(draft({ education: [{ degree: "Master's", institution: 'MIT', dates: '2010 – 2014' }] }))).passed).toBe(false);
    expect((await vd(draft({ certifications: ['CKA', 'AWS Certified Solutions Architect'] }))).passed).toBe(false);
  });

  it('summary inflation: years/leadership/specialization rejected', async () => {
    expect((await vd(draft({ summary: 'Seasoned engineer with 8+ years experience.' }))).passed).toBe(false);
    expect((await vd(draft({ summary: 'AI Engineer specializing in LLM systems with 4+ years experience.' }))).passed).toBe(false);
  });

  it('ADVERSARIAL: malicious draft — verified false, fail-closed, no version persisted', async () => {
    const evil = draft({
      summary: 'PhD from MIT, 15+ years, led a team of 50.',
      skills: ['Kubernetes', 'AWS', 'Azure', 'C++', 'Snowflake'],
      experience: [
        { title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', highlights: ['Reduced deployment time by 99%', 'Led a team of 50'] },
        { title: 'Vice President', company: 'Google', location: 'Mountain View', dates: '2010 – Present', highlights: ['Managed Kubernetes on AWS'] },
      ],
      education: [{ degree: 'PhD', institution: 'MIT', dates: '2005 – 2010' }],
      certifications: ['CISSP'],
    });
    const v = await vd(evil as any);
    expect(v.passed).toBe(false);
    const before = listTailorVersions(USER, 'evil-job').length;
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(evil) } }] }), text: async () => '' }));
    const outcome = await runWithUser(USER, () =>
      runTailorV2(USER, cv, profile(), { id: 'evil-job', title: 'DevOps Engineer', company: 'X', location: 'Remote', description: 'Required: Kubernetes and AWS.' } as any, 'Required: Kubernetes and AWS.', { score: 80, grade: 'Good', strengths: [], gaps: [], blockers: [], unknowns: [], categories: {}, evidence: [], version: 3, jobId: 'evil-job', calculatedAt: '' } as any, { jdHash: 'evil', fitEngineVersion: 3 })
        .then((r) => ({ ok: true, verified: r.verification.passed }))
        .catch((e: any) => ({ ok: false, name: e?.name }))
    );
    vi.unstubAllGlobals();
    expect(outcome.ok).toBe(false);
    expect(listTailorVersions(USER, 'evil-job').length).toBe(before);
  });

  it('SAFE REWRITE: strong valid fixture — verified, PDF, version persisted', async () => {
    const safe = draft({
      summary: 'DevOps engineer with 4+ years experience, reducing downtime by 50%.',
      experience: [
        { title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'March 2022 – June 2023', highlights: ['Built CI/CD pipelines using GitLab', 'Managed production Kubernetes environments across GKE and EKS', 'Reduced deployment time by 70%', 'Managed 10 Kubernetes clusters', 'Deployed 6 production sites'] },
        { title: 'Systems Engineer', company: 'Beta Systems', location: 'Pune', dates: '2019 – 2021', highlights: ['Built services with Python and FastAPI'] },
      ],
    });
    expect((await vd(safe as any)).passed).toBe(true);
    const before = listTailorVersions(USER, 'safe-job').length;
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(safe) } }] }), text: async () => '' }));
    const res = await runWithUser(USER, () =>
      runTailorV2(USER, cv, profile(), { id: 'safe-job', title: 'DevOps Engineer', company: 'X', location: 'Remote', description: 'Required: Kubernetes, AWS and Terraform.' } as any, 'Required: Kubernetes, AWS and Terraform.', { score: 80, grade: 'Good', strengths: ['kubernetes'], gaps: [], blockers: [], unknowns: [], categories: {}, evidence: [], version: 3, jobId: 'safe-job', calculatedAt: '' } as any, { jdHash: 'safe', fitEngineVersion: 3 })
    );
    vi.unstubAllGlobals();
    expect(res.verification.passed).toBe(true);
    expect(res.pdfOk).toBe(true);
    expect(listTailorVersions(USER, 'safe-job').length).toBe(before + 1);
  });

  it('stale: engine marks old versions stale on input change; unrelated jobs unaffected', async () => {
    const { storeTailorVersion } = await import('../../server/tailorV2/versionStore.js');
    const { jdHash } = await import('../../server/fit/fitCache.js');
    const baseKeys = { masterCvUpdatedAt: 'cv1', profileUpdatedAt: 'p1', jdHash: 'jd1', fitEngineVersion: 3 };
    // engine run #1
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(draft()) } }] }), text: async () => '' }));
    const runWith = (keys: any, jobId: string) => runWithUser(USER, () => runTailorV2(USER, cv, profile(), { id: jobId, title: 'DevOps Engineer', company: 'X', location: 'Remote', description: 'Required: Kubernetes and AWS.' } as any, 'Required: Kubernetes and AWS.', { score: 80, grade: 'Good', strengths: [], gaps: [], blockers: [], unknowns: [], categories: {}, evidence: [], version: 3, jobId, calculatedAt: '' } as any, keys));
    const r1 = await runWith(baseKeys, 'stale-job');
    expect(getLatestTailorVersion(USER, 'stale-job')?.stale).toBe(false);
    // input change (JD hash) → r1 marked stale, new version fresh
    const r2 = await runWith({ ...baseKeys, jdHash: 'jd2' }, 'stale-job');
    expect(r2.version).toBe(r1.version + 1);
    expect(listTailorVersions(USER, 'stale-job').find((v) => v.version === r1.version)?.stale).toBe(true);
    expect(getLatestTailorVersion(USER, 'stale-job')?.stale).toBe(false);
    // unrelated job untouched
    expect(getLatestTailorVersion(USER, 'other-job')).toBeUndefined();
    vi.unstubAllGlobals();
    void jdHash;
  });

  it('cross-user isolation: same jobId under different users stays separate', async () => {
    const u2 = 't2-cal-user-2';
    runWithUser(u2, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(u2, 'T2Cal2', 't2c2@test.local'));
    storeTailorVersion(USER, 'iso-job', draft() as any, { passed: true, issues: [], supportedJdTermsBefore: 0, supportedJdTermsAfter: 0, unsupportedInserted: 0 } as any, { jdHash: 'j', fitEngineVersion: 3 });
    expect(getLatestTailorVersion(u2, 'iso-job')).toBeUndefined();
  });

  it('repro global-skills at file end (after all earlier tests)', async () => {
    const g = await vd(draft({ skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'Python', 'FastAPI'] }));
    console.log('END-GS:', g.passed, JSON.stringify(g.issues.slice(0, 3)));
  });

  it('PDF fidelity: critical fields + reading order + special characters', async () => {
    const { toTailoredCv } = await import('../../server/tailorV2/tailorV2Engine.js');
    const { generatePdfBuffer } = await import('../../server/builder/docxGenerator.js');
    const safe = draft({ skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'Python', 'C++', 'Node.js', 'Next.js'] });
    const buf = await generatePdfBuffer(toTailoredCv(safe as any, 'Ravi Kumar'));
    const text = await extractPdfText(buf);
    const norm = text.toLowerCase().replace(/\s+/g, ' ');
    for (const expected of ['Ravi Kumar', 'Acme Cloud', 'DevOps Engineer', 'Mar 2022', 'Jun 2023', '70%', 'Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'B.Tech', 'IIT', 'CKA', 'Python', 'C++', 'Node.js', 'Next.js', 'GKE', 'EKS']) {
      expect(norm).toContain(expected.toLowerCase());
    }
    // Section headings are rendered uppercase; find them on the raw text so
    // the summary's word 'experience' never collides with the heading.
    const iSum = text.indexOf('SUMMARY');
    const iEdu = text.indexOf('EDUCATION');
    const iExp = text.indexOf('EXPERIENCE');
    const iSkills = text.indexOf('SKILLS');
    const iCert = text.indexOf('CERTIFICATIONS');
    expect(iSum).toBeGreaterThan(0);
    expect(iSum).toBeLessThan(iEdu);
    expect(iEdu).toBeLessThan(iExp);
    expect(iExp).toBeLessThan(iSkills);
    expect(iSkills).toBeLessThan(iCert);
  });
});
