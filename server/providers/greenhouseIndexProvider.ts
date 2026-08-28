// Local ATS index provider — the SEARCH side of the ETL split.
//
// ONE parameterized provider per ATS platform: Greenhouse and Lever both read
// ats_jobs through the SAME retrieval path — only the platform filter and the
// source label differ. Rows already carry ats_platform, so the orchestrator's
// date/location/work-mode/relevance/ranking/dedupe/LIMIT pipeline stays fully
// provider-neutral. ZERO network calls: user search latency is local DB +
// relevance only.

import type { JobSearchParams, JobSearchProvider, NormalizedJob, ProviderSearchResult } from './types.js';
import { queryAtsCandidates, type AtsJobRow } from '../ats-index/atsRepository.js';

const WINDOW_HOURS: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 };

const SOURCE_LABEL: Record<string, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' };

function rowToNormalized(r: AtsJobRow, sourceLabel: string): NormalizedJob {
  return {
    id: r.fingerprint,
    title: r.title,
    company: r.company,
    location: r.location ?? undefined,
    description: r.description ?? undefined,
    applyUrl: r.apply_url ?? undefined,
    url: r.job_url ?? undefined,
    atsPlatform: r.ats_platform,
    source: sourceLabel as NormalizedJob['source'],
    postedDate: r.posted_date ?? undefined,
    postedDateSemantics: (r.posted_date_semantics as NormalizedJob['postedDateSemantics']) ?? undefined,
    employmentType: r.employment_type ?? undefined,
    remote: r.work_mode === 'Remote',
    fingerprint: r.fingerprint,
  };
}

export class AtsIndexProvider implements JobSearchProvider {
  readonly id: string;
  private readonly platform: string;
  private readonly sourceLabel: string;

  constructor(platform: string, sourceLabel: string) {
    this.platform = platform;
    this.sourceLabel = sourceLabel;
    this.id = `${platform}-index`;
  }

  supports(params: JobSearchParams): boolean {
    return params.source === this.sourceLabel || params.source.toLowerCase() === this.platform;
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const started = Date.now();
    const hours = params.postedWindow && params.postedWindow !== 'any' ? WINDOW_HOURS[params.postedWindow] : undefined;
    const minPostedDate = hours ? new Date(Date.now() - hours * 3600e3).toISOString() : undefined;
    const rows = queryAtsCandidates({ platform: this.platform, activeOnly: true, minPostedDate });
    return {
      provider: this.id,
      jobs: rows.map((r) => rowToNormalized(r, this.sourceLabel)),
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

export function createAtsIndexProvider(platform: string, sourceLabel: string): AtsIndexProvider {
  return new AtsIndexProvider(platform, sourceLabel);
}

export const greenhouseIndexProvider = createAtsIndexProvider('greenhouse', 'Greenhouse');
export const leverIndexProvider = createAtsIndexProvider('lever', 'Lever');