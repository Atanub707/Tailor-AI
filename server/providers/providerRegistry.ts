// Provider registry — the ordered set of search providers and their flags.
// Order matters for top-up: primary indexed provider first, free/indexed
// second, job-board actors next, Santa Maria last (explicit fallback only).

import type { JobSearchProvider } from './types.js';

// Feature flags (env-overridable, defaults per spec).
// No behavior depends on undocumented magic values.
export const V2_FLAGS = {
  V2_SEARCH_ENABLED: (process.env.V2_SEARCH_ENABLED ?? 'true') !== 'false',
  ENABLE_JOBO_PROVIDER: (process.env.ENABLE_JOBO_PROVIDER ?? 'true') !== 'false',
  ENABLE_SANTA_MARIA_FALLBACK: (process.env.ENABLE_SANTA_MARIA_FALLBACK ?? 'false') !== 'false',
  ENABLE_LOCAL_INDEX_MODE: (process.env.ENABLE_LOCAL_INDEX_MODE ?? 'false') !== 'false',
};

/**
 * Build the ordered provider list from the registered providers + flags.
 * The provider array passed in is the full known set; the registry returns
 * only the enabled, ordered subset for a given search.
 */
export function buildProviderOrder(providers: JobSearchProvider[]): JobSearchProvider[] {
  const order: JobSearchProvider[] = [];
  const byId = new Map(providers.map((p) => [p.id, p]));

  // 1. Primary: Jobo indexed ATS provider.
  if (V2_FLAGS.ENABLE_JOBO_PROVIDER) {
    const jobo = byId.get('jobo');
    if (jobo) order.push(jobo);
  }

  // 2. Future zero-cost/free indexed providers slot in here.

  // 3. Job-board actors (LinkedIn/Indeed/Naukri) — only when their search
  //    mode enables them (not wired in this step; providers register later).

  // 4. Santa Maria — explicit fallback ONLY (flag-gated).
  if (V2_FLAGS.ENABLE_SANTA_MARIA_FALLBACK) {
    const sm = byId.get('santa-maria');
    if (sm) order.push(sm);
  }

  return order;
}

/** All registered providers (for tests/introspection). */
export function knownProviders(providers: JobSearchProvider[]): string[] {
  return providers.map((p) => p.id);
}