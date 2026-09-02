import { describe, it, expect } from 'vitest';
import { parseEnhancementAnnotations, countClaimElements, budgetExceeded, normalizeRedZoneTokens, stripEnhancementAnnotations } from '../../server/tailorV2/enhancementLedger.js';
import type { TailorDraft } from '../../server/tailorV2/drafter.js';
import type { MasterCv } from '../../src/types.js';

const draft: TailorDraft = {
  summary: 'DevOps engineer.',
  skills: ['Kubernetes', 'AWS'],
  experience: [
    { title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present',
      highlights: [
        'Reduced deployment time by 70% {"__enhanced":{"type":"metric","basis":"70% deploy cut in source"}}',
        'Managed production clusters',
      ] },
  ],
  education: [], certifications: [],
};

describe('enhancement ledger', () => {
  it('parses self-declared annotations from highlight JSON suffixes', () => {
    const entries = parseEnhancementAnnotations(draft);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('metric');
    expect(entries[0].expIndex).toBe(0);
    expect(entries[0].hIndex).toBe(0);
    expect(entries[0].bulletIndex).toBe(0); // deprecated alias of expIndex
    expect(entries[0].basis).toContain('70%');
  });

  it('records per-work-experience and per-highlight indices (chip reconciliation)', () => {
    const multi: TailorDraft = {
      ...draft,
      experience: [
        draft.experience[0],
        { title: 'Cloud Engineer', company: 'Nexus', dates: '2018 – 2020',
          highlights: [
            'Automated AWS with Terraform {"__enhanced":{"type":"tool","basis":"AWS in source"}}',
            'Managed CI/CD pipelines',
          ] },
      ],
    };
    const entries = parseEnhancementAnnotations(multi);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ expIndex: 0, hIndex: 0 });
    expect(entries[1]).toMatchObject({ expIndex: 1, hIndex: 0 });
  });

  it('counts claim elements as summary + highlights + skills', () => {
    expect(countClaimElements(draft)).toBe(1 + 2 + 2);
  });

  it('budget exceeded at >30%', () => {
    const ledger = { entries: [ { bulletIndex: 0, expIndex: 0, hIndex: 0, type: 'metric' as const, claim: 'x', basis: 'y' } ] };
    // 1 enhancement / 5 elements = 20% → OK
    expect(budgetExceeded(ledger, 5)).toBe(false);
    // 2 / 5 = 40% → exceeded
    expect(budgetExceeded({ entries: [ledger.entries[0], ledger.entries[0]] }, 5)).toBe(true);
  });

  it('red zone tokens cover employers, titles, degrees, certs, projects', () => {
    const cv = { experiences: [{ company: 'Human Managed', title: 'Senior DevSecOps Engineer' }],
      education: [{ degree: 'B.Tech', institution: 'IIT' }],
      certifications: [{ name: 'CKA' }],
      projects: [{ name: 'K8s Cluster Autoscaler' }] } as unknown as MasterCv;
    const s = normalizeRedZoneTokens(cv);
    expect(s.has('human managed')).toBe(true);
    expect(s.has('b.tech')).toBe(true);
    expect(s.has('cka')).toBe(true);
    expect(s.has('k8s cluster autoscaler')).toBe(true);
  });

  it('strips enhancement annotation suffixes but preserves plain text', () => {
    const stripped = stripEnhancementAnnotations(draft);
    expect(stripped.experience[0].highlights[0]).toBe('Reduced deployment time by 70%');
    expect(stripped.experience[0].highlights[1]).toBe('Managed production clusters');
    expect(JSON.stringify(stripped)).not.toContain('__enhanced');
  });
});
