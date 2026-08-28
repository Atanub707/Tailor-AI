// Local ATS index provider — the SEARCH side of the ETL split.
//
// Retrieval only: reads candidates from ats_jobs (platform + active, with a
// pure SQL min-posted-date prefilter). Date/location/work-mode/relevance
// filtering, ranking, dedupe and LIMIT all stay in the orchestrator — the
// single filtering pipeline is never duplicated here. ZERO network calls:
// user search latency is local DB + relevance only.

import type { JobSearchParams, JobSearchProvider, NormalizedJob, ProviderSearchResult } from './types.js';
import { queryAtsCandidates, type AtsJobRow } from '../ats-index/atsRepository.js';

const WINDOW_HOURS: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 };

function rowToNormalized(r: AtsJobRow): NormalizedJob {
  return {
    id: r.fingerprint,
    title: r.title,
    company: r.company,
    location: r.location ?? undefined,
    description: r.description ?? undefined,
    applyUrl: r.apply_url ?? undefined,
    url: r.job_url ?? undefined,
    atsPlatform: r.ats_platform,
    source: 'Greenhouse',
    postedDate: r.posted_date ?? undefined,
    postedDateSemantics: (r.posted_date_semantics as NormalizedJob['postedDateSemantics']) ?? undefined,
    employmentType: r.employment_type ?? undefined,
    remote: r.work_mode === 'Remote',
    fingerprint: r.fingerprint,
  };
}

export class GreenhouseIndexProvider implements JobSearchProvider {
  readonly id = 'greenhouse-index';

  supports(params: JobSearchParams): boolean {
    return params.source === 'Greenhouse' || params.source === 'greenhouse';
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const started = Date.now();
    const hours = params.postedWindow && params.postedWindow !== 'any' ? WINDOW_HOURS[params.postedWindow] : undefined;
    const minPostedDate = hours ? new Date(Date.now() - hours * 3600e3).toISOString() : undefined;
    const rows = queryAtsCandidates({ platform: 'greenhouse', activeOnly: true, minPostedDate });
    return {
      provider: this.id,
      jobs: rows.map(rowToNormalized),
      requestedLimit: fetchLimit,
      returnedCount: rows.length,
      durationMs: Date.now() - started,
      costEstimate: 0,
    };
  }

  estimatedCost(_fetchLimit: number): number | null {
    return 0;
  }
}

export const greenhouseIndexProvider = new GreenhouseIndexProvider();