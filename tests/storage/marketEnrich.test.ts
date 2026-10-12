// Market-gap AI enrichment ("Enrich Master CV with AI"):
//   - credentials/tenure/titles are filtered out before the LLM sees them;
//   - "supported" verdicts are re-verified against the CV text (deterministic
//     grounding) — ungrounded claims are demoted, never applied;
//   - applying is pure: user-approved gaps only, placed into the CV's own
//     categories, summary rewrite only when explicitly accepted.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-enrich-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const {
  selectGapsForEnrichment,
  groundEnrichItems,
  buildEnrichmentProposal,
  applyEnrichment,
  masterCvEvidenceText,
  aggregateMarketGapsFromJobs,
} = await import('../../server/cv/marketEnrich.js');
import type { EnrichProposal } from '../../server/cv/marketEnrich.js';
import type { MasterCv } from '../../src/types.js';

const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Kolkata, India',
  summary: 'Senior DevSecOps Engineer with 4+ years of experience, cutting exposed vulnerabilities by 80% through pipeline security automation.',
  experiences: [
    {
      id: '1',
      title: 'Senior DevSecOps Engineer',
      company: 'Human Managed',
      location: 'Bengaluru',
      dates: 'Aug 2024 – Present',
      responsibilities: [
        'Moved container builds on GitLab CI/CD to a rootless, non-privileged setup using Kaniko and BuildKit inside Minikube',
        'Hardened Kubernetes and cloud infrastructure with least-privilege IAM and RBAC policies',
      ],
    },
  ],
  education: [{ id: 'e1', degree: 'B.Tech', institution: 'Narula Institute of Technology', dates: '2019 – 2022' }],
  skills: [
    { category: 'Security & Compliance', items: ['Snyk', 'Checkmarx', 'Kubernetes'] },
    { category: 'Languages & Frameworks', items: ['Python', 'Bash'] },
  ],
  certifications: [{ id: 'c1', name: 'Serverless LLM Apps with Amazon Bedrock', issuer: 'DeepLearning.AI' }],
  projects: [{ id: 'p1', name: 'Netflix DevSecOps Pipeline', description: 'CI/CD pipeline with automated security scanning for a Netflix-style demo app', technologies: ['Jenkins'] }],
};

const gaps = [
  { skill: 'linux', count: 56, totalScored: 128 },
  { skill: 'datadog', count: 36, totalScored: 128 },
  { skill: 'kubernetes', count: 30, totalScored: 128 },
  { skill: 'AWS Certified Solutions Architect', count: 8, totalScored: 128 },
  { skill: 'Secrets Manager', count: 6, totalScored: 128 },
];

function stubLlm(draft: any) {
  vi.stubGlobal('fetch', async () => ({
    status: 200,
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }),
    text: async () => '',
  }));
}

describe('market-gap AI enrichment — propose, ground, apply', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('selects gaps for enrichment: drops never-claim facts and already-present skills, ranks by market frequency', () => {
    const evidence = masterCvEvidenceText(cv);
    const selected = selectGapsForEnrichment(gaps, evidence);
    const names = selected.map((g) => g.skill);
    expect(names).toEqual(['linux', 'datadog', 'Secrets Manager']);
    // credential filtered (never claimable), kubernetes filtered (already in CV)
    expect(names).not.toContain('AWS Certified Solutions Architect');
    expect(names).not.toContain('kubernetes');
  });

  it('grounds verdicts deterministically: quoted evidence stays supported, invented basis is demoted', () => {
    const evidence = masterCvEvidenceText(cv);
    const candidates = selectGapsForEnrichment(gaps, evidence);
    const { items } = groundEnrichItems(
      [
        { gap: 'linux', verdict: 'supported', basis: '"Moved container builds on GitLab CI/CD to a rootless, non-privileged setup"', category: 'Security & Compliance' },
        { gap: 'datadog', verdict: 'supported', basis: 'Led a company-wide Datadog APM rollout across 200 microservices for a bank', category: 'Observability' },
        { gap: 'Secrets Manager', verdict: 'adjacent', basis: 'Hardened secrets handling with least-privilege IAM and RBAC policies', category: 'Security & Compliance' },
      ],
      candidates,
      evidence,
      cv.skills.map((s) => s.category)
    );
    const byGap = new Map(items.map((i) => [i.gap, i]));
    expect(byGap.get('linux')!.verdict).toBe('supported');
    expect(byGap.get('linux')!.grounding).toBe(1);
    expect(byGap.get('datadog')!.verdict).not.toBe('supported'); // invented basis demoted
    expect(byGap.get('Secrets Manager')!.verdict).not.toBe('supported');
    // unknown category falls back to Core Competencies
    expect(byGap.get('datadog')!.category).toBe('Core Competencies');
  });

  it('buildEnrichmentProposal: LLM summary rewrites are rejected when they contain numbers the CV never had', async () => {
    stubLlm({
      items: [
        { gap: 'linux', verdict: 'supported', basis: '"Moved container builds on GitLab CI/CD to a rootless, non-privileged setup"', category: 'Security & Compliance' },
      ],
      summaryRewrite: { text: 'DevSecOps engineer keeping services at 99.99% uptime while cutting vulnerabilities by 80% across cloud platforms.', reason: 'Adds uptime.' },
      projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko', basis: 'Container builds via Kaniko in the CV' }],
    });
    const proposal = await buildEnrichmentProposal(cv, gaps);
    // 99.99% is NOT in the CV -> the whole rewrite is rejected (never fabricated)
    expect(proposal.summaryRewrite).toBeNull();
    expect(proposal.items.length).toBeGreaterThan(0);
    expect(proposal.stats.supported).toBe(1);
  });

  it('applyEnrichment: user-approved items only, placed into existing categories, deduped, immutable source', () => {
    const proposal: EnrichProposal = {
      id: 'p-test',
      createdAt: new Date().toISOString(),
      items: [
        { gap: 'linux', count: 56, verdict: 'supported', basis: '', category: 'Security & Compliance', grounding: 1 },
        { gap: 'datadog', count: 36, verdict: 'adjacent', basis: '', category: 'Observability', grounding: 0.4 },
        { gap: 'go', count: 31, verdict: 'unsupported', basis: '', category: 'Core Competencies', grounding: 0 },
      ],
      summaryRewrite: { text: 'Senior DevSecOps Engineer with 4+ years building secure CI/CD platforms.', reason: 'r' },
      projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko', basis: 'b' }],
      stats: { scannedJobs: 128, gapsConsidered: 3, supported: 2, adjacent: 1, unsupported: 0, droppedClaims: 0 },
    };
    const { next, applied } = applyEnrichment(cv, proposal, {
      acceptedGaps: ['linux', 'datadog', 'go', 'ghost-skill'],
      applySummary: true,
      projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko' }],
    });

    expect(applied.skills).toEqual(['linux', 'datadog']); // unsupported + unknown never applied
    expect(next.skills.find((s) => s.category === 'Security & Compliance')!.items).toContain('linux');
    expect(next.skills.find((s) => s.category === 'Observability')).toBeTruthy();
    expect(next.summary).toContain('4+ years building secure CI/CD');
    expect(next.projects![0].technologies).toContain('Kaniko');
    // source CV is untouched (immutability)
    expect(cv.skills.find((s) => s.category === 'Security & Compliance')!.items).not.toContain('linux');
    expect(cv.summary).not.toContain('building secure CI/CD');

    // idempotent: re-applying the same accepted set adds nothing twice
    const second = applyEnrichment(next, proposal, { acceptedGaps: ['linux', 'datadog'], applySummary: true, projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko' }] });
    expect(second.applied.skills).toEqual([]);
    expect(second.applied.projectTags).toBe(0);
    const security = second.next.skills.find((s) => s.category === 'Security & Compliance')!;
    expect(security.items.filter((i) => i === 'linux').length).toBe(1);
  });

  it('aggregateMarketGapsFromJobs counts frequencies across scored jobs only', () => {
    const { gaps: agg, totalScored } = aggregateMarketGapsFromJobs([
      { gapAnalysis: { missingSkills: ['Linux', 'Datadog'], missingKeywords: ['linux'] } },
      { gapAnalysis: { missingSkills: ['Linux'] } },
      { gapAnalysis: { missingSkills: [] } },
      {},
    ] as any[]);
    expect(totalScored).toBe(2);
    expect(agg.find((g) => g.skill === 'linux')!.count).toBe(3);
    expect(agg.find((g) => g.skill === 'datadog')!.count).toBe(1);
  });
});
