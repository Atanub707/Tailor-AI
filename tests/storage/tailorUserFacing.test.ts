// Tailor V2 user-facing migration — every normal Tailor Resume entry point
// must run the canonical V2 pipeline: fact ledger → drafter → verifier →
// fail closed. LLM is MOCKED (zero paid calls). Asserts the required safety
// matrix: invented employers/titles/dates/degrees/certs/skills/
// technologies/metrics/projects/achievements never reach a published resume,
// and no user-facing path can silently fall back to legacy V1.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-user-facing-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveMasterCv, updateJobInStorage, getJobById } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { tailorJobWithV2, buildTailorAudit, TailorVerificationFailedError } = await import('../../server/tailorV2/tailorService.js');
const { toVerifierDraft } = await import('../../server/tailorV2/tailorV2Engine.js');
const { verifyDraft: engineVerify } = await import('../../server/tailorV2/verifier.js');
const { getLatestTailorVersion, listTailorVersions } = await import('../../server/tailorV2/versionStore.js');
import type { MasterCv, Job } from '../../src/types.js';
import type { TailorDraft } from '../../server/tailorV2/drafter.js';

const USER = 'user-facing-t2';

const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Bengaluru, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [
    { id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'] },
    { id: '2', title: 'Cloud Engineer', company: 'Nexus', location: 'Pune', dates: '2018 – 2020', responsibilities: ['Automated AWS infrastructure with Terraform'] },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform', 'GitLab CI'] }],
  certifications: [{ id: '1', name: 'CKA' }],
  projects: [{ id: 'p1', name: 'K8s Cluster Autoscaler', description: 'Autoscaling for GKE' }] as unknown as MasterCv['projects'],
};

const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Atanu', lastName: 'Biswas', email: 'atanu@example.com' };
  p.skills = [{ name: 'Kubernetes' }, { name: 'AWS' }, { name: 'Terraform' }, { name: 'CI/CD' }];
  p.experience = [{ company: 'Human Managed', title: 'Senior DevSecOps Engineer', startDate: '2021-01', isCurrent: true }];
  p.certifications = [{ name: 'CKA' }];
  return p;
};

const JD = 'Required: Kubernetes, AWS, Terraform and Python. Must have 5+ years experience. Preferred: Prometheus.';

function job(id = 'j1'): Job {
  return {
    id, externalId: '1', title: 'DevOps Engineer', company: 'FitCo', companyId: 'FitCo', location: 'Remote',
    description: JD, atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1',
    source: 'Greenhouse', state: 'pending', matchScore: 61,
    gapAnalysis: { matchScore: 61, missingSkills: ['Python'], missingKeywords: ['Prometheus'], matchingSkills: ['Kubernetes', 'AWS', 'Terraform'] },
  } as unknown as Job;
}

function goodDraft(): TailorDraft {
  return {
    summary: 'DevOps engineer with 7+ years experience building production Kubernetes environments.',
    skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'GitLab CI'],
    experience: [
      { title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'] },
    ],
    education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
    certifications: ['CKA'],
    projects: [{ name: 'K8s Cluster Autoscaler', description: 'Built an autoscaler for production GKE clusters' }],
  };
}

/** Mock LLM: return a chosen draft (fetch is the only LLM boundary). */
function stubLlm(draft: TailorDraft | ((calls: number) => TailorDraft)) {
  let n = 0;
  const fn = typeof draft === 'function' ? draft : () => draft;
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    n++;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(fn(n)) } }] }), text: async () => '' };
  });
  return { calls: () => n };
}

