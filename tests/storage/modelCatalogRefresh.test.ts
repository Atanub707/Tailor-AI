// Auto-refresh release — catalog refresh semantics + background scheduler.
// Pins the behaviors that make the manual button honest and the cron real:
//   force bypasses the TTL, a failed refresh keeps the last good catalog,
//   a missing key is never cached (adding one must fetch immediately), and
//   the scheduler refreshes on boot + every interval, skipping without a key.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-refresh-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { fetchModelCatalog, clearModelCache, CATALOG_TTL_MS, FALLBACK_TTL_MS } = await import('../../server/llm/modelCatalog.js');
const { createModelCatalogScheduler, refreshIntervalMs } = await import('../../server/llm/modelCatalogScheduler.js');

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const payload = (ids: string[]) => ({ object: 'list', data: ids.map((id, i) => ({ id, object: 'model', created: 1700000000 + i, owned_by: 'zen' })) });
const base = { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' };

describe('catalog refresh semantics', () => {
  it('force bypasses the TTL — the Refresh button is never a no-op', async () => {
    clearModelCache();
    let calls = 0;
    const fetcher = async () => { calls++; return { ok: true, json: async () => payload(['m1']) } as any; };
    await fetchModelCatalog(fetcher, base);
    await fetchModelCatalog(fetcher, base);
    expect(calls).toBe(1); // TTL respected without force
    await fetchModelCatalog(fetcher, base, { force: true });
    expect(calls).toBe(2); // forced read hits the provider
  });

  it('a failed forced refresh keeps the last GOOD catalog (stale, with reason)', async () => {
    clearModelCache();
    await fetchModelCatalog(async () => ({ ok: true, json: async () => payload(['good-1', 'good-2']) }) as any, base);
    const failed = await fetchModelCatalog(async () => ({ ok: false, status: 503, json: async () => ({}) }) as any, base, { force: true });
    expect(failed.stale).toBe(true);
    expect(failed.reason).toContain('HTTP 503');
    expect(failed.models.map((m) => m.id)).toEqual(['good-1', 'good-2']); // never blanked
    expect(failed.fetchedAt).toBeTruthy(); // keeps the last good fetch time
    // The good entry survives — a later non-force call still serves it.
    const served = await fetchModelCatalog(async () => { throw new Error('should not be called'); }, base);
    expect(served.models.map((m) => m.id)).toEqual(['good-1', 'good-2']);
    expect(served.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('a missing API key is never cached — adding a key fetches immediately', async () => {
    clearModelCache();
    let calls = 0;
    const fetcher = async () => { calls++; return { ok: true, json: async () => payload(['m1']) } as any; };
    const noKey = await fetchModelCatalog(fetcher, { ...base, apiKey: '' });
    expect(noKey.reason).toBe('NO_API_KEY');
    expect(calls).toBe(0);
    const withKey = await fetchModelCatalog(fetcher, base);
    expect(calls).toBe(1); // not blocked by a cached NO_API_KEY
    expect(withKey.models.map((m) => m.id)).toEqual(['m1']);
  });

  it('concurrent refreshes share one provider call (single-flight)', async () => {
    clearModelCache();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => payload(['m1']) } as any;
    };
    await Promise.all([
      fetchModelCatalog(fetcher, base, { force: true }),
      fetchModelCatalog(fetcher, base, { force: true }),
      fetchModelCatalog(fetcher, base, { force: true }),
    ]);
    expect(calls).toBe(1);
  });

  it('TTL/fallback windows are sane (6h good catalog, 5m outage fallback)', () => {
    expect(CATALOG_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(FALLBACK_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('background scheduler', () => {
  it('refreshes on start and on every interval tick', async () => {
    let calls = 0;
    const s = createModelCatalogScheduler({
      intervalMs: 30,
      config: () => ({ provider: 'opencode-go', apiKey: 'k' }),
      fetchCatalog: async () => { calls++; return { models: [{ id: 'x', created: 0 }], fetchedAt: new Date().toISOString(), ageMs: 0, stale: false, provider: 'opencode-go' }; },
      log: () => {},
    });
    s.start();
    await new Promise((r) => setTimeout(r, 110));
    s.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // immediate + at least one tick
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(after); // stop() really stops
  });

  it('skips silently without an API key — no network, no crash', async () => {
    let calls = 0;
    const logs: string[] = [];
    const s = createModelCatalogScheduler({
      intervalMs: 20,
      config: () => ({ provider: 'opencode-go', apiKey: '' }),
      fetchCatalog: async () => { calls++; return { models: [], fetchedAt: null, ageMs: null, stale: true, reason: 'NO_API_KEY' }; },
      log: (m) => logs.push(m),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 70));
    s.stop();
    expect(calls).toBe(0);
    expect(logs.some((l) => l.includes('no API key'))).toBe(true);
  });

  it('a failing refresh is logged and the loop keeps ticking', async () => {
    let calls = 0;
    const logs: string[] = [];
    const s = createModelCatalogScheduler({
      intervalMs: 20,
      config: () => ({ provider: 'opencode-go', apiKey: 'k' }),
      fetchCatalog: async () => { calls++; return { models: [{ id: 'last-good', created: 0 }], fetchedAt: '2026-01-01T00:00:00Z', ageMs: 1000, stale: true, reason: 'HTTP 503' }; },
      log: (m) => logs.push(m),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 70));
    s.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('keeping last good'))).toBe(true);
  });

  it('interval is env-tunable with a 12h default', () => {
    delete process.env.MODEL_CATALOG_REFRESH_HOURS;
    expect(refreshIntervalMs()).toBe(12 * 3600e3);
    process.env.MODEL_CATALOG_REFRESH_HOURS = '6';
    expect(refreshIntervalMs()).toBe(6 * 3600e3);
    process.env.MODEL_CATALOG_REFRESH_HOURS = '0'; // invalid -> default
    expect(refreshIntervalMs()).toBe(12 * 3600e3);
    delete process.env.MODEL_CATALOG_REFRESH_HOURS;
  });
});

describe('wiring checks', () => {
  it('server exposes ?force on /api/models and starts the scheduler at boot', () => {
    const srv = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(srv).toContain("app.get('/api/models'");
    expect(srv).toContain('req.query.force');
    expect(srv).toContain('createModelCatalogScheduler');
  });

  it('Settings modal fetches with force, revalidates stale catalogs, and shows honesty', () => {
    const scr = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    expect(scr).toContain("'/api/models' + (force ? '?force=1' : '')");
    expect(scr).toContain('formatCatalogAge');
    expect(scr).toContain('Add your API key to load the live catalog');
    expect(scr).toContain('offline, last known list');
  });
});
