import { describe, it, expect } from 'vitest';
import { normalizeDates } from '../../server/providers/directAtsProvider.js';

// Pure function tests — no network, no Apify, no fetch.

describe('normalizeDates — provider date semantics', () => {
  it('Greenhouse: first_published wins over updated_at (the critical bug)', () => {
    const d = normalizeDates('2026-02-03T15:19:01-05:00', undefined, '2026-08-25T17:40:40-04:00');
    expect(d.semantics).toBe('published');
    expect(d.ts).toBe(new Date('2026-02-03T15:19:01-05:00').toISOString());
  });
  it('Greenhouse: updated_at fallback is labelled updated, never published', () => {
    const d = normalizeDates(undefined, undefined, '2026-08-25T17:40:40-04:00');
    expect(d.semantics).toBe('updated');
    expect(d.ts).toBe(new Date('2026-08-25T17:40:40-04:00').toISOString());
  });
  it('Lever: createdAt (ms epoch) becomes created', () => {
    const d = normalizeDates(undefined, 1711403416463, 1711403416463);
    expect(d.semantics).toBe('created');
    expect(d.ts).toBe(new Date(1711403416463).toISOString());
  });
  it('Ashby: publishedAt becomes published', () => {
    const d = normalizeDates('2026-03-12T16:38:15.322+00:00', '2026-03-12T16:38:15.322+00:00', '2026-03-12T16:38:15.322+00:00');
    expect(d.semantics).toBe('published');
    expect(d.ts).toBe('2026-03-12T16:38:15.322Z');
  });
  it('nothing available → unknown, no timestamp', () => {
    const d = normalizeDates(undefined, undefined, undefined);
    expect(d.semantics).toBe('unknown');
    expect(d.ts).toBeUndefined();
  });
  it('garbage timestamps → unknown, never a guess', () => {
    const d = normalizeDates('not-a-date', undefined, undefined);
    expect(d.semantics).toBe('unknown');
    expect(d.ts).toBeUndefined();
  });
  it('published preferred over created when both exist', () => {
    const d = normalizeDates('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', undefined);
    expect(d.semantics).toBe('published');
    expect(d.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});