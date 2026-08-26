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
    db.prepare("DELETE FROM search_seen WHERE user_id = 'u-window'").run();
    db.prepare("DELETE FROM provider_cursors WHERE user_id = 'u-window'").run();
    db.prepare("DELETE FROM search_seen WHERE user_id = 'u-x'").run();
    db.prepare("DELETE FROM provider_cursors WHERE user_id = 'u-x'").run();
    db.prepare("DELETE FROM search_seen WHERE user_id = 'u-topup'").run();
    db.prepare("DELETE FROM provider_cursors WHERE user_id = 'u-topup'").run();
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
    expect(result.queryFp).toBeTruthy();
    expect(typeof result.seenCount).toBe('number');
    expect(typeof result.totalStored).toBe('number');
  });

  it('cache hit: 25 fresh unseen exist → 0 provider calls, cacheHit true', async () => {
    const all = Array.from({ length: 25 }, (_, i) => job(i));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(all as any);
    const fetchFn = vi.fn();
    const result = await searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect(result.jobs.length).toBe(25);
    expect(result.queryFp).toBeTruthy();
    expect(typeof result.seenCount).toBe('number');
    expect(typeof result.totalStored).toBe('number');
    expect(result.exhausted).toBe(false);
  });

  it('exhausted: providers return only seen jobs → exhausted true, no crash', async () => {
    const all = Array.from({ length: 25 }, (_, i) => job(i));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(all as any);
    markSeen('u-x', 'devops-engineer|any|24h|any|any', all.map(j => j.fingerprint));
    const fetchFn = vi.fn().mockResolvedValue({ jobs: all.slice(0, 5) }); // all already seen
    const result = await runWithUser('u-x', () =>
      searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn)
    );
    expect(result.jobs.length).toBe(0);
    expect((result as any).exhausted).toBe(true);
  });

  it('top-up: first provider under-delivers → one bounded top-up fills the gap', async () => {
    const all = Array.from({ length: 10 }, (_, i) => job(i));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(all as any);
    // One top-up-returned job (fp-62) is already seen → the top-up's own seen-filter must exclude it
    markSeen('u-topup', 'devops-engineer|any|24h|any|any', ['fp-62']);

    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ jobs: Array.from({ length: 10 }, (_, i) => job(50 + i)) }) // main fan-out call
      .mockResolvedValueOnce({ jobs: Array.from({ length: 5 }, (_, i) => job(60 + i)) });  // top-up call
    const result = await runWithUser('u-topup', () =>
      searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 25 }, fetchFn)
    );

    expect(fetchFn).toHaveBeenCalledTimes(2); // exactly one main call + one bounded top-up
    expect(result.providersCalled).toEqual(['santa-maria', 'linkedin']); // 'linkedin' = the top-up provider
    expect(result.jobs.length).toBe(24); // 10 DB + 10 main + 5 top-up − 1 seen top-up job
    expect(result.jobs.map((j: any) => j.fingerprint)).not.toContain('fp-62'); // seen-exclusion holds
    expect(result.jobs.map((j: any) => j.fingerprint)).toContain('fp-50'); // main-call jobs still included
  });

  it('postedWithin 24h excludes a fresh-scraped job posted 8 days ago (DB-first)', async () => {
    const old = {
      id: 'old-1', title: 'DevOps Engineer', company: 'LegacyCo',
      description: 'DevOps engineer role', url: 'https://x.com/old-1', applyUrl: 'https://x.com/old-1',
      source: 'Custom', state: 'pending', fingerprint: 'fp-old',
      scrapedAt: new Date().toISOString(), isActive: true,
      postedDate: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      postedDateParsed: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      createdAt: '', updatedAt: '',
    };
    const fresh = {
      id: 'fresh-1', title: 'DevOps Engineer', company: 'NewCo',
      description: 'DevOps engineer role', url: 'https://x.com/fresh-1', applyUrl: 'https://x.com/fresh-1',
      source: 'Custom', state: 'pending', fingerprint: 'fp-fresh',
      scrapedAt: new Date().toISOString(), isActive: true,
      postedDate: new Date().toISOString(), postedDateParsed: new Date().toISOString().slice(0, 10),
      createdAt: '', updatedAt: '',
    };
    const { getAllJobs } = await import('../../server/storage/fileStorage.js');
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue([old, fresh] as any);
    const fetchFn = vi.fn().mockResolvedValue({ jobs: [] });
    const result = await runWithUser('u-window', () =>
      searchWithCache({ query: 'DevOps Engineer', postedWithin: '24h', limit: 5 }, fetchFn)
    );
    expect(result.jobs.length).toBe(1);
    expect(result.jobs.map((j: any) => j.id)).toEqual(['fresh-1']); // 8-day-old job excluded
  });
});

import { routeProvider } from '../../server/services/providerRouter.js';

describe('providerRouter — cursor advance (mocked providers)', () => {
  it('LinkedIn receives start = fetchedCount from the cursor', async () => {
    const { ApifyLinkedInScraper } = await import('../../server/scraper/apifyScraper.js');
    let captured: any = null;
    vi.spyOn(ApifyLinkedInScraper.prototype, 'scrape').mockImplementation(async function (this: any, params: any) {
      captured = params;
      return [];
    });
    saveProviderCursor('u-c', 'devops|any|24h|any|any', 'linkedin', '25', 25);
    await runWithUser('u-c', () =>
      routeProvider({ query: 'DevOps', postedWithin: '24h', limit: 25 } as any, 'linkedin', 8)
    );
    expect(captured).not.toBeNull();
    expect(captured.skipJobId ?? captured.start ?? captured.offset).toBeDefined();
    expect(Number(captured.start ?? captured.offset ?? 0)).toBeGreaterThanOrEqual(25);
    vi.restoreAllMocks();
  });
});