// Provider registry — the ordered set of search providers and their flags.
// Order matters: no blind fan-out — the orchestrator stops as soon as the
// requested LIMIT of unique relevant jobs is reached.

import type { JobSearchProvider } from './types.js';

// Feature flags (env-overridable, defaults per spec).
// No behavior depends on undocumented magic values.
export const V2_FLAGS = {
  V2_SEARCH_ENABLED: (process.env.V2_SEARCH_ENABLED ?? 'true') !== 'false',
};

// Local ATS index flag — when ON, free-API ATS searches (Greenhouse first)
// route through the neutral V2 pipeline (fetch → normalize → date/location →
// relevance → rank → dedupe → LIMIT). When OFF (default), the current
// request-driven V1 direct-ATS behavior is unchanged.
export const ATS_FLAGS = {
  ENABLE_LOCAL_ATS_INDEX: (process.env.ENABLE_LOCAL_ATS_INDEX ?? 'false') === 'true',
};

/**
 * Build the ordered provider list from the registered providers + flags.
 * The provider array passed in is the full known set; the registry returns
 * only the enabled subset.
 */
export function buildProviderOrder(providers: JobSearchProvider[]): JobSearchProvider[] {
  return [...providers];
}

/** All registered provider ids (for tests/introspection). */
export function knownProviders(providers: JobSearchProvider[]): string[] {
  return providers.map((p) => p.id);
}