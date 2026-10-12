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

describe('V1 engine — recruiter-first quality (order, skills priority, metric preservation)', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V1Impact', 'v1impact@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(defaultApplicantProfile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('v1-impact-1', USER, JSON.stringify(job()));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('reorders bullets so the most JD-relevant real bullet is first, keeping diff pairing exact', async () => {
    stubLlmQueue([impactDraft(SOURCE_ORDER_REWRITES)]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));
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
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));
    // Docker is not in the JD -> sinks to the end; JD-named tools lead.
    expect(r.tailoredCv.coreCompetencies[0]).toBe('Kubernetes');
    expect(r.tailoredCv.coreCompetencies[r.tailoredCv.coreCompetencies.length - 1]).toBe('Docker');
    const cloud = r.tailoredCv.technicalSkills.find((g: any) => g.category === 'Cloud')!;
    expect(cloud.skills[cloud.skills.length - 1]).toBe('Docker');
  });

  it('reports the honest impact audit (quantified bullets, no dropped metrics)', async () => {
    stubLlmQueue([impactDraft(SOURCE_ORDER_REWRITES)]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));
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
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));

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
    const r = await runWithUser(USER, () => tailorJob(getJobById('v1-impact-1')!, { userId: USER }));

    expect(r.tailoredCv.audit!.impactAudit!.metricDropped).toEqual(['70%']);
    expect(r.tailoredCv.audit!.auditNotes.some((n) => n.includes('did not keep these real numbers (70%)'))).toBe(true);
  });
});
