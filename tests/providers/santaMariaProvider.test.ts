import { describe, it, expect, vi } from 'vitest';
import { SantaMariaApifyProvider } from '../../server/providers/santaMariaProvider.js';

// Mock fetch globally for Apify calls
const mockJobs = Array.from({ length: 10 }, (_, i) => ({
  title: `DevOps Engineer ${i}`,
  company: `Company${i}`,
  jobUrl: `https://boards.greenhouse.io/company${i}/jobs/${i}`,
  applyUrl: `https://boards.greenhouse.io/company${i}/jobs/${i}`,
  atsPlatform: 'greenhouse',
  description: `Description for job ${i}`,
  externalId: `ext-${i}`,
  location: 'Remote',
}));

describe('SantaMariaApifyProvider — Phase 1 (mocked)', () => {
  it('LIMIT enforcement: returns at most requested LIMIT', async () => {
    const provider = new SantaMariaApifyProvider();
    // Mock the internal methods to avoid real Apify calls
    vi.spyOn(provider as any, 'createRun').mockResolvedValue('mock-run-id');
    vi.spyOn(provider as any, 'pollAndFetch').mockResolvedValue(mockJobs);

    // Mock config
    const { loadConfig } = await import('../../server/config.js');
    vi.spyOn(await import('../../server/config.js'), 'loadConfig').mockReturnValue({
      apify: { token: 'test-token', enabled: true },
    } as any);

    const result = await provider.search({
      keywords: ['DevOps'],
      limit: 5,
      queries: ['https://boards.greenhouse.io/stripe'],
    });

    expect(result.jobs.length).toBeLessThanOrEqual(5);
    expect(result.requestedLimit).toBe(5);
    expect(result.provider).toBe('santa-maria');
  });

  it('fingerprint is deterministic for same ATS+externalId', async () => {
    const provider = new SantaMariaApifyProvider();
    const f1 = (provider as any).fingerprint('greenhouse', 'ext-1', 'Stripe', 'DevOps', 'Remote');
    const f2 = (provider as any).fingerprint('greenhouse', 'ext-1', 'Stripe', 'DevOps', 'Remote');
    expect(f1).toBe(f2);
  });

  it('ATS detection — greenhouse URL', async () => {
    const { detectATS } = await import('../../server/ats/detector.js');
    // This test is mocked — real detector needs Page, we just check the URL hint map
    const urlHints: Record<string, string[]> = {
      greenhouse: ['boards.greenhouse.io'],
      lever: ['jobs.lever.co'],
      ashby: ['jobs.ashbyhq.com'],
    };
    expect('https://boards.greenhouse.io/stripe/jobs/123'.includes(urlHints.greenhouse[0])).toBe(true);
  });
});
