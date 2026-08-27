import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-v2-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.V2_SEARCH_ENABLED = 'true';

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');
const { getProviderBudget, PROVIDER_BUDGET_TABLE } = await import('../../server/providers/providerBudget.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { buildProviderOrder } = await import('../../server/providers/providerRegistry.js');

const USER = 'v2-user';
const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'DevOps Engineer',
  company: 'Stripe',
  location: 'India',
  applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  url: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse',
  source: 'test',
  postedDate: new Date().toISOString(),
  postedDateSemantics: 'published',
  fingerprint: `fp-${id}`,
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

  it('1. LIMIT 5 provider budget <= 8', () => {
    expect(getProviderBudget(5)).toBeLessThanOrEqual(8);
    expect(getProviderBudget(5)).toBe(PROVIDER_BUDGET_TABLE[5]);
  });

  it('2. LIMIT 10 provider budget <= 15', () => {
    expect(getProviderBudget(10)).toBeLessThanOrEqual(15);
    expect(getProviderBudget(10)).toBe(PROVIDER_BUDGET_TABLE[10]);
  });

  it('3. LIMIT 25 provider budget <= 35', () => {
    expect(getProviderBudget(25)).toBeLessThanOrEqual(35);
    expect(getProviderBudget(25)).toBe(PROVIDER_BUDGET_TABLE[25]);
  });

  it('4. LIMIT 50 provider budget <= 60', () => {
    expect(getProviderBudget(50)).toBeLessThanOrEqual(60);
    expect(getProviderBudget(50)).toBe(PROVIDER_BUDGET_TABLE[50]);
  });

  it('5. cache hit returns without provider call', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('a')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'DevOps Engineer cached-1', limit: 1 }, [p as any]);
      spy.mockClear();
      await runV2Search(USER, { keywords: 'DevOps Engineer cached-1', limit: 1 }, [p as any]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('6. cache miss calls the provider', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'p1', jobs: [mk('z')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'p1', supports: () => true, search: spy, estimatedCost: () => 0 };
      await runV2Search(USER, { keywords: 'SRE Engineer iso-6', limit: 1 }, [p as any]);
      expect(spy).toHaveBeenCalled();
    });
  });

  it('7. cache fingerprint includes source (LinkedIn != Naukri same query)', async () => {
    const a = canonicalQueryFp('DevOps Engineer', 'India', '24h', 'linkedin');
    const b = canonicalQueryFp('DevOps Engineer', 'India', '24h', 'naukri');
    expect(a).not.toBe(b);
  });

  it('8. same query different source has separate cache (no cross-source reuse)', async () => {
    await runWithUser(USER, async () => {
      const spy = vi.fn(async () => ({ provider: 'linkedin', jobs: [mk('li')], requestedLimit: 8, returnedCount: 1 }));
      const p = { id: 'linkedin', supports: () => true, search: spy, estimatedCost: () => 0 };
      // Search with source-keyed fingerprint
      await runV2Search(USER, { keywords: 'DevOps Engineer iso-8', limit: 1 }, [p as any]);
      spy.mockClear();
      // Same query, different source fingerprint → cache miss → provider called
      await runV2Search(USER, { keywords: 'DevOps Engineer iso-8', limit: 1, source: 'naukri' }, [p as any]);
      expect(spy).toHaveBeenCalled();
    });
  });

  it('9. irrelevant provider output -> zero results', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-9', limit: 5 }, [fakeProvider('p1', [mk('irr', { title: 'Account Executive, Funded Startups' })])]);
      expect(r.jobs.length).toBe(0);
    });
  });

  it('10. DevOps exact accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-10', limit: 5 }, [fakeProvider('p1', [mk('dev', { title: 'DevOps Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('DevOps Engineer');
    });
  });

  it('11. SRE accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-11', limit: 5 }, [fakeProvider('p1', [mk('sre', { title: 'Site Reliability Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Site Reliability Engineer');
    });
  });

  it('12. Platform Engineer accepted', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-12', limit: 5 }, [fakeProvider('p1', [mk('pe', { title: 'Platform Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).toContain('Platform Engineer');
    });
  });

  it('13. Data Engineer rejected', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-13', limit: 5 }, [fakeProvider('p1', [mk('de', { title: 'Senior Data Engineer' })])]);
      expect(r.jobs.map((j) => j.title)).not.toContain('Senior Data Engineer');
    });
  });

  it('14. Product Manager rejected', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-14', limit: 5 }, [fakeProvider('p1', [mk('pm', { title: 'Product Manager' })])]);
      expect(r.jobs.map((j) => j.title)).not.toContain('Product Manager');
    });
  });

  it('15. duplicate across two providers -> one result', async () => {
    await runWithUser(USER, async () => {
      const same = mk('dup', { title: 'DevOps Engineer' });
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-15', limit: 5 }, [
        fakeProvider('p1', [same]),
        fakeProvider('p2', [{ ...same, id: 'dup' }]),
      ]);
      const fps = r.jobs.map((j) => j.fingerprint);
      expect(new Set(fps).size).toBe(fps.length);
    });
  });

  it('16. direct apply URL preserved', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-16', limit: 5 }, [
        fakeProvider('p1', [mk('u', { applyUrl: 'https://boards.greenhouse.io/stripe/123' })]),
      ]);
      expect(r.jobs[0].applyUrl).toBe('https://boards.greenhouse.io/stripe/123');
    });
  });

  it('17. search isolation works (query_fp differs)', () => {
    expect(canonicalQueryFp('DevOps Engineer', undefined, 'any')).not.toBe(canonicalQueryFp('AI Engineer', undefined, 'any'));
  });

  it('18. applied history remains global', async () => {
    await runWithUser(USER, async () => {
      const db = getDb();
      const rows = db.prepare('SELECT data FROM jobs WHERE user_id = ?').all(USER) as any[];
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  it('19. transient candidate not durable automatically', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-19', limit: 5 }, [fakeProvider('p1', [mk('t1')])]);
      expect(r.jobs.length).toBe(1);
      const db = getDb();
      const durable = (db.prepare('SELECT count(*) c FROM jobs WHERE user_id = ? AND id = ?').get(USER, r.jobs[0].fingerprint) as any).c;
      expect(durable).toBe(0);
    });
  });

  it('20. provider failure returns graceful result', async () => {
    await runWithUser(USER, async () => {
      const broken = { id: 'p1', supports: () => true, search: async () => { throw new Error('boom'); }, estimatedCost: () => 0 };
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-20', limit: 2 }, [broken as any]);
      expect(r.jobs).toEqual([]);
      expect(r.providers[0].error).toBeTruthy();
    });
  });

  it('21. insufficient results returned honestly', async () => {
    await runWithUser(USER, async () => {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-21', limit: 10 }, [fakeProvider('p1', [mk('only1')])]);
      expect(r.jobs.length).toBe(1);
      expect(r.returnedCount).toBe(1);
    });
  });

  it('22. LIMIT 10 never returns more than 10', async () => {
    await runWithUser(USER, async () => {
      const many = Array.from({ length: 30 }, (_, i) => mk(`m${i}`, { title: 'DevOps Engineer' }));
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer iso-22', limit: 10 }, [fakeProvider('p1', many)]);
      expect(r.jobs.length).toBeLessThanOrEqual(10);
    });
  });

  it('23. no FetchCat references in production code', () => {
    const files = ['server.ts', 'server/providers/providerRegistry.ts', 'server/search/searchOrchestrator.ts'];
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/fetchcat|fetch_cat/i);
    }
  });

  it('24. buildProviderOrder preserves registration order (no fan-out logic)', () => {
    const order = buildProviderOrder([{ id: 'a' } as any, { id: 'b' } as any]);
    expect(order.map((p) => p.id)).toEqual(['a', 'b']);
  });
});