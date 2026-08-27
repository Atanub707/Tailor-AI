// V2 provider-driven search — shared contracts.
// Providers retrieve; the orchestrator filters/ranks; the cache stores
// short-lived candidates; only user-interacted jobs become durable.

import type { Job } from '../../src/types.js';

export interface JobSearchParams {
  keywords: string;
  location?: string;
  postedWindow?: '24h' | '7d' | '30d' | 'any';
  jobType?: string;
  workMode?: 'remote' | 'hybrid' | 'onsite' | 'all';
  level?: string;
  limit: number; // how many jobs the user wants to SEE
  source?: string; // selected source (LinkedIn/Naukri/Greenhouse/…) — part of cache fingerprint
}

// Normalized candidate — a provider result BEFORE Tailor's own filters.
export interface NormalizedJob {
  id?: string;          // canonical fingerprint (set by orchestrator dedupe)
  title: string;
  company: string;
  location?: string;
  description?: string;
  applyUrl?: string;
  url?: string;
  atsPlatform?: string;
  source: string;       // provider id or source label
  postedDate?: string;
  postedDateSemantics?: 'published' | 'created' | 'updated' | 'unknown';
  employmentType?: string;
  remote?: boolean;
  fingerprint: string;  // canonical dedupe key (must be set by provider)
  raw?: Record<string, unknown>; // provider payload, for telemetry/debug only
}

export interface ProviderSearchResult {
  provider: string;
  jobs: NormalizedJob[];
  requestedLimit: number;
  returnedCount: number;
  durationMs?: number;
  cacheHit?: boolean;
  costEstimate?: number | null;
  error?: string;
}

export interface JobSearchProvider {
  readonly id: string;
  /** Does this provider handle this query shape? (e.g. location support) */
  supports(params: JobSearchParams): boolean;
  search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult>;
  /** Optional cost estimate in provider credits for telemetry (null = unknown). */
  estimatedCost?(fetchLimit: number): number | null;
}