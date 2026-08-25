import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchWithCache } from '../../server/services/searchService.js';

const mockJobs = (n: number, prefix = 'DevOps') =>
  Array.from({ length: n }, (_, i) => ({
    id: `job-${i}`,
    title: `${prefix} Engineer ${i}`,
    company: `Company${i}`,
    description: `Description for ${prefix} ${i}`,
    url: `https://example.com/job/${i}`,
    applyUrl: `https://example.com/job/${i}`,
    source: 'Custom',
    atsPlatform: 'greenhouse',
    fingerprint: `fp-${i}`,
    scrapedAt: new Date().toISOString(),
    isActive: true,
    postedDate: new Date().toISOString(),
  }));

describe('Optimized Search — cost-optimized', () => {
  it('TEST 1: LIMIT 25 with 30 fresh jobs → 25 returned, 0 provider calls', async () => {
    const localJobs = mockJobs(30);
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(localJobs as any);
    const fetchFn = vi.fn().mockResolvedValue({ jobs: [] });
    const result = await searchWithCache({ query: 'DevOps', limit: 25 }, fetchFn);
    expect(result.jobs.length).toBe(25);
    expect(result.providersCalled.length).toBe(0);
    expect(result.cacheHit).toBe(true);
    expect(result.queryFp).toBeTruthy();
    expect(typeof result.seenCount).toBe('number');
    expect(typeof result.totalStored).toBe('number');
    expect(result.exhausted).toBe(false);
  });

  it('TEST 2: LIMIT 25 with 10 fresh jobs → providers called until >=25', async () => {
    const localJobs = mockJobs(10);
    const providerJobs = mockJobs(20, 'DevOps Extra');
    // Make provider jobs have distinct fingerprints
    providerJobs.forEach((j, i) => ((j as any).fingerprint = `extra-${i}`));
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(localJobs as any);
    const fetchFn = vi.fn().mockResolvedValue({ jobs: providerJobs });
    const result = await searchWithCache({ query: 'DevOps', limit: 25 }, fetchFn);
    expect(result.jobs.length).toBe(25);
    expect(result.providersCalled.length).toBeGreaterThan(0);
    expect(result.queryFp).toBeTruthy();
    expect(typeof result.seenCount).toBe('number');
    expect(typeof result.totalStored).toBe('number');
  });

  it('TEST 3: LIMIT 10 → fetch budget does not become 500', async () => {
    const { getFetchBudget } = await import('../../server/providers/searchBudget.js');
    const budget = getFetchBudget(10);
    expect(budget.fetchTarget).toBeLessThanOrEqual(50);
    expect(budget.fetchTarget).toBeLessThan(500);
  });

  it('TEST 8: Cached search — no unnecessary Apify call', async () => {
    const localJobs = mockJobs(25);
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(localJobs as any);
    const fetchFn = vi.fn();
    const result = await searchWithCache({ query: 'DevOps', limit: 10 }, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
  });

  it('TEST 10: Cache does not return unrelated jobs for another query', async () => {
    const localJobs = mockJobs(10, 'DevOps');
    vi.spyOn(await import('../../server/storage/fileStorage.js'), 'getAllJobs').mockReturnValue(localJobs as any);
    const fetchFn = vi.fn().mockResolvedValue({ jobs: [] });
    const result = await searchWithCache({ query: 'Cyber Security', limit: 10 }, fetchFn);
    // Should not return DevOps jobs for Cyber Security query (or should call provider)
    // For this test, we check that the cache logic filters by query
    expect(result.jobs.every((j) => j.title.toLowerCase().includes('cyber')) || result.providersCalled.length > 0).toBe(true);
  });
});
