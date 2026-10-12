// V1 engine — recruiter-first quality pass (2026-10 resume feedback):
//   1. Bullets are REORDERED deterministically so the most JD-relevant real
//      bullet comes first (recruiters scan 2-3 bullets in ~7 seconds) —
//      order changes, wording never; the before→after diff pairing survives.
//   2. Skills are prioritized: JD-named tools float to the front (stable).
//   3. Real metrics are NEVER dropped by a rewrite: dropped numbers trigger
//      one corrective retry and, if still missing, are surfaced honestly in
//      audit.impactAudit.metricDropped (never fabricated, never silent).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-impact-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.TAILOR_ENGINE = 'v1';

const { getDb, runWithUser, saveMasterCv, getJobById } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { tailorJob } = await import('../../server/tailor/tailorService.js');
const { isUnsupportedClaim, isNamedTechTerm } = await import('../../server/builder/llmCvTailor.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'v1-impact-user';

const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Kolkata, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [
    {
      id: '1',
      title: 'Senior DevSecOps Engineer',
      company: 'Human Managed',
      location: 'Bengaluru',
      dates: 'Jan 2021 – Present',
      responsibilities: [
        'Reduced deployment time by 70%',
        'Managed GKE and EKS production clusters',
        'Mentored 4 junior engineers',
      ],
    },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
  projects: [],
};

const JD = 'Required: Kubernetes, AWS, Terraform, Python, Prometheus and CI/CD. Must have 5+ years experience.';

function job(): Job {
  return {
    id: 'v1-impact-1', externalId: '1', title: 'DevOps Engineer', company: 'FitCo', companyId: 'FitCo', location: 'Remote',
    description: JD, atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1',
    source: 'Greenhouse', state: 'pending', matchScore: 45,
    gapAnalysis: { matchScore: 45, missingSkills: ['Python', 'Prometheus'], missingKeywords: ['CI/CD'], matchingSkills: ['Kubernetes', 'AWS', 'Terraform'] },
  } as unknown as Job;
}

/** Deterministic draft: real numbers preserved unless a test says otherwise. */
function impactDraft(highlights: string[], summaryOverride?: string): any {
  return {
    candidateName: 'Atanu Biswas',
    targetRole: 'Senior DevSecOps Engineer',
    professionalSummary: summaryOverride ?? 'DevSecOps engineer (7+ years) with CI/CD automation depth; reduced deployment time by 70% and operated Kubernetes at scale.',
    coreCompetencies: ['Docker', 'Kubernetes', 'AWS', 'Terraform', 'Python', 'Prometheus'],
    workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights }],
    education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
    technicalSkills: [{ category: 'Cloud', skills: ['Docker', 'Terraform', 'Kubernetes'] }],
    inExperience: [], inSkills: [], afterScore: 80, auditNotes: [],
  };
}

function stubLlmQueue(drafts: any[], onPrompt?: (body: string) => void): () => number {
  let call = 0;
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    onPrompt?.(String(init?.body || ''));
    const draft = drafts[Math.min(call, drafts.length - 1)];
    call++;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }), text: async () => '' };
  });
  return () => call;
}

// Rewrites in the LLM's contract order: rewritten[i] ↔ source bullets[i].
// The Kubernetes bullet (source index 1) must be REORDERED to the top by the
// engine — not by the stub.
const SOURCE_ORDER_REWRITES = [
  'Reduced deployment time by 70% through pipeline automation',
  'Operated Kubernetes and EKS production clusters',
  'Mentored 4 junior engineers',
];

function job2(): Job {
  return {
    id: 'v1-impact-2', externalId: '2', title: 'Cloud Security Engineer', company: 'StrictCo', companyId: 'StrictCo', location: 'Remote',
    description: JD, atsPlatform: 'greenhouse', jobUrl: 'https://x/2', applyUrl: 'https://x/2', url: 'https://x/2',
    source: 'Greenhouse', state: 'pending', matchScore: 45,
    gapAnalysis: { matchScore: 45, missingSkills: ['AWS Certified Solutions Architect', 'Python'], missingKeywords: ['CI/CD'], matchingSkills: ['Kubernetes', 'AWS', 'Terraform'] },
  } as unknown as Job;
}

const LEAKY_DRAFT = {
  ...impactDraft(SOURCE_ORDER_REWRITES, 'DevSecOps engineer with 6+ years of experience and CI/CD automation depth.'),
  technicalSkills: [
    { category: 'Certifications & Training', skills: ['AWS Certified Solutions Architect', 'Certified Kubernetes Administrator (CKA)'] },
    { category: 'Cloud', skills: ['Docker', 'Terraform', 'Kubernetes'] },
  ],
};

const CLEAN_DRAFT = {
  ...impactDraft(SOURCE_ORDER_REWRITES, 'DevSecOps engineer with 7+ years of experience and CI/CD automation depth.'),
  technicalSkills: [{ category: 'Cloud', skills: ['Docker', 'Terraform', 'Kubernetes'] }],
};

