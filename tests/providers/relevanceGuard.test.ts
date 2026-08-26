import { describe, it, expect } from 'vitest';
import { applyRelevanceGuard } from '../../server/storage/v2Tables.js';

// Pure-function tests for the V1 relevance-guard bypass fix.
// No network, no Apify, no DB, no persistence.

describe('applyRelevanceGuard — fully-irrelevant slice (regression)', () => {
  const irrelevant = [
    { title: 'Customer Success Associate', company: 'X' },
    { title: 'Operations Associate', company: 'X' },
    { title: 'Treasury Finance – Business & Data Analytics', company: 'X' },
    { title: 'Tech Recruiter', company: 'X' },
    { title: 'Account Executive', company: 'X' },
    { title: 'Senior Data Engineer', company: 'X' },
  ];

  it('query "DevOps Engineer": 0 jobs survive', () => {
    const out = applyRelevanceGuard(irrelevant, 'DevOps Engineer');
    expect(out.length).toBe(0);
  });

  it('query "DevOps Engineer": 0 jobs persist (empty result means nothing saved)', () => {
    const out = applyRelevanceGuard(irrelevant, 'DevOps Engineer');
    expect(out.length).toBe(0);
    // Simulate the persist step: only the guard output would be written.
    expect(out.filter((j) => j.title).length).toBe(0);
  });

  it('query "Cyber Security Engineer": also 0 from the same slice', () => {
    expect(applyRelevanceGuard(irrelevant, 'Cyber Security Engineer').length).toBe(0);
  });
});

describe('applyRelevanceGuard — mixed slice (regression)', () => {
  const mixed = [
    { title: 'DevOps Engineer', company: 'A' },
    { title: 'Senior Platform Engineer', company: 'B' },
    { title: 'Senior Data Engineer', company: 'C' },
    { title: 'Account Executive', company: 'D' },
    { title: 'Product Manager', company: 'E' },
  ];

  it('only DevOps Engineer and Senior Platform Engineer survive', () => {
    const out = applyRelevanceGuard(mixed, 'DevOps Engineer');
    const titles = out.map((j) => j.title);
    expect(titles).toEqual(['DevOps Engineer', 'Senior Platform Engineer']);
  });
});

describe('applyRelevanceGuard — strong DevOps roles still survive (no vocabulary change)', () => {
  it('SRE / Platform Engineer / Infrastructure Engineer pass', () => {
    const roles = [
      { title: 'Site Reliability Engineer', company: 'A' },
      { title: 'Platform Engineer', company: 'B' },
      { title: 'Infrastructure Engineer', company: 'C' },
    ];
    const out = applyRelevanceGuard(roles, 'DevOps Engineer');
    expect(out.length).toBe(3);
    expect(out.map((j) => j.title)).toContain('Site Reliability Engineer');
    expect(out.map((j) => j.title)).toContain('Platform Engineer');
    expect(out.map((j) => j.title)).toContain('Infrastructure Engineer');
  });
});

describe('applyRelevanceGuard — no query = no filtering', () => {
  it('empty query passes everything through', () => {
    const jobs = [{ title: 'Account Executive', company: 'X' }, { title: 'DevOps Engineer', company: 'Y' }];
    expect(applyRelevanceGuard(jobs, '').length).toBe(2);
  });
});