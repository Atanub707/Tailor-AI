// Degenerate matcher output must never be stored as truth.
//
// Reported: "click Tailor → not tailoring (+0%)". Root cause found in live
// data: the matcher's LLM response occasionally parsed but lacked matchScore
// AND every keyword list; lenient defaults turned it into a fake
// '50% — nothing missing' verdict → 18 poisoned jobs → every tailor said
// 'Nothing was missing'.
//
// Pins:
//   * half-empty responses are retried once, then REFUSED (LLMError)
//   * isDegenerateGap detects stored poisoned rows
//   * tailorJob re-runs the matcher on a degenerate stored gap (self-heal)
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher-validity-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.TAILOR_ENGINE = 'v1';

const { getDb, runWithUser, saveMasterCv, getJobById } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { LlmMatcher } = await import('../../server/matcher/llmMatcher.js');
const { tailorJob, isDegenerateGap } = await import('../../server/tailor/tailorService.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'matcher-validity-user';
const cv: MasterCv = {
  fullName: 'Atanu Biswas', email: 'a@example.com', phone: '+91 90000 00000', location: 'Kolkata, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [{ id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [],
};

const DEGENERATE_GAP = { matchScore: 50, matchingSkills: [], missingSkills: [], matchedKeywords: [], missingKeywords: [], summaryAnalysis: 'Match score calculated at 50%.' };

const JOB: Job = {
  id: 'mv-1', externalId: '1', title: 'DevOps Engineer', company: 'FitCo', companyId: 'FitCo', location: 'Remote',
  description: 'Required: Kubernetes, AWS, Terraform, Datadog, Prometheus. Must have 5+ years experience.',
  atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1',
  source: 'Greenhouse', state: 'pending',
  gapAnalysis: DEGENERATE_GAP as any,
} as unknown as Job;

const GOOD_MATCH = {
  matchScore: 78,
  matchingSkills: ['Kubernetes', 'AWS'],
  missingSkills: ['Datadog'],
  matchedKeywords: ['CI/CD'],
  missingKeywords: ['Datadog', 'Prometheus'],
  salaryFit: 'matched', experienceFit: 'ideal',
  yearsOfExperience: 7, yearsRequired: 5,
  booleanSearchResult: 'pass',
  keyRecommendations: ['Add Datadog'], summaryAnalysis: 'Solid fit; observability tools missing.',
};

const GOOD_DRAFT = {
  candidateName: 'Atanu Biswas', targetRole: 'DevOps Engineer',
  professionalSummary: 'DevOps engineer with 7+ years experience, Datadog and Prometheus observability across Kubernetes platforms.',
  coreCompetencies: ['Kubernetes', 'AWS', 'Terraform', 'Datadog', 'Prometheus'],
  workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70% with Datadog and Prometheus observability', 'Managed GKE and EKS production clusters'] }],
  education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  technicalSkills: [{ category: 'Infra', skills: ['Kubernetes', 'Datadog'] }],
  inExperience: ['Datadog'], inSkills: [], afterScore: 90, auditNotes: [],
};

function stubQueue(drafts: any[]) {
  let call = 0;
  vi.stubGlobal('fetch', async () => {
    const draft = drafts[Math.min(call, drafts.length - 1)];
    call++;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }), text: async () => '' };
  });
  return () => call;
}

describe('matcher validity — degenerate outputs never become truth', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'MV', 'mv@test.local');
      saveMasterCv(cv, USER);
      saveApplicantProfile(defaultApplicantProfile(), USER);
      getDb().prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run('mv-1', USER, JSON.stringify(JOB));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('a half-empty matcher response is retried and the good answer is used', async () => {
    const calls = stubQueue([{ summaryAnalysis: 'Match score calculated at 50%.' }, GOOD_MATCH]);
    const res = await new LlmMatcher().matchJob(JOB, cv);
    expect(calls()).toBe(2); // degenerate → retry
    expect(res.matchScore).toBe(78);
    expect(res.gapAnalysis.missingSkills).toContain('Datadog');
  });

  it('a persistently degenerate matcher REFUSES instead of storing a fake verdict', async () => {
    stubQueue([{ summaryAnalysis: 'nope' }, { unexpected: true }]);
    await expect(new LlmMatcher().matchJob(JOB, cv)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('isDegenerateGap flags the poisoned signature, not real results', () => {
    expect(isDegenerateGap(DEGENERATE_GAP as any)).toBe(true);
    expect(isDegenerateGap({ matchScore: 50, missingSkills: ['Datadog'], missingKeywords: [], matchingSkills: [], matchedKeywords: [] } as any)).toBe(false);
    expect(isDegenerateGap({ matchScore: 82, missingSkills: [], missingKeywords: [], matchingSkills: ['Kubernetes'], matchedKeywords: [] } as any)).toBe(false);
    expect(isDegenerateGap(undefined)).toBe(false);
  });

  it('SELF-HEAL: tailoring a poisoned job re-runs the matcher and the score moves', async () => {
    const calls = stubQueue([GOOD_MATCH, GOOD_DRAFT]);
    const r = await runWithUser(USER, () => tailorJob(getJobById('mv-1')!));
    expect(calls()).toBe(2); // matcher (healed) + tailor
    const audit = r.tailoredCv.audit!;
    expect(audit.afterScore).toBeGreaterThan(audit.beforeScore); // no more +0%
    expect(audit.addedAfter.keywordsIncorporated).toEqual(expect.arrayContaining(['Datadog']));
    expect(audit.auditNotes.some((n) => n.includes('Nothing was missing'))).toBe(false);
  });
});