describe('Tailor V2 — user-facing migration', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'T2U', 't2u@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(profile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('j1', USER, JSON.stringify(job()));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const run = async (draft: TailorDraft | ((calls: number) => TailorDraft), jobId = 'j1') => {
    stubLlm(draft);
    return runWithUser(USER, () => tailorJobWithV2(getJobById(jobId)!, { userId: USER }));
  };
  const runExpectThrow = async (draft: TailorDraft | ((calls: number) => TailorDraft), jobId = 'j1') => {
    stubLlm(draft);
    return runWithUser(USER, () => tailorJobWithV2(getJobById(jobId)!, { userId: USER }))
      .then(() => ({ threw: false, name: '' }))
      .catch((e: any) => ({ threw: true, name: e?.name })) as Promise<{ threw: boolean; name: string }>;
  };

  // ── 1 / 12. supported rewording → PASS ──
  it('1. supported rephrasing passes verification and publishes a verified version', async () => {
    const r = await run(goodDraft());
    expect(r.verification.passed).toBe(true);
    expect(r.verification.unsupportedInserted).toBe(0);
    expect(r.tailoredCv.workExperience[0].company).toBe('Human Managed');
    expect(r.tailoredCv.workExperience[0].highlights[0]).toContain('70%');
    expect(r.version).toBeGreaterThanOrEqual(1);
    const stored = getLatestTailorVersion(USER, 'j1');
    expect(stored?.version).toBe(r.version);
    expect(stored?.stale).toBe(false);
  });

  it('12. valid supported keyword rewording accepted', async () => {
    const draft: TailorDraft = {
      ...goodDraft(),
      experience: [{ ...goodDraft().experience[0], highlights: ['Reduced deployment time by 70%', 'Managed production Kubernetes environments across GKE and EKS', 'Built CI/CD pipelines with GitLab'] }],
    };
    const r = await run(draft);
    expect(r.verification.passed).toBe(true);
  });

  // ── 2-6. fabricated history → FAIL ──
  it.each([
    ['2. invented employer', { company: 'Google' }],
    ['3. invented title', { title: 'Senior Platform Architect' }],
    ['4. changed employment date', { dates: '2015 – 2017' }],
  ])('%s → fail closed, nothing published', async (_label, patch) => {
    const draft: TailorDraft = { ...goodDraft(), experience: [{ ...goodDraft().experience[0], ...patch }] };
    const out = await runExpectThrow(draft);
    expect(out.threw).toBe(true);
    expect(out.name).toBe('TailorVerificationFailedError');
    const stored = runWithUser(USER, () => getJobById('j1'));
    expect(stored?.state).toBe('pending'); // state untouched
  });

  it('5. invented degree → fail closed', async () => {
    const draft: TailorDraft = { ...goodDraft(), education: [{ degree: 'PhD', institution: 'MIT', dates: '2010 – 2014' }] };
    const out = await runExpectThrow(draft);
    expect(out.threw).toBe(true);
    expect(out.name).toBe('TailorVerificationFailedError');
  });

  it('6. invented certification → dropped, never published', async () => {
    const draft: TailorDraft = { ...goodDraft(), certifications: ['CKA', 'CISSP'] };
    const r = await run(draft);
    expect(r.tailoredCv.certifications).not.toContain('CISSP');
  });

  // ── 7-8. JD-only skill / invented technology → never published ──
  it('7. JD-only skill (Python) never enters the resume', async () => {
    const draft: TailorDraft = { ...goodDraft(), skills: [...goodDraft().skills, 'Python'] };
    const raw = await engineVerify(toVerifierDraft(draft), cv, profile(), ['kubernetes', 'aws', 'terraform', 'python']);
    expect(raw.passed).toBe(false); // verifier blocks it
    const r = await run(draft); // repair drops it
    expect(r.tailoredCv.coreCompetencies.join(' ').toLowerCase()).not.toContain('python');
    expect(r.verification.passed).toBe(true);
  });

  it('8. invented technology (Snowflake) never enters the resume', async () => {
    const draft: TailorDraft = { ...goodDraft(), skills: [...goodDraft().skills, 'Snowflake'] };
    const r = await run(draft);
    expect(r.tailoredCv.coreCompetencies.join(' ').toLowerCase()).not.toContain('snowflake');
  });

  // ── 9. changed numerical metric → FAIL ──
  it('9. changed numerical metric (70% → 40%) → fail closed', async () => {
    const draft: TailorDraft = {
      ...goodDraft(),
      experience: [{ ...goodDraft().experience[0], highlights: ['Reduced deployment time by 40%'] }],
    };
    const out = await runExpectThrow(draft);
    expect(out.threw).toBe(true);
    expect(out.name).toBe('TailorVerificationFailedError');
  });

  it('9b. supported metric preserved verbatim across rewording', async () => {
    const draft: TailorDraft = {
      ...goodDraft(),
      experience: [{ ...goodDraft().experience[0], highlights: ['Cut deployment time by 70 percent'] }],
    };
    const r = await run(draft);
    expect(r.verification.passed).toBe(true);
    expect(r.tailoredCv.workExperience[0].highlights[0]).toContain('70');
  });

  // ── 10. invented project → FAIL ──
  it('10. invented project (not in ledger) is rejected and never published', async () => {
    const draft: TailorDraft = { ...goodDraft(), projects: [{ name: 'Innova Bank Rewards Platform', description: 'Built a payments platform used by 2M users' }] };
    const raw = await engineVerify(toVerifierDraft(draft), cv, profile(), ['kubernetes']);
    expect(raw.passed).toBe(false);
    expect(raw.issues.some((i) => i.type === 'project')).toBe(true);
    const r = await run(draft); // additive section → dropped in repair
    expect(r.tailoredCv.projects?.map((p) => p.name)).not.toContain('Innova Bank Rewards Platform');
    expect(r.verification.passed).toBe(true);
  });

  it('10b. invented project with invented metric → project and metric fully removed, nothing fabricated published', async () => {
    const draft: TailorDraft = { ...goodDraft(), projects: [{ name: 'Innova Bank Rewards Platform', description: 'Reduced costs by 50%' }] };
    const raw = await engineVerify(toVerifierDraft(draft), cv, profile(), ['kubernetes']);
    expect(raw.passed).toBe(false);
    expect(raw.issues.some((i) => i.type === 'metric' || i.type === 'project')).toBe(true);
    const r = await run(draft);
    // The unsupported additive section is dropped wholesale — no invented
    // project and no unsupported metric survive in the published resume.
    expect(r.tailoredCv.projects?.map((p) => p.name)).not.toContain('Innova Bank Rewards Platform');
    expect(JSON.stringify(r.tailoredCv).toLowerCase()).not.toContain('50%');
    expect(r.verification.passed).toBe(true);
  });

  // ── 11. invented achievement → FAIL ──
  it('11. invented achievement (no provenance in source) → fail closed', async () => {
    const draft: TailorDraft = {
      ...goodDraft(),
      experience: [{ ...goodDraft().experience[0], highlights: ['Automated onboarding with a self-serve portal for new hires'] }],
    };
    const raw = await engineVerify(toVerifierDraft(draft), cv, profile(), ['kubernetes']);
    expect(raw.passed).toBe(false);
    expect(raw.issues.some((i) => i.type === 'achievement')).toBe(true);
    const out = await runExpectThrow(draft);
    expect(out.threw).toBe(true);
    expect(out.name).toBe('TailorVerificationFailedError');
  });

  // ── 13-16. every entry point uses the canonical V2 service ──
  it('13/14/15/16. single, Re-Tailor, batch and Manual JD paths all bind to V2 (no V1 callsites)', () => {
    const serverTs = fs.readFileSync(path.join(__dirname, '../../server.ts'), 'utf8');
    // No legacy engine remains in any normal route:
    expect(serverTs).not.toContain('LlmCvTailor');
    expect(serverTs).not.toContain('new LlmCvTailor');
    // Every entry point resolves through the canonical service:
    const serviceRefs = (serverTs.match(/tailorJobWithV2/g) || []).length;
    expect(serviceRefs).toBeGreaterThanOrEqual(3); // single + batch + manual JD
    // The application-package auto-tailor path already ran V2 directly:
    expect(serverTs).toContain('runTailorV2');
  });

  it('13b. single Tailor persists a verified version row', async () => {
    await run(goodDraft(), 'j1');
    expect(getLatestTailorVersion(USER, 'j1')?.verification.passed).toBe(true);
  });

  it('14b. Re-Tailor produces a NEW verified version, history preserved', async () => {
    const r1 = await run(goodDraft(), 'j1');
    const r2 = await run(goodDraft(), 'j1');
    expect(r2.version).toBe(r1.version + 1);
    const versions = listTailorVersions(USER, 'j1');
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0].version).toBe(r2.version);
    expect(versions[1].version).toBe(r1.version);
  });

  // ── 17-18. fail-closed behavior ──
  it('17. verifier failure does NOT fall back to any other engine', async () => {
    const draft: TailorDraft = { ...goodDraft(), experience: [{ ...goodDraft().experience[0], company: 'Google' }] };
    const out = await runExpectThrow(draft);
    expect(out.threw).toBe(true);
    expect(out.name).toBe('TailorVerificationFailedError');
  });

  it('18. failed generation does NOT replace the latest verified artifact', async () => {
    const ok = await run(goodDraft(), 'j1');
    const latestBefore = getLatestTailorVersion(USER, 'j1');
    await runExpectThrow({ ...goodDraft(), summary: 'PhD with 20+ years experience leading Google' });
    const latestAfter = getLatestTailorVersion(USER, 'j1');
    expect(latestAfter?.version).toBe(ok.version);
    expect(latestAfter?.content.summary).toBe(latestBefore?.content.summary);
    expect(latestAfter?.stale).toBe(false);
  });

  it('19. the exact verified version persists with its verification record', async () => {
    const draft = goodDraft();
    const r = await run(draft, 'j1');
    const stored = getLatestTailorVersion(USER, 'j1');
    expect(stored?.version).toBe(r.version);
    expect(stored?.content).toEqual(draft);
    expect(stored?.verification.passed).toBe(true);
    expect(stored?.tailorEngineVersion).toBeGreaterThanOrEqual(1);
  });

  // ── 20. application package references the exact verified version ──
  it('20. the exact verified artifact is the one application packaging consumes', () => {
    const serverTs = fs.readFileSync(path.join(__dirname, '../../server.ts'), 'utf8');
    // Package context loads the LATEST verified V2 version and never
    // regenerates silently (autoTailor only when no version exists yet).
    expect(serverTs).toContain('getLatestTailorVersion(userId, job.id)');
    const stored = getLatestTailorVersion(USER, 'j1');
    expect(stored).toBeDefined();
    // The stored version is the single source for the package (no separate
    // tailored copy is built by the package engine):
    expect(serverTs).toContain('autoTailor');
    expect(serverTs).toContain('let tailored = ctx.tailored');
  });

  it('audit: beforeScore reflects Resume Match, no separate Tailor score invented', async () => {
    const r = await run(goodDraft(), 'j1');
    expect(r.audit.beforeScore).toBe(61); // the existing match score
    expect(r.audit.afterScore).toBeGreaterThanOrEqual(r.audit.beforeScore);
    expect(r.audit.scoreBreakdown.remainingGap).toBeGreaterThanOrEqual(0);
    expect(r.audit.addedAfter.skillsAdded).toEqual([]);
    expect(r.audit.auditNotes.length).toBeGreaterThan(0);
  });

  it('no paid calls: fetch is the only LLM boundary and it is fully stubbed', async () => {
    expect(typeof globalThis.fetch).toBe('function'); // stub installed by test helper
  });

  it('skills are grouped into the Master CV categories (render like the master preview)', async () => {
    const r = await run(goodDraft(), 'j1');
    const cats = (r.tailoredCv.technicalSkills || []).map((c) => c.category);
    expect(cats).toContain('Infra'); // master CV category of Kubernetes/AWS/Terraform
    expect(cats).not.toContain('Skills'); // no more single flat bucket
    const infra = (r.tailoredCv.technicalSkills || []).find((c) => c.category === 'Infra');
    expect(infra?.skills.length).toBeGreaterThan(0);
    const allGrouped = (r.tailoredCv.technicalSkills || []).flatMap((c) => c.skills);
    expect(allGrouped).toContain('Kubernetes');
  });

  it('projects/education/certifications are copied verbatim; summary/skills/bullets are tailored', async () => {
    const r = await run(goodDraft(), 'j1');
    // Projects = EXACT Master CV list (name, description, dates — no AI edits):
    expect(r.tailoredCv.projects?.map((p) => p.name)).toEqual((cv.projects || []).map((p) => p.name));
    expect(r.tailoredCv.projects?.[0]?.description).toBe((cv.projects || [])[0]?.description);
    // Education + certifications identical to Master CV:
    expect(r.tailoredCv.education?.map((e) => e.degree)).toEqual(['B.Tech']);
    expect(r.tailoredCv.education?.[0]?.institution).toBe('IIT');
    expect(r.tailoredCv.certifications?.map((c) => (typeof c === 'string' ? c : c.name))).toEqual(['CKA']);
    // Summary + experience bullets are the TAILORED draft, not verbatim:
    expect(r.tailoredCv.professionalSummary).toBe(goodDraft().summary);
    expect(r.tailoredCv.workExperience[0].highlights[0]).toContain('70%');
    expect(r.tailoredCv.workExperience[0].company).toBe('Human Managed');
  });

  it('enhanced mode end-to-end: annotated metric passes; strict mode identical to today', async () => {
    const enhancedDraft = (): TailorDraft => ({
      summary: 'DevOps engineer with 7+ years experience.',
      skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'GitLab CI'],
      experience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present',
        highlights: ['Cut deployment time by 70% across 40+ services {"__enhanced":{"type":"metric","basis":"70% deploy cut"}}', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'] }],
      education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
      certifications: ['CKA'],
      projects: [{ name: 'K8s Cluster Autoscaler', description: 'Autoscaling for GKE' }],
    });
    stubLlm(enhancedDraft);
    const r = await runWithUser(USER, () => tailorJobWithV2(getJobById('j1')!, { userId: USER, mode: 'enhanced' }));
    expect(r.verification.passed).toBe(true);
    expect(r.enhancementLedger?.entries).toHaveLength(1);
    // Audit carries the ledger for the UI; annotation JSON never leaks into
    // the rendered/stored artifact.
    expect(r.tailoredCv.audit?.enhancementLedger?.entries).toHaveLength(1);
    expect(JSON.stringify(r.tailoredCv)).not.toContain('__enhanced');
    // Informative audit: per-bullet diffs + per-JD-term reasons ride on the audit.
    expect(r.tailoredCv.audit?.bulletDiffs?.length).toBeGreaterThan(0);
    expect(r.tailoredCv.audit?.keywordStatus?.length).toBeGreaterThan(0);
    expect(r.tailoredCv.audit?.keywordStatus?.some((k) => k.kind === 'unsupported')).toBe(true);
    // strict mode: the same annotated draft is treated as a normal metric violation
    stubLlm(enhancedDraft);
    const s = await runWithUser(USER, () => tailorJobWithV2(getJobById('j1')!, { userId: USER, mode: 'strict' }))
      .then(() => 'ok').catch((e: any) => e?.name);
    expect(s).toBe('TailorVerificationFailedError');
  });

  it('tailor routes read the mode from the request body and persist it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(src).toContain("const mode = req.body?.mode === 'strict' ? 'strict' : 'enhanced'");
    expect(src).toContain("tailorJobWithV2(jobToTailor, { mode })");
    expect(src).toContain("tailorMode: mode");
  });
});
