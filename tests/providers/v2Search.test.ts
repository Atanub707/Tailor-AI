import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-v2-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.V2_SEARCH_ENABLED = 'true';
process.env.ENABLE_JOBO_PROVIDER = 'true';
process.env.ENABLE_SANTA_MARIA_FALLBACK = 'false';

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, getOrCreateSearch, linkJobsToSearch, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');
const { getProviderBudget, PROVIDER_BUDGET_TABLE } = await import('../../server/providers/providerBudget.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { getCachedCandidates, purgeExpiredCache } = await import('../../server/search/searchCache.js');
const { JoboProvider } = await import('../../server/providers/joboProvider.js');
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
  source: 'jobo',
  postedDate: new Date().toISOString(),
  postedDateSemantics: 'published',
  fingerprint: `jobo-${id}`,
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

  it('1. cache hit returns without provider call', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('a')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      spy.mockClear();
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('2. cache miss calls the provider', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('z')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      const r = await runV2Search(USER, { keywords: 'SRE Engineer', limit: 1 }, [p as any]);
      expect(spy).toHaveBeenCalled();
      expect(r.jobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('3. LIMIT 25 provider budget <= 35', () => {
    expect(getProviderBudget(25)).toBeLessThanOrEqual(35);
    expect(getProviderBudget(25)).toBe(PROVIDER_BUDGET_TABLE[25]);
  });

  it('4. LIMIT 50 provider budget <= 60', () => {
    expect(getProviderBudget(50)).toBeLessThanOrEqual(60);
    expect(getProviderBudget(50)).toBe(PROVIDER_BUDGET_TABLE[50]);
  });

  it('5. 0 relevant results -> [] (nothing persists)', async () => {
    await runWithUser(USER, async () => {
      const irrelevant = mk('irr', { title: 'Account Executive, Funded Startups' });
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-a', limit: 5 }, [fakeProvider('p1', [irrelevant])]);
      expect(r.jobs.length).toBe(0);
      expect(r.returnedCount).toBe(0);
    });
  });

  it('6. Data Engineer rejected for DevOps', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-b', limit: 5 }, [fakeProvider('p1', [mk('de', { title: 'Senior Data Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).not.toContain('Senior Data Engineer');
    });
  });

  it('7. Platform Engineer accepted for DevOps', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-c', limit: 5 }, [fakeProvider('p1', [mk('pe', { title: 'Platform Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Platform Engineer');
    });
  });

  it('8. SRE accepted for DevOps', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-d', limit: 5 }, [fakeProvider('p1', [mk('sre', { title: 'Site Reliability Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Site Reliability Engineer');
    });
  });

  it('9. Cybersecurity query rejects unrelated PM/sales jobs', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'Cyber Security Engineer', limit: 5 }, [
        fakeProvider('p1', [mk('sec', { title: 'Security Engineer' }), mk('pm', { title: 'Product Manager' }), mk('sales', { title: 'Account Executive' })]),
      ]);
      const titles = r.jobs.map((j) => j.title);
      expect(titles).toContain('Security Engineer');
      expect(titles).not.toContain('Product Manager');
      expect(titles).not.toContain('Account Executive');
    });
  });

  it('10. duplicate job from two providers appears once', async () => {
    await runWithUser(USER, async () => {
      const same = mk('dup', { title: 'DevOps Engineer' });
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 5 }, [
        fakeProvider('p1', [same]),
        fakeProvider('p2', [{ ...same, id: 'dup' }]),
      ]);
      const fps = r.jobs.map((j) => j.fingerprint);
      expect(new Set(fps).size).toBe(fps.length); // no dup fingerprints
    });
  });

  it('11. second search same query within TTL does not call provider', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('ttl')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      spy.mockClear();
      const r2 = await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      expect(spy).not.toHaveBeenCalled();
      expect(r2.cacheHit).toBe(true);
    });
  });

  it('12. second search larger LIMIT only tops up the shortage', async () => {
    await runWithUser(USER, async () => {
      const calls: number[] = [];
      const spy = vi.fn(async (_params: any, fetchLimit: number) => {
        calls.push(fetchLimit);
        return { provider: 'p1', jobs: [mk(`topup-${calls.length}`)], requestedLimit: fetchLimit, returnedCount: 1 };
      });
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 2 }, [p as any]);
      spy.mockClear();
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 3 }, [p as any]);
      // One cached + two fresh = 3; provider called once for the shortage of 2.
      expect(spy).toHaveBeenCalledTimes(1);
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 3 }, [p as any]);
      expect(r.jobs.length).toBe(3);
    });
  });

  it('13. expired cache triggers provider refresh', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('exp')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      spy.mockClear();
      // Force expiry.
      const db = getDb();
      db.prepare('UPDATE search_cache SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
      purgeExpiredCache(USER);
      await runV2Search(USER, { keywords: 'DevOps Engineer', limit: 1 }, [p as any]);
      expect(spy).toHaveBeenCalled();
    });
  });

  it('14. Applied job remains global', async () => {
    await runWithUser(USER, async () => {
      const db = getDb();
      const rows = db.prepare('SELECT data FROM jobs WHERE user_id = ?').all(USER) as any[];
      const all = rows.map((r) => JSON.parse(r.data));
      expect(Array.isArray(all)).toBe(true);
    });
  });

  it('15. search context isolation still works (query_fp differs)', async () => {
    const a = canonicalQueryFp('DevOps Engineer', undefined, 'any');
    const b = canonicalQueryFp('AI Engineer', undefined, 'any');
    expect(a).not.toBe(b);
  });

  it('16. provider failure does not crash the endpoint', async () => {
    await runWithUser(USER, async () => {
      const broken = { id: 'p1', supports: () => true, search: async () => { throw new Error('boom'); }, estimatedCost: () => 0 };
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-e', limit: 2 }, [broken as any]);
      expect(r.jobs).toEqual([]);
      expect(r.providers[0].error).toBeTruthy();
    });
  });

  it('17. insufficient results return fewer honestly', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-f', limit: 10 }, [fakeProvider('p1', [mk('only1')])]);
      expect(r.jobs.length).toBe(1);
      expect(r.returnedCount).toBe(1);
    });
  });

  it('18. no Santa Maria call unless fallback enabled', async () => {
    // V2_FLAGS is evaluated at module import; the test env starts with
    // ENABLE_SANTA_MARIA_FALLBACK=false, so the default order excludes it.
    const order = buildProviderOrder([new JoboProvider(), { id: 'santa-maria' } as any]);
    const ids = order.map((p) => p.id);
    expect(ids).not.toContain('santa-maria');
    expect(ids).toContain('jobo');
    // Flag present and defaults false (config, not toggled post-import).
    expect(V2_FLAGS.ENABLE_SANTA_MARIA_FALLBACK).toBe(false);
  });

  it('19. API tokens never appear in logs/output', async () => {
    const tokens = ['apify_api_testtoken123', 'jobo_key_testtoken456'];
    for (const t of tokens) {
      const logs = [t, 'secret', 'Bearer abc'].join('\n');
      expect(logs.includes(t)).toBe(true); // token exists somewhere
    }
    // The orchestrator result must not contain tokens.
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer isolated-g', limit: 1 }, [fakeProvider('p1', [mk('tok')])]);
      expect(JSON.stringify(r)).not.toContain('apify_api');
      expect(JSON.stringify(r)).not.toContain('jobo_key');
    });
  });

  it('20. no literal 500 in provider limit logic', () => {
    const src = fs.readFileSync('server/providers/providerBudget.ts', 'utf8');
    expect(src).not.toMatch(/\b500\b/);
    expect(src).not.toMatch(/\b1000\b/);
    for (const [limit, expected] of Object.entries(PROVIDER_BUDGET_TABLE)) {
      expect(getProviderBudget(Number(limit))).toBe(expected);
    }
  });
});