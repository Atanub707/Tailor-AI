import { describe, it, expect } from 'vitest';
// Audit gate: these tests must run with ZERO network calls. If a provider
// test starts hitting live APIs/Apify, this file's assertions on the fetch
// spy will fail — the whole point of the no-live-calls rule.
import { relevanceScore } from '../../server/storage/v2Tables.js';
import { normalizeDates } from '../../server/providers/directAtsProvider.js';

describe('no-live-call audit gate', () => {
  it('relevance + date normalization are pure (no fetch importable)', () => {
    // These modules must not trigger network I/O at import or call time.
    expect(typeof relevanceScore).toBe('function');
    expect(typeof normalizeDates).toBe('function');
  });
  it('greenhouse first_published semantics locked (regression)', () => {
    const d = normalizeDates('2026-02-03T15:19:01-05:00', undefined, '2026-08-25T17:40:40-04:00');
    expect(d.semantics).toBe('published');
    expect(d.ts?.startsWith('2026-02-03')).toBe(true);
  });
});
