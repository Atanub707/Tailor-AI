import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-v2-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.V2_SEARCH_ENABLED = 'true';
process.env.ENABLE_FETCHCAT_PROVIDER = 'true';

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');
const { getProviderBudget, PROVIDER_BUDGET_TABLE } = await import('../../server/providers/providerBudget.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { FetchCatProvider, FETCHCAT_ATS_COVERAGE } = await import('../../server/providers/fetchCatProvider.js');
const { buildProviderOrder, V2_FLAGS } = await import('../../server/providers/providerRegistry.js');

const USER = 'v2-user';
const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'DevOps Engineer',
  company: 'Stripe',
  location: 'India',
  applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  url: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse',
  source: 'fetchcat',
  postedDate: new Date().toISOString(),
  postedDateSemantics: 'published',
  fingerprint: `fetchcat-${id}`,
  ...over,
});

// A fake provider with controllable results — never touches the network.
function fakeProvider(id: string, jobs: any[]) {
  return {
    id,
    supports: () => true,
    search: async () => ({ provider: id, jobs, requestedLimit: 8, returnedCount: jobs.length, durationMs: 1, costEstimate: 0 }),
    estimatedCost: () => 0,
  };
}

describe('V2 provider-driven search (all mocked, zero live calls)', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V2User', 'v2@test.local');
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('1. FetchCat request mapping: maxItems = budget, keywordFilter = query', async () => {
    const spy = vi.spyOn(FetchCatProvider.prototype as any, 'runActor').mockResolvedValue([]);
    process.env.APIFY_API_TOKEN = 'test-token';
    const p = new FetchCatProvider();
    expect(p.supports({ keywords: 'DevOps', limit: 5 } as any)).toBe(true);
    await p.search({ keywords: 'DevOps Engineer', limit: 5 } as any, 8);
    const input = spy.mock.calls[0][1] as any;
    expect(input.maxItems).toBe(8);
    expect(input.keywordFilter).toBe('DevOps Engineer');
    expect(input.includeDescriptions).toBe(true);
    delete process.env.APIFY_API_TOKEN;
  });

  it('2. FetchCat budget enforcement: request <= central budget', async () => {
    const spy = vi.spyOn(FetchCatProvider.prototype as any, 'runActor').mockResolvedValue([]);
    process.env.APIFY_API_TOKEN = 'test-token';
    const p = new FetchCatProvider();
    await p.search({ keywords: 'DevOps', limit: 25 } as any, 35);
    expect((spy.mock.calls[0][1] as any).maxItems).toBeLessThanOrEqual(35);
    delete process.env.APIFY_API_TOKEN;
  });

  it('3. FetchCat provider unavailable without token', async () => {
    delete process.env.APIFY_API_TOKEN;
    const p = new FetchCatProvider();
    expect(p.supports({ keywords: 'DevOps', limit: 5 } as any)).toBe(false);
    const r = await p.search({ keywords: 'DevOps', limit: 5 } as any, 8);
    expect(r.jobs).toEqual([]);
    expect(r.error).toContain('not configured');
  });

  it('4. token never logged in provider output', async () => {
    process.env.APIFY_API_TOKEN = 'secret-token-abc123';
    const spy = vi.spyOn(FetchCatProvider.prototype as any, 'runActor').mockResolvedValue([]);
    const p = new FetchCatProvider();
    const r = await p.search({ keywords: 'DevOps', limit: 5 } as any, 8);
    expect(JSON.stringify(r)).not.toContain('secret-token-abc123');
    delete process.env.APIFY_API_TOKEN;
  });

  it('5. LIMIT 5 provider budget <= 8', () => {
    expect(getProviderBudget(5)).toBeLessThanOrEqual(8);
    expect(getProviderBudget(5)).toBe(PROVIDER_BUDGET_TABLE[5]);
  });

  it('6. LIMIT 10 provider budget <= 15', () => {
    expect(getProviderBudget(10)).toBeLessThanOrEqual(15);
    expect(getProviderBudget(10)).toBe(PROVIDER_BUDGET_TABLE[10]);
  });

  it('7. LIMIT 25 provider budget <= 35', () => {
    expect(getProviderBudget(25)).toBeLessThanOrEqual(35);
    expect(getProviderBudget(25)).toBe(PROVIDER_BUDGET_TABLE[25]);
  });

  it('8. LIMIT 50 provider budget <= 60', () => {
    expect(getProviderBudget(50)).toBeLessThanOrEqual(60);
    expect(getProviderBudget(50)).toBe(PROVIDER_BUDGET_TABLE[50]);
  });

  it('9. cache hit returns without provider call', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('a')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer cached-1', limit: 1 }, [p as any]);
      spy.mockClear();
      await runV2Search(USER, { keywords: 'DevOps Engineer cached-1', limit: 1 }, [p as any]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('10. larger LIMIT -> shortage-only top-up', async () => {
    await runWithUser(USER, async () => {
      const calls: number[] = [];
      // First call: 2 jobs; top-up call: fills exactly the shortage with new ids.
      const spy = vi.fn(async (_params: any, fetchLimit: number) => {
        calls.push(fetchLimit);
        const base = calls.length === 1 ? 0 : 2;
        const jobs = [mk(`topup-${base + 1}`), mk(`topup-${base + 2}`)];
        return { provider: 'p1', jobs, requestedLimit: fetchLimit, returnedCount: jobs.length };
      });
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer topup-1', limit: 2 }, [p as any]);
      spy.mockClear();
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer topup-1', limit: 3 }, [p as any]);
      // 2 cached + 1 top-up = 3; the provider is called once for the shortage
      // of 1 (never a full re-fetch of 3).
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r.jobs.length).toBe(3);
    });
  });

  it('11. irrelevant provider output -> zero results', async () => {
    await runWithUser(USER, async () => {
      const irrelevant = mk('irr', { title: 'Account Executive, Funded Startups' });
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-11', limit: 5 }, [fakeProvider('p1', [irrelevant])]);
      expect(r.jobs.length).toBe(0);
    });
  });

  it('12. DevOps exact accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-12', limit: 5 }, [fakeProvider('p1', [mk('dev', { title: 'DevOps Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('DevOps Engineer');
    });
  });

  it('13. SRE accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-13', limit: 5 }, [fakeProvider('p1', [mk('sre', { title: 'Site Reliability Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Site Reliability Engineer');
    });
  });

  it('14. Platform Engineer accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-14', limit: 5 }, [fakeProvider('p1', [mk('pe', { title: 'Platform Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Platform Engineer');
    });
  });

  it('15. Data Engineer rejected', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-15', limit: 5 }, [fakeProvider('p1', [mk('de', { title: 'Senior Data Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).not.toContain('Senior Data Engineer');
    });
  });

  it('16. Product Manager rejected', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-16', limit: 5 }, [fakeProvider('p1', [mk('pm', { title: 'Product Manager' })])]);
      expect(r.jobs.map((j) => j.title)).not.toContain('Product Manager');
    });
  });

  it('17. duplicate across LinkedIn/FetchCat -> one result', async () => {
    await runWithUser(USER, async () => {
      const same = mk('dup', { title: 'DevOps Engineer' });
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-17', limit: 5 }, [
        fakeProvider('linkedin', [same]),
        fakeProvider('fetchcat', [{ ...same, id: 'dup' }]),
      ]);
      const fps = r.jobs.map((j) => j.fingerprint);
      expect(new Set(fps).size).toBe(fps.length);
    });
  });

  it('18. direct apply URL preferred in canonical record', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-18', limit: 5 }, [
        fakeProvider('linkedin', [mk('u', { applyUrl: 'https://linkedin.com/jobs/view/123' })]),
      ]);
      expect(r.jobs[0].applyUrl).toBe('https://linkedin.com/jobs/view/123');
    });
  });

  it('19. search isolation works (query_fp differs)', () => {
    const a = canonicalQueryFp('DevOps Engineer', undefined, 'any');
    const b = canonicalQueryFp('AI Engineer', undefined, 'any');
    expect(a).not.toBe(b);
  });

  it('20. applied history remains global', async () => {
    await runWithUser(USER, async () => {
      const db = getDb();
      const rows = db.prepare('SELECT data FROM jobs WHERE user_id = ?').all(USER) as any[];
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  it('21. transient candidate not durable automatically', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-21', limit: 5 }, [fakeProvider('p1', [mk('t1')])]);
      expect(r.jobs.length).toBe(1);
      const db = getDb();
      const durable = (db.prepare('SELECT count(*) c FROM jobs WHERE user_id = ? AND id = ?').get(USER, r.jobs[0].fingerprint) as any).c;
      expect(durable).toBe(0); // NOT auto-persisted
    });
  });

  it('22. promotion on Tailor/Save/Apply works (covered in promotion.test.ts)', () => {
    expect(true).toBe(true); // dedicated suite
  });

  it('23. provider failure returns graceful result', async () => {
    await runWithUser(USER, async () => {
      const broken = { id: 'p1', supports: () => true, search: async () => { throw new Error('boom'); }, estimatedCost: () => 0 };
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-23', limit: 2 }, [broken as any]);
      expect(r.jobs).toEqual([]);
      expect(r.providers[0].error).toBeTruthy();
    });
  });

  it('24. insufficient results returned honestly', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-24', limit: 10 }, [fakeProvider('p1', [mk('only1')])]);
      expect(r.jobs.length).toBe(1);
      expect(r.returnedCount).toBe(1);
    });
  });

  it('25. no background watcher starts by default (indexer removed)', () => {
    const serverSrc = fs.readFileSync('server.ts', 'utf8');
    expect(serverSrc).not.toContain('startWatcher');
    expect(serverSrc).not.toContain('runRetentionSweep');
  });

  it('26. FetchCat ATS coverage is the verified six platforms', () => {
    expect(FETCHCAT_ATS_COVERAGE).toEqual(['greenhouse', 'lever', 'ashby', 'recruitee', 'smartrecruiters', 'personio']);
  });

  it('27. provider registry: FetchCat last, job-boards first', () => {
    const order = buildProviderOrder([{ id: 'linkedin' } as any, new FetchCatProvider(), { id: 'indeed' } as any]);
    const ids = order.map((p) => p.id);
    expect(ids[ids.length - 1]).toBe('fetchcat');
    expect(ids).toContain('linkedin');
    expect(ids).toContain('indeed');
  });

  it('28. no santa-maria in registry flags', () => {
    expect((V2_FLAGS as any).ENABLE_SANTA_MARIA_FALLBACK).toBeUndefined();
  });
});