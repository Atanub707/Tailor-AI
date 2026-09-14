// Live model catalog — the Settings UI stops hardcoding model lists.
//
// OpenAI-compatible providers (opencode-go / openrouter / openai / nvidia)
// expose GET {baseUrl}/models, and their catalogs are maintained by the
// provider's own servers (OpenCode adds/deprecates models weekly). We
// fetch that catalog, cache it briefly (6h), and fall back to the static
// preset list when the fetch fails — the app never breaks offline and
// never needs a code edit when new models appear.
//
// Refresh semantics (auto-refresh release):
//   * `opts.force` bypasses the TTL read — the manual Refresh button and the
//     background scheduler use it, so a click (or a tick) can never be a
//     silent no-op.
//   * A FAILED refresh never replaces a good catalog — callers get the last
//     good list marked `stale` (with the failure reason), and the good entry
//     stays cached for the next attempt. A fallback is only cached briefly
//     (FALLBACK_TTL_MS) and only when no good catalog exists yet.
//   * NO_API_KEY / PROVIDER_NON_COMPATIBLE are never cached: the moment the
//     user adds a key (or switches provider), the next call must fetch.
//   * Concurrent refreshes share one provider call (single-flight) — three
//     open tabs can never fan out into three /models requests.
//   * `ageMs` tells the UI how old the shown catalog is (null = never
//     fetched, i.e. fallback).

import type { LlmProvider } from '../../src/types.js';
import { PROVIDER_BASE_URLS, PROVIDER_FALLBACK_MODELS } from '../../src/constants/llmPresets.js';
import { loadConfig } from '../config.js';

export interface CatalogModel {
  id: string;
  created: number;
  owned_by?: string;
}

export interface ModelCatalog {
  models: CatalogModel[];
  fetchedAt: string | null;
  /** How old the shown catalog is, in ms. null = never fetched (fallback). */
  ageMs: number | null;
  stale: boolean;
  reason?: string;
  provider?: string;
}

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Short cache for a fallback with no good catalog to fall back on — long
 *  enough to avoid hammering a down provider, short enough to recover. */
export const FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;

const OPENAI_COMPATIBLE: LlmProvider[] = ['opencode-go', 'openrouter', 'openai', 'nvidia'];

export function isOpenAiCompatible(p: string): boolean {
  return (OPENAI_COMPATIBLE as string[]).includes(p);
}

interface CacheEntry {
  at: number;
  value: ModelCatalog;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ModelCatalog>>();

function fallback(provider: string, reason: string): ModelCatalog {
  const ids = PROVIDER_FALLBACK_MODELS[provider as LlmProvider] || [];
  return {
    models: ids.filter((id) => id !== 'Custom (type below)').map((id) => ({ id, created: 0, owned_by: 'fallback' })),
    fetchedAt: null,
    ageMs: null,
    stale: true,
    reason,
    provider,
  };
}

export interface FetchCatalogOptions {
  /** Bypass the TTL read (Refresh button / background scheduler). Still writes. */
  force?: boolean;
}

export async function fetchModelCatalog(
  fetcher: typeof fetch = fetch,
  overrides?: { provider?: string; baseUrl?: string; apiKey?: string },
  opts: FetchCatalogOptions = {},
): Promise<ModelCatalog> {
  let provider: string;
  let baseUrl: string;
  let apiKey: string;
  if (overrides) {
    provider = overrides.provider ?? 'opencode-go';
    baseUrl = overrides.baseUrl ?? '';
    apiKey = overrides.apiKey ?? '';
  } else {
    const config = loadConfig();
    provider = String(config?.llm?.provider ?? 'opencode-go');
    baseUrl = config?.llm?.baseUrl ?? '';
    apiKey = config?.llm?.apiKey ?? '';
  }
  baseUrl = (baseUrl || PROVIDER_BASE_URLS[provider as LlmProvider] || '').replace(/\/+$/, '');

  // Never cached: adding a key or switching provider must fetch immediately.
  if (!apiKey) return fallback(provider, 'NO_API_KEY');
  if (!isOpenAiCompatible(provider)) return fallback(provider, 'PROVIDER_NON_COMPATIBLE');

  const cacheKey = `${provider}|${baseUrl}`;
  const hit = cache.get(cacheKey);
  if (!opts.force && hit && Date.now() - hit.at < hit.ttlMs) {
    return { ...hit.value, ageMs: Date.now() - hit.at };
  }

  // Single-flight: concurrent refreshes share ONE provider call.
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const run = (async (): Promise<ModelCatalog> => {
    try {
      const res = await fetcher(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return failedFallback(cacheKey, provider, `HTTP ${res.status}`, hit);
      const j: any = await res.json();
      const models = (Array.isArray(j?.data) ? j.data : [])
        .map((m: any) => ({ id: String(m?.id ?? ''), created: Number(m?.created ?? 0), owned_by: String(m?.owned_by ?? '') }))
        .filter((m) => m.id.length > 0);
      if (!models.length) return failedFallback(cacheKey, provider, 'EMPTY', hit);
      const value: ModelCatalog = { models, fetchedAt: new Date().toISOString(), ageMs: 0, stale: false, provider };
      cache.set(cacheKey, { at: Date.now(), value, ttlMs: CATALOG_TTL_MS });
      return value;
    } catch (err: any) {
      return failedFallback(cacheKey, provider, String(err?.message || 'NETWORK').slice(0, 140), hit);
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, run);
  return run;
}

/** A failed refresh keeps the last GOOD catalog when one exists (marked
 *  stale + reason); otherwise a fallback is cached briefly and returned. */
function failedFallback(cacheKey: string, provider: string, reason: string, prior?: CacheEntry): ModelCatalog {
  if (prior && !prior.value.stale) {
    return { ...prior.value, stale: true, reason, ageMs: Date.now() - prior.at };
  }
  const out = fallback(provider, reason);
  cache.set(cacheKey, { at: Date.now(), value: out, ttlMs: FALLBACK_TTL_MS });
  return out;
}

export function clearModelCache(): void {
  cache.clear();
  inFlight.clear();
}