describe('V1 engine — recruiter-first quality (order, skills priority, metric preservation)', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V1Impact', 'v1impact@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(defaultApplicantProfile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('v1-impact-1', USER, JSON.stringify(job()));
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('v1-impact-2', USER, JSON.stringify(job2()));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('reorders bullets so the most JD-relevant real bullet is first, keeping diff pairing exact', async () => {
    stubLlmQueue([impactDraft(SOURCE_ORDER_REWRITES)]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));
    const highlights = r.tailoredCv.workExperience[0].highlights;

    // Kubernetes bullet (source index 1 -> 'Managed GKE and EKS...') is now first.
    expect(highlights[0]).toContain('Kubernetes');
    expect(highlights[1]).toContain('70%');
    expect(highlights[2]).toContain('Mentored');

    // Diff pairing survived the permutation: every diff pairs the SAME bullet
    // (original ↔ rewritten), not a neighbour.
    const diffs = r.tailoredCv.audit!.bulletDiffs!;
    const kube = diffs.find((d) => d.rewritten.includes('Kubernetes'))!;
    expect(kube.original).toContain('Managed GKE and EKS');
    const metric = diffs.find((d) => d.rewritten.includes('70%'))!;
    expect(metric.original).toContain('Reduced deployment time by 70%');
    const mentor = diffs.find((d) => d.rewritten.includes('Mentored'))!;
    expect(mentor.original).toContain('Mentored 4 junior engineers');

    // Ordering changed for the RIGHT reason: relevance to this JD.
    expect(r.tailoredCv.audit!.bulletDiffs!.length).toBe(3);
  });

  it('prioritizes JD-named skills first (stable) in competencies and grouped skills', async () => {
    stubLlmQueue([impactDraft(SOURCE_ORDER_REWRITES)]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));
    // Docker is not in the JD -> sinks to the end; JD-named tools lead.
    expect(r.tailoredCv.coreCompetencies[0]).toBe('Kubernetes');
    expect(r.tailoredCv.coreCompetencies[r.tailoredCv.coreCompetencies.length - 1]).toBe('Docker');
    const cloud = r.tailoredCv.technicalSkills.find((g: any) => g.category === 'Cloud')!;
    expect(cloud.skills[cloud.skills.length - 1]).toBe('Docker');
  });

  it('reports the honest impact audit (quantified bullets, no dropped metrics)', async () => {
    stubLlmQueue([impactDraft(SOURCE_ORDER_REWRITES)]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));
    const impact = r.tailoredCv.audit!.impactAudit!;
    expect(impact.bullets).toBe(3);
    expect(impact.quantified).toBe(2); // '70%' and '4 junior engineers'
    expect(impact.quantifiedPct).toBe(67);
    expect(impact.metricDropped).toEqual([]);
    expect(r.tailoredCv.audit!.auditNotes.some((n) => n.includes('2 of 3 experience bullets (67%)'))).toBe(true);
  });

  it('retries once when the rewrite DROPS a real number, and accepts when restored', async () => {
    const prompts: string[] = [];
    const droppedMetricDraft = impactDraft(
      [
        'Automated release pipelines with Python and Prometheus alerting',
        'Mentored 4 junior engineers',
        'Operated Kubernetes clusters with zero-downtime releases',
      ],
      'DevSecOps engineer (7+ years) with CI/CD automation depth and Python/Prometheus tooling.'
    );
    const restored = impactDraft(
      [
        'Reduced deployment time by 70% with Python automation and Prometheus alerting',
        'Mentored 4 junior engineers',
        'Operated Kubernetes clusters with zero-downtime releases',
      ],
      'DevSecOps engineer (7+ years) with CI/CD automation depth and Python/Prometheus tooling.'
    );
    const calls = stubLlmQueue([droppedMetricDraft, restored], (body) => prompts.push(body));
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));

    expect(calls()).toBe(2);
    expect(prompts[1]).toContain('DROPPED these real numbers');
    expect(prompts[1]).toContain('70%');
    expect(r.tailoredCv.audit!.impactAudit!.metricDropped).toEqual([]);
    expect(r.tailoredCv.workExperience[0].highlights.join(' ')).toContain('70%');
  });

  it('flags dropped metrics honestly when the retry still loses them (no fabrication, no silence)', async () => {
    const droppedMetricDraft = impactDraft(
      [
        'Automated release pipelines with Python and Prometheus alerting',
        'Mentored 4 junior engineers',
        'Operated Kubernetes clusters with zero-downtime releases',
      ],
      'DevSecOps engineer (7+ years) with CI/CD automation depth and Python/Prometheus tooling.'
    );
    stubLlmQueue([droppedMetricDraft, droppedMetricDraft]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER, includeSkills: ['Python', 'Prometheus'] }));

    expect(r.tailoredCv.audit!.impactAudit!.metricDropped).toEqual(['70%']);
    expect(r.tailoredCv.audit!.auditNotes.some((n) => n.includes('did not keep these real numbers (70%)'))).toBe(true);
  });

  it('INTEGRITY: never plants credentials/tenure — retries, cleans the output, and reports them as gaps', async () => {
    const prompts: string[] = [];
    const calls = stubLlmQueue([LEAKY_DRAFT, CLEAN_DRAFT], (body) => prompts.push(body));
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-2')!, { userId: USER, includeSkills: ['Python'] }));
    const cvOut = r.tailoredCv;

    expect(calls()).toBe(2);
    expect(prompts[1]).toContain('CLAIMED facts the candidate');

    // No fabricated credential survives anywhere on the claim surface
    // (audit gap lists are allowed to NAME the unheld credential).
    const claimSurface = [
      cvOut.professionalSummary,
      ...cvOut.coreCompetencies,
      ...(cvOut.technicalSkills || []).flatMap((g: any) => [g.category, ...(g.skills || [])]),
      ...cvOut.workExperience.flatMap((w: any) => w.highlights || []),
    ].join(' \n ');
    expect(claimSurface).not.toMatch(/Certified|Certifications/i);
    expect(cvOut.professionalSummary).not.toContain('6+ years');

    // The unheld credential is an honest gap, visible in the audit.
    expect(r.tailoredCv.audit!.notIntegrable).toContain('AWS Certified Solutions Architect');
    expect(r.tailoredCv.audit!.addedAfter.keywordsIncorporated).not.toContain('AWS Certified Solutions Architect');

    // Real keyword work still happened.
    expect(r.tailoredCv.audit!.addedAfter.keywordsIncorporated).toContain('Python');
  });

  it('INTEGRITY: fails closed (nothing published) when the LLM keeps claiming unheld credentials', async () => {
    stubLlmQueue([LEAKY_DRAFT, LEAKY_DRAFT]);
    await expect(runWithUser(USER, () => tailorJob(getJobById('v1-impact-2')!, { userId: USER, includeSkills: ['Python'] })))
      .rejects.toMatchObject({ name: 'TailorVerificationFailedError' });
  });

  it('CONSENT GATE: named tools not explicitly selected (Python/Prometheus) stay honest gaps in auto paths', async () => {
    const cleanDraft = {
      ...impactDraft(SOURCE_ORDER_REWRITES, 'DevSecOps engineer with 7+ years of experience and CI/CD automation depth.'),
      coreCompetencies: ['Docker', 'Kubernetes', 'AWS', 'Terraform'],
      technicalSkills: [{ category: 'Cloud', skills: ['Docker', 'Terraform', 'Kubernetes'] }],
    };
    stubLlmQueue([cleanDraft]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));
    const audit = r.tailoredCv.audit!;

    // Generic wording (CI/CD) is integrated automatically…
    expect(audit.addedAfter.keywordsIncorporated).toContain('CI/CD');
    // …but named tools the user never selected stay gaps, never claims.
    expect(audit.addedAfter.keywordsIncorporated).not.toContain('Python');
    expect(audit.addedAfter.keywordsIncorporated).not.toContain('Prometheus');
    expect(audit.notIntegrable).toEqual(expect.arrayContaining(['Python', 'Prometheus']));
    const claimSurface = [
      r.tailoredCv.professionalSummary,
      ...r.tailoredCv.coreCompetencies,
      ...(r.tailoredCv.technicalSkills || []).flatMap((g: any) => [g.category, ...(g.skills || [])]),
      ...r.tailoredCv.workExperience.flatMap((w: any) => w.highlights || []),
    ].join(' \n ');
    expect(claimSurface).not.toContain('Python');
    expect(claimSurface).not.toContain('Prometheus');
  });

  it('CLASSIFIERS: credentials/titles are never-claim; "Secrets Manager" is a consentable product, not a title', () => {
    // Never-claim (facts the user must own): credentials, tenure, role titles.
    expect(isUnsupportedClaim('AWS Certified Solutions Architect')).toBe(true);
    expect(isUnsupportedClaim('Certified Kubernetes Administrator (CKA)')).toBe(true);
    expect(isUnsupportedClaim('AZ-104')).toBe(true);
    expect(isUnsupportedClaim('6+ years experience')).toBe(true);
    expect(isUnsupportedClaim('Senior DevOps Engineer')).toBe(true);
    expect(isUnsupportedClaim('Site Reliability Engineer')).toBe(true);
    expect(isUnsupportedClaim('Project Manager')).toBe(true);
    // Products ending in "-manager" are named tech (consentable), NOT titles.
    expect(isUnsupportedClaim('AWS Secrets Manager')).toBe(false);
    expect(isNamedTechTerm('AWS Secrets Manager')).toBe(true);
    // Generic capability wording auto-weaves; named tech needs consent.
    expect(isNamedTechTerm('incident readiness')).toBe(false);
    expect(isNamedTechTerm('change management')).toBe(false);
    expect(isNamedTechTerm('Linux')).toBe(true);
    expect(isNamedTechTerm('Go')).toBe(true);
  });
});
