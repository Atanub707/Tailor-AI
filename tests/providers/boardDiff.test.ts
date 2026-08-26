import { describe, it, expect } from 'vitest';
import { diffBoard, hasMaterialChange } from '../../server/indexer/diff.js';

const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: 'DevOps Engineer', company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
  postedDate: '2026-08-20T10:00:00Z',
  ...over,
} as any);

describe('diffBoard — material changes', () => {
  it('unchanged job → bumped, not changed', () => {
    const d = diffBoard([mk('a')], [mk('a')], 'u');
    expect(d.bumped).toEqual(['a']);
    expect(d.changed).toEqual([]);
  });

  it('title change → changed (and not in bumped)', () => {
    const d = diffBoard([mk('a', { title: 'Old Title' })], [mk('a', { title: 'New Title' })], 'u');
    expect(d.changed).toEqual(['a']);
    expect(d.bumped).toEqual([]);
  });

  it('applyUrl change → changed', () => {
    const d = diffBoard(
      [mk('a', { applyUrl: 'https://boards.greenhouse.io/stripe/old', url: 'https://boards.greenhouse.io/stripe/old' })],
      [mk('a', { applyUrl: 'https://boards.greenhouse.io/stripe/new', url: 'https://boards.greenhouse.io/stripe/new' })],
      'u'
    );
    expect(d.changed).toEqual(['a']);
  });

  it('postedDate change → changed', () => {
    const d = diffBoard(
      [mk('a', { postedDate: '2026-08-20T10:00:00Z' })],
      [mk('a', { postedDate: '2026-08-21T10:00:00Z' })],
      'u'
    );
    expect(d.changed).toEqual(['a']);
  });

  it('location change → changed', () => {
    const d = diffBoard([mk('a', { location: 'Remote' })], [mk('a', { location: 'New York' })], 'u');
    expect(d.changed).toEqual(['a']);
  });

  it('company change → changed', () => {
    const d = diffBoard([mk('a', { company: 'Stripe' })], [mk('a', { company: 'Stripe EMEA' })], 'u');
    expect(d.changed).toEqual(['a']);
  });

  it('new job + changed + missing all reported together', () => {
    const d = diffBoard([mk('a'), mk('gone')], [mk('a', { title: 'New' }), mk('b')], 'u');
    expect(d.added.map((j) => j.id)).toEqual(['b']);
    expect(d.changed).toEqual(['a']);
    expect(d.missing).toEqual(['gone']);
  });

  it('hasMaterialChange is false for equal jobs', () => {
    expect(hasMaterialChange(mk('a'), mk('a'))).toBe(false);
  });
});