import { describe, it, expect } from 'vitest';
import { diffBoard } from '../../server/indexer/diff.js';

const mk = (id: string, title = 'DevOps Engineer') => ({
  id, title, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
} as any);

describe('diffBoard — incremental refresh', () => {
  it('new job → added', () => {
    const d = diffBoard([mk('a')], [mk('a'), mk('b')], 'u');
    expect(d.added.map((j) => j.id)).toEqual(['b']);
    expect(d.bumped).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });
  it('removed job → missing (not added)', () => {
    const d = diffBoard([mk('a'), mk('b')], [mk('a')], 'u');
    expect(d.missing).toEqual(['b']);
    expect(d.added).toEqual([]);
  });
  it('same board → nothing added, all bumped', () => {
    const d = diffBoard([mk('a')], [mk('a')], 'u');
    expect(d.added).toEqual([]);
    expect(d.bumped).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });
  it('changed job (title) → treated as bumped, not added (id is identity)', () => {
    const d = diffBoard([mk('a', 'Old Title')], [mk('a', 'New Title')], 'u');
    expect(d.added).toEqual([]);
    expect(d.bumped).toEqual(['a']);
  });
});