// Provider registry — the ordered set of search providers and their flags.
// Order matters for top-up: broad job-board providers first, ATS coverage
// (FetchCat) as the ATS provider, and no blind fan-out — the orchestrator
// stops as soon as the requested LIMIT of unique relevant jobs is reached.

import type { JobSearchProvider } from './types.js';

// Feature flags (env-overridable, defaults per spec).
// No behavior depends on undocumented magic values.
export const V2_FLAGS = {
  V2_SEARCH_ENABLED: (process.env.V2_SEARCH_ENABLED ?? 'true') !== 'false',
  ENABLE_FETCHCAT_PROVIDER: (process.env.ENABLE_FETCHCAT_PROVIDER ?? 'true') !== 'false',
};

/**
 * Build the ordered provider list from the registered providers + flags.
 * The provider array passed in is the full known set; the registry returns
 * only the enabled, ordered subset for a given search.
 *
 * Order: existing job-board providers first (LinkedIn/Naukri/Indeed etc. as
 * registered), FetchCat ATS coverage last — it is the ATS provider, not the
 * primary broad query source.
 */
export function buildProviderOrder(providers: JobSearchProvider[]): JobSearchProvider[] {
  const order: JobSearchProvider[] = [];
  const byId = new Map(providers.map((p) => [p.id, p]));

  // 1. Existing job-board providers (LinkedIn, Naukri, Indeed, …) in the
  //    order they were registered — they are broad query sources.
  for (const p of providers) {
    if (p.id === 'fetchcat') continue; // ATS provider is appended last
    order.push(p);
  }

  // 2. FetchCat — ATS coverage (Greenhouse/Lever/Ashby/Recruitee/
  //    SmartRecruiters/Personio), flag-gated.
  if (V2_FLAGS.ENABLE_FETCHCAT_PROVIDER) {
    const fc = byId.get('fetchcat');
    if (fc) order.push(fc);
  }

  return order;
}

/** All registered provider ids (for tests/introspection). */
export function knownProviders(providers: JobSearchProvider[]): string[] {
  return providers.map((p) => p.id);
}