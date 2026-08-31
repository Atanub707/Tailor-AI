// Live model catalog — the Settings UI stops hardcoding model lists.
//
// OpenAI-compatible providers (opencode-go / openrouter / openai / nvidia)
// expose GET {baseUrl}/models, and their catalogs are maintained by the
// provider's own servers (OpenCode adds/deprecates models weekly). We
// fetch that catalog, cache it briefly (6h), and fall back to the static
// preset list when the fetch fails — the app never breaks offline and
// never needs a code edit when new models appear.

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
  stale: boolean;
  reason?: string;
  provider?: string;
}

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 10_000;

const OPENAI_COMPATIBLE: LlmProvider[] = ['opencode-go', 'openrouter', 'openai', 'nvidia'];

export function isOpenAiCompatible(p: string): boolean {
  return (OPENAI_COMPATIBLE as string[]).includes(p);
}

const cache = new Map<string, { at: number; value: ModelCatalog }>();

function fallback(provider: string, reason: string): ModelCatalog {
  const ids = PROVIDER_FALLBACK_MODELS[provider as LlmProvider] || [];
  return {
    models: ids.filter((id) => id !== 'Custom (type below)').map((id) => ({ id, created: 0, owned_by: 'fallback' })),
    fetchedAt: null,
    stale: true,
    reason,
    provider,
  };
}

export async function fetchModelCatalog(
  fetcher: typeof fetch = fetch,
  overrides?: { provider?: string; baseUrl?: string; apiKey?: string },
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

  if (!apiKey) return fallback(provider, 'NO_API_KEY');
  if (!isOpenAiCompatible(provider)) return fallback(provider, 'PROVIDER_NON_COMPATIBLE');

  const cacheKey = `${provider}|${baseUrl}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;

  try {
    const res = await fetcher(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const out = fallback(provider, `HTTP ${res.status}`);
      cache.set(cacheKey, { at: Date.now(), value: out });
      return out;
    }
    const j: any = await res.json();
    const models = (Array.isArray(j?.data) ? j.data : [])
      .map((m: any) => ({ id: String(m?.id ?? ''), created: Number(m?.created ?? 0), owned_by: String(m?.owned_by ?? '') }))
      .filter((m) => m.id.length > 0);
    if (!models.length) {
      const out = fallback(provider, 'EMPTY');
      cache.set(cacheKey, { at: Date.now(), value: out });
      return out;
    }
    const value: ModelCatalog = { models, fetchedAt: new Date().toISOString(), stale: false, provider };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err: any) {
    const out = fallback(provider, String(err?.message || 'NETWORK').slice(0, 140));
    cache.set(cacheKey, { at: Date.now(), value: out });
    return out;
  }
}

export function clearModelCache(): void {
  cache.clear();
}
