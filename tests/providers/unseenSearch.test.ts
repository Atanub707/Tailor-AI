import { describe, it, expect, beforeEach } from 'vitest';
import { ensureV2Tables, markSeen, getSeenFingerprints, getProviderCursor, saveProviderCursor } from '../../server/storage/v2Tables.js';
import { getDb } from '../../server/storage/fileStorage.js';

beforeEach(() => { ensureV2Tables(); const db = getDb(); db.prepare('DELETE FROM search_seen').run(); db.prepare('DELETE FROM provider_cursors').run(); });

describe('V2 unseen-search storage', () => {
  it('markSeen + getSeenFingerprints round-trips per (user, queryFp)', () => {
    markSeen('u1', 'q1', ['fp-a', 'fp-b']);
    markSeen('u1', 'q2', ['fp-a']);
    expect([...getSeenFingerprints('u1', 'q1')].sort()).toEqual(['fp-a', 'fp-b']);
    expect([...getSeenFingerprints('u1', 'q2')]).toEqual(['fp-a']);
    expect(getSeenFingerprints('u2', 'q1').size).toBe(0); // user isolation
  });

  it('markSeen is idempotent', () => {
    markSeen('u1', 'q1', ['fp-a']);
    markSeen('u1', 'q1', ['fp-a']);
    expect(getSeenFingerprints('u1', 'q1').size).toBe(1);
  });

  it('provider cursor round-trips per (user, queryFp, provider)', () => {
    expect(getProviderCursor('u1', 'q1', 'linkedin')).toEqual({ cursor: undefined, fetchedCount: 0 });
    saveProviderCursor('u1', 'q1', 'linkedin', '25', 25);
    expect(getProviderCursor('u1', 'q1', 'linkedin')).toEqual({ cursor: '25', fetchedCount: 25 });
    expect(getProviderCursor('u1', 'q2', 'linkedin').fetchedCount).toBe(0);
  });
});