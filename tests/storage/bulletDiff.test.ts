import { describe, it, expect } from 'vitest';
import { computeBulletDiffs, computeKeywordStatus } from '../../server/tailorV2/bulletDiff.js';
import type { MasterCv } from '../../src/types.js';
import type { TailorDraft } from '../../server/tailorV2/drafter.js';

const cv = {
  experiences: [
    { id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present',
      responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS clusters'] },
    { id: '2', title: 'Cloud Engineer', company: 'Nexus', location: 'Pune', dates: '2018 – 2020',
      responsibilities: ['Automated AWS with Terraform'] },
  ],
} as unknown as MasterCv;

const draft: TailorDraft = {
  summary: 'DevOps engineer.',
  skills: ['Kubernetes', 'AWS'],
  experience: [
    { title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present',
      highlights: ['Cut deployment time by 70% with GitOps', 'Managed GKE and EKS clusters', 'Delivered a new platform'], },
    { title: 'Cloud Engineer', company: 'Nexus', dates: '2018 – 2020',
      highlights: ['Automated AWS infrastructure with Terraform'] },
  ],
  education: [], certifications: [],
};

describe('bullet diff', () => {
  it('aligns bullets positionally and flags changes, inserted bullets and added JD terms', () => {
    const diffs = computeBulletDiffs(cv, draft);
    expect(diffs).toHaveLength(4);
    // addedTerms starts empty; the audit task (Task 2) fills them from jdTerms.
    expect(diffs[0]).toMatchObject({ expIndex: 0, changed: true, addedTerms: [] });
    expect(diffs[0].original).toBe('Reduced deployment time by 70%');
    expect(diffs[1].changed).toBe(false); // verbatim
    expect(diffs[2].original).toBeUndefined(); // inserted
    expect(diffs[3].changed).toBe(true);
  });

  it('flags enhanced bullets from the ledger indices', () => {
    const ledger = { entries: [{ bulletIndex: 0, expIndex: 0, hIndex: 0, type: 'metric', claim: 'Cut deployment time by 70% with GitOps', basis: '70%' }] };
    const diffs = computeBulletDiffs(cv, draft, ledger as any);
    expect(diffs[0].enhanced).toBe(true);
    expect(diffs[1].enhanced).toBe(false);
  });

  it('classifies JD terms by precedence: experience → skills → enhanced → already present → unsupported', () => {
    const ledger = { entries: [] };
    const status = computeKeywordStatus(['gitops', 'kubernetes', 'reduced', 'snowflake'], draft, cv, ledger as any);
    const byTerm = Object.fromEntries(status.map((s) => [s.term, s.kind]));
    expect(byTerm['gitops']).toBe('added_experience');   // in a bullet
    expect(byTerm['kubernetes']).toBe('added_skills');   // in skills only
    expect(byTerm['reduced']).toBe('already_present');   // in master source text only
    expect(byTerm['snowflake']).toBe('unsupported');     // nowhere
  });

  it('marks ledger-covered terms as enhanced before already-present', () => {
    const ledger = { entries: [{ bulletIndex: 0, expIndex: 0, hIndex: 0, type: 'metric', claim: 'Reduced deployment time by 70%', basis: '70%' }] };
    const status = computeKeywordStatus(['reduced'], draft, cv, ledger as any);
    expect(status[0].kind).toBe('enhanced');
    expect(status[0].basis).toBe('70%');
  });
});
