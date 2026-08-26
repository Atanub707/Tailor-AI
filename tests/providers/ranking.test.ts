import { describe, it, expect } from 'vitest';
import { rankRelevant } from '../../server/search/rank.js';

const hour = 60 * 60 * 1000;
const now = Date.now();

const devopsOlder = { title: 'DevOps Engineer', company: 'A', postedDate: new Date(now - 48 * hour).toISOString() };
const platformNewer = { title: 'Platform Engineer', company: 'B', postedDate: new Date(now - 1 * hour).toISOString() };
const cloudNewest = { title: 'Cloud Engineer', company: 'C', postedDate: new Date(now - 10 * 60 * 1000).toISOString() };
const data = { title: 'Data Engineer', company: 'D', postedDate: new Date(now - 5 * 60 * 1000).toISOString() };

describe('rankRelevant — relevance tier beats freshness', () => {
  it('older exact match ranks above newer related match', () => {
    const ranked = rankRelevant([cloudNewest, platformNewer, devopsOlder], 'DevOps Engineer', (j) => j.title, (j) => j.company);
    expect(ranked[0].job.title).toBe('DevOps Engineer'); // exact, 48h old
    expect(ranked[1].job.title).toBe('Platform Engineer'); // strong_related, 1h old
    expect(ranked[2].job.title).toBe('Cloud Engineer'); // related, 10m old
  });

  it('relevance score DESC then freshness DESC within tier', () => {
    const twoExact = [
      { title: 'DevOps Engineer', company: 'Old', postedDate: new Date(now - 24 * hour).toISOString() },
      { title: 'Senior DevOps Engineer', company: 'New', postedDate: new Date(now - 2 * hour).toISOString() },
    ];
    const ranked = rankRelevant(twoExact, 'DevOps Engineer', (j) => j.title, (j) => j.company);
    expect(ranked[0].job.company).toBe('New'); // same tier → newer wins
  });

  it('irrelevant jobs are excluded entirely', () => {
    const ranked = rankRelevant([data, devopsOlder], 'DevOps Engineer', (j) => j.title, (j) => j.company);
    expect(ranked.map((r) => r.job.title)).toEqual(['DevOps Engineer']);
  });

  it('deterministic tie-breaker: same score + same freshness → title ASC', () => {
    const same = [
      { title: 'Zeta DevOps Engineer', company: 'X', postedDate: new Date(now - 3 * hour).toISOString() },
      { title: 'Alpha DevOps Engineer', company: 'X', postedDate: new Date(now - 3 * hour).toISOString() },
    ];
    const ranked = rankRelevant(same, 'DevOps Engineer', (j) => j.title, (j) => j.company);
    expect(ranked[0].job.title).toBe('Alpha DevOps Engineer');
  });
});