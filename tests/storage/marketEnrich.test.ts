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
    expect(byGap.get('Linux')!.verdict).toBe('supported');
    expect(byGap.get('Linux')!.grounding).toBe(1);
    expect(byGap.get('Datadog')!.verdict).not.toBe('supported'); // invented basis demoted
    expect(byGap.get('Secrets Manager')!.verdict).not.toBe('supported');
    // LLM-suggested new category is allowed when sane (creates a proper
    // tooling section instead of dumping into Core Competencies).
    expect(byGap.get('Datadog')!.category).toBe('Observability');
  });

  it('buildEnrichmentProposal: LLM summary rewrites are rejected when they contain numbers the CV never had', async () => {    stubLlm({
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

  it('pick mode: analyzes exactly the user-selected gaps (credentials filtered, CV-present dropped)', async () => {
    stubLlm({
      items: [
        { gap: 'linux', verdict: 'supported', basis: '"Moved container builds on GitLab CI/CD to a rootless, non-privileged setup"', category: 'Security & Compliance' },
        { gap: 'datadog', verdict: 'adjacent', basis: 'Monitored system logs and triaged issues proactively across production environments.', category: 'Observability' },
      ],
      summaryRewrite: null,
      projectTags: [],
    });
    const proposal = await buildEnrichmentProposal(cv, gaps, {
      pick: ['linux', 'datadog', 'AWS Certified Solutions Architect', 'kubernetes', 'linux'],
    });
    expect(proposal.picked).toBe(true);
    // credential + already-present skill dropped; duplicate collapses
    expect(proposal.stats.gapsConsidered).toBe(2);
    expect(proposal.items.map((i) => i.gap).sort()).toEqual(['Datadog', 'Linux']);
    expect(proposal.items.find((i) => i.gap === 'Linux')!.verdict).toBe('supported');
  });

  it('applyEnrichment: user-approved items only, placed into existing categories, deduped, immutable source', () => {
    const proposal: EnrichProposal = {
      id: 'p-test',
      createdAt: new Date().toISOString(),
      picked: false,
      items: [
        { gap: 'linux', count: 56, verdict: 'supported', basis: '', category: 'Security & Compliance', grounding: 1 },
        { gap: 'datadog', count: 36, verdict: 'adjacent', basis: '', category: 'Observability', grounding: 0.4 },
        { gap: 'go', count: 31, verdict: 'unsupported', basis: '', category: 'Core Competencies', grounding: 0 },
      ],
      summaryRewrite: { text: 'Senior DevSecOps Engineer with 4+ years building secure CI/CD platforms.', reason: 'r' },
      projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko', basis: 'b' }],
      bulletEdits: [
        {
          expIndex: 0,
          hIndex: 0,
          before: 'Moved container builds on GitLab CI/CD to a rootless, non-privileged setup using Kaniko and BuildKit inside Minikube',
          after: 'Moved container builds on Linux-based GitLab CI/CD runners to a rootless, non-privileged setup using Kaniko and BuildKit inside Minikube',
          gap: 'Linux',
          basis: 'b',
        },
      ],
      stats: { scannedJobs: 128, gapsConsidered: 3, supported: 2, adjacent: 1, unsupported: 0, droppedClaims: 0 },
    };
    const { next, applied } = applyEnrichment(cv, proposal, {
      acceptedGaps: ['linux', 'datadog', 'go', 'ghost-skill'],
      applySummary: true,
      projectTags: [{ project: 'Netflix DevSecOps Pipeline', tag: 'Kaniko' }],
      bulletEdits: [{ expIndex: 0, hIndex: 0, gap: 'Linux' }],
    });

    expect(applied.skills).toEqual(['linux', 'datadog']); // unsupported + unknown never applied
    expect(applied.bullets).toBe(1);
    expect(next.experiences[0].responsibilities[0]).toContain('Linux-based GitLab CI/CD');
    expect(cv.experiences[0].responsibilities[0]).not.toContain('Linux-based'); // source untouched
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

  it('deducts what the CV already has and never-claimable items from the gap list', async () => {
    const { gaps: filtered, totalScored } = aggregateMarketGapsFromJobs(
      [
        { gapAnalysis: { missingSkills: ['Linux', 'Datadog', 'AWS Certified Solutions Architect'] } },
        { gapAnalysis: { missingSkills: ['Linux', 'BigQuery'] } },
      ] as any[],
      { evidenceText: 'Experienced with Linux systems, Kubernetes and GKE.', excludePriorClaims: true }
    );
    expect(totalScored).toBe(2);
    const names = filtered.map((g) => g.skill);
    expect(names).not.toContain('linux'); // already in the CV -> deducted
    expect(names).not.toContain('aws certified solutions architect'); // never claimable
    expect(names).toContain('datadog');
    expect(names).toContain('bigquery');
  });

  it('one-click auto-apply accepts everything grounded and never applies unsupported items', async () => {
    const { autoApplyOptions } = await import('../../server/cv/marketEnrich.js');
    const proposal: EnrichProposal = {
      id: 'auto-1',
      createdAt: new Date().toISOString(),
      picked: true,
      items: [
        { gap: 'Linux', count: 1, verdict: 'supported', basis: '', category: 'Systems & OS', grounding: 1 },
        { gap: 'Redis', count: 1, verdict: 'adjacent', basis: '', category: 'Databases & Data Stores', grounding: 0.4 },
        { gap: 'Go', count: 1, verdict: 'unsupported', basis: '', category: 'Core Competencies', grounding: 0 },
      ],
      summaryRewrite: { text: 'x', reason: 'r' },
      projectTags: [{ project: 'P', tag: 'T', basis: 'b' }],
      bulletEdits: [{ expIndex: 0, hIndex: 0, before: 'b', after: 'a', gap: 'Linux', basis: '' }],
      stats: { scannedJobs: 1, gapsConsidered: 3, supported: 1, adjacent: 1, unsupported: 1, droppedClaims: 0 },
    };
    const opts = autoApplyOptions(proposal);
    expect(opts.acceptedGaps).toEqual(['Linux', 'Redis']); // unsupported is never applied
    expect(opts.applySummary).toBe(true);
    expect(opts.bulletEdits).toEqual([{ expIndex: 0, hIndex: 0, gap: 'Linux' }]);
    expect(opts.projectTags).toEqual([{ project: 'P', tag: 'T' }]);
  });

  it('TAXONOMY: normalizes display casing and classifies canonical buckets', async () => {
    const { normalizeSkillDisplay, classifySkillBucket, organizeSkills } = await import('../../server/cv/skillTaxonomy.js');
    expect(normalizeSkillDisplay('ec2')).toBe('EC2');
    expect(normalizeSkillDisplay('slo')).toBe('SLO');
    expect(normalizeSkillDisplay('javascript')).toBe('JavaScript');
    expect(normalizeSkillDisplay('github copilot')).toBe('GitHub Copilot');
    expect(normalizeSkillDisplay('dynamodb')).toBe('DynamoDB');
    expect(normalizeSkillDisplay('Kubernetes')).toBe('Kubernetes');
    expect(classifySkillBucket('ec2')).toBe('AWS Services');
    expect(classifySkillBucket('s3')).toBe('AWS Services');
    expect(classifySkillBucket('dns')).toBe('Networking');
    expect(classifySkillBucket('slo')).toBe('Site Reliability Practices');
    expect(classifySkillBucket('postgresql')).toBe('Databases & Data Stores');
    expect(classifySkillBucket('linux')).toBe('Systems & OS');
    expect(classifySkillBucket('bigquery')).toBe('GCP Services');
    expect(classifySkillBucket('Cloud Run')).toBe('GCP Services');
    expect(classifySkillBucket('cosmos db')).toBe('Azure Services');
    expect(classifySkillBucket('key vault')).toBe('Azure Services');
    expect(classifySkillBucket('threat modeling')).toBe('Security Practices');
    expect(classifySkillBucket('kubernetes')).toBeNull();
    expect(classifySkillBucket('eks')).toBeNull(); // managed-k8s stays in Containers
    expect(normalizeSkillDisplay('bigquery')).toBe('BigQuery');
    expect(normalizeSkillDisplay('cosmos db')).toBe('Cosmos DB');

    // Organizer: services leave Cloud Platforms, everything normalized.
    const { skills, moves } = organizeSkills([
      { category: 'Cloud Platforms', items: ['AWS', 'GCP', 'Azure', 'ec2', 'vpc', 's3', 'dns', 'networking'] },
      { category: 'Observability', items: ['Prometheus', 'slo', 'sli', 'Datadog'] },
      { category: 'Core Competencies', items: ['postgresql', 'linux'] },
    ]);
    const byCat = new Map(skills.map((g) => [g.category, g.items]));
    expect(byCat.get('AWS Services')).toEqual(['EC2', 'VPC', 'S3']);
    expect(byCat.get('Networking')).toEqual(['DNS']); // 'networking' item is redundant with its category name
    expect(byCat.get('Cloud Platforms')).toEqual(['AWS', 'GCP', 'Azure']);
    expect(byCat.get('Observability')).toEqual(['Prometheus', 'Datadog']);
    expect(byCat.get('Site Reliability Practices')).toEqual(['SLO', 'SLI']);
    expect(byCat.get('Databases & Data Stores')).toEqual(['PostgreSQL']);
    expect(byCat.get('Systems & OS')).toEqual(['Linux']);
    expect(moves.some((m) => m.item === 'EC2' && m.from === 'Cloud Platforms' && m.to === 'AWS Services')).toBe(true);
  });

  it('BULLET EDITS: grounded minimal rewrites only — lost numbers or fabricated mentions are rejected', async () => {
    const { groundBulletEdits } = await import('../../server/cv/marketEnrich.js');
    const evidence = masterCvEvidenceText(cv);
    const current = cv.experiences[0].responsibilities[0]; // "...rootless, non-privileged setup using Kaniko and BuildKit inside Minikube"
    const edits = groundBulletEdits(
      [
        // valid: names Linux, keeps every fact
        { expIndex: 0, hIndex: 0, gap: 'linux', before: current, after: current.replace('container builds on GitLab CI/CD', 'container builds on Linux-based GitLab CI/CD'), basis: 'Linux runners' },
        // invalid: drops a number (the metric test bullet)
        { expIndex: 0, hIndex: 1, gap: 'slo', before: cv.experiences[0].responsibilities[1], after: 'Hardened Kubernetes clusters with IAM and RBAC policies', basis: 'x' },
        // invalid: gap not actually named in the rewrite
        { expIndex: 0, hIndex: 1, gap: 'terraform', before: cv.experiences[0].responsibilities[1], after: cv.experiences[0].responsibilities[1] + ' and more', basis: 'x' },
        // invalid: before is not the live bullet
        { expIndex: 0, hIndex: 0, gap: 'linux', before: 'some other text', after: current + ' on Linux', basis: 'x' },
      ],
      cv,
      evidence
    );
    expect(edits.length).toBe(1);
    expect(edits[0].gap).toBe('Linux');
    expect(edits[0].after).toContain('Linux-based');
  });
});
