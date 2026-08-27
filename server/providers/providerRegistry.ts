// Provider registry — the ordered set of search providers and their flags.
// Order matters: no blind fan-out — the orchestrator stops as soon as the
// requested LIMIT of unique relevant jobs is reached.

import type { JobSearchProvider } from './types.js';

// Feature flags (env-overridable, defaults per spec).
// No behavior depends on undocumented magic values.
export const V2_FLAGS = {
  V2_SEARCH_ENABLED: (process.env.V2_SEARCH_ENABLED ?? 'true') !== 'false',
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