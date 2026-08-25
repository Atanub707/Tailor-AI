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

import { searchWithCache } from '../../server/services/searchService.js';
import { runWithUser } from '../../server/storage/fileStorage.js';
import { vi, afterEach } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });

describe('searchWithCache — unseen-first', () => {
  // Hermetic: test 1 runs under runWithUser('u-seen'), so searchWithCache's
  // final markSeen(...) persists fingerprints for u-seen to the real DB.
  // Remove that user's rows after every test so a second run of this file
  // still sees "30 fresh, 10 seen" instead of a polluted search_seen table.
  afterEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM search_seen WHERE user_id = 'u-seen'").run();
    db.prepare("DELETE FROM provider_cursors WHERE user_id = 'u-seen'").run();
  });

  const job = (i: number) => ({
    id: `j${i}`, title: 'DevOps Engineer', company: `C${i}`,
    description: 'DevOps engineer role', url: `https://x.com/j${i}`,
    applyUrl: `https://x.com/j${i}`, source: 'Custom', state: 'pending',
    fingerprint: `fp-${i}`, scrapedAt: new Date().toISOString(), isActive: true,
    postedDate: new Date(Date.now() - i * 60000).toISOString(), createdAt: '', updatedAt: '',
  });

  it('returns unseen first: 30 fresh, 10 seen, LIMIT 25 → the unseen 20 + missing top-up', async () => {
    const all = Array.from({ length: 30 }, (_, i) => job(i));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(all as any);
    // Simulate: user u-seen has already seen fp-0..fp-9 in the default query walk
    markSeen('u-seen', 'devops-engineer|any|24h|any|any', all.slice(0, 10).map(j => j.fingerprint));

    const fetchFn = vi.fn().mockResolvedValue({ jobs: [job(30), job(31)] }); // 2 new
    const result = await runWithUser('u-seen', () =>
      searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn)
    );
    const titles = result.jobs.map((j: any) => j.id);
    expect(titles).not.toContain('j0'); // seen job excluded
    expect(titles).not.toContain('j9');
    expect(result.jobs.length).toBeLessThanOrEqual(25);
  });

  it('cache hit: 25 fresh unseen exist → 0 provider calls, cacheHit true', async () => {
    const all = Array.from({ length: 25 }, (_, i) => job(i));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(all as any);
    const fetchFn = vi.fn();
    const result = await searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect(result.jobs.length).toBe(25);
  });
});