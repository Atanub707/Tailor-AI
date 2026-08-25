import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SantaMariaApifyProvider } from '../../server/providers/santaMariaProvider.js';
import { getFetchBudget, getProviderFetchLimit } from '../../server/providers/searchBudget.js';
import * as configModule from '../../server/config.js';

// ── Budget unit test: LIMIT → central budget (searchBudget.ts) ──
describe('searchBudget — central fetch budget (no magic numbers)', () => {
  const cases: Array<[number, number]> = [
    [5, 8],
    [10, 15],
    [25, 38],
    [50, 50],
  ];

  for (const [limit, expected] of cases) {
    it(`LIMIT ${limit} → fetch budget ${expected}`, () => {
      const budget = getFetchBudget(limit);
      expect(budget.fetchTarget).toBe(expected);
    });
  }

  it('Santa Maria provider limit never exceeds ATS_MAX_RAW_RESULTS (50)', () => {
    for (const limit of [5, 10, 25, 50]) {
      expect(getProviderFetchLimit(limit, 'santa-maria')).toBeLessThanOrEqual(50);
    }
  });
});

// ── Regression: Santa Maria input NEVER contains 500 ──
describe('Santa Maria — maxJobsPerCompany comes ONLY from the central budget', () => {
  let capturedInputs: Array<{ maxJobsPerCompany: number; limit: number }> = [];

  function spyProvider() {
    const provider = new SantaMariaApifyProvider();
    // Mock the Apify client so NO live call happens; capture the input
    vi.spyOn(provider as any, 'createRun').mockImplementation(async (token: string, input: any) => {
      capturedInputs.push({ maxJobsPerCompany: input.maxJobsPerCompany, limit: input.limit ?? -1 });
      return 'mock-run-id';
    });
    vi.spyOn(provider as any, 'pollAndFetch').mockResolvedValue([]);
    return provider;
  }

  beforeEach(() => {
    capturedInputs = [];
    vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      apify: { token: 'test-token', enabled: true },
    } as any);
  });

  for (const limit of [5, 10, 25, 50]) {
    it(`LIMIT ${limit} → maxJobsPerCompany ≤ expected budget, mocked (0 live calls)`, async () => {
      const provider = spyProvider();
      const expected = getProviderFetchLimit(limit, 'santa-maria');

      await provider.search({
        keywords: ['DevOps'],
        limit,
        queries: ['https://boards.greenhouse.io/stripe'],
      });

      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0].maxJobsPerCompany).toBe(expected);
      expect(capturedInputs[0].maxJobsPerCompany).toBeLessThanOrEqual(50);
      expect(capturedInputs[0].maxJobsPerCompany).toBeLessThan(500);
    });
  }

  it('REGRESSION: maxJobsPerCompany can NEVER be 500 for LIMIT 5/10/25/50', async () => {
    for (const limit of [5, 10, 25, 50]) {
      const provider = spyProvider();
      await provider.search({ keywords: ['DevOps'], limit, queries: ['https://boards.greenhouse.io/stripe'] });
      expect(capturedInputs[capturedInputs.length - 1].maxJobsPerCompany).not.toBe(500);
    }
  });
});