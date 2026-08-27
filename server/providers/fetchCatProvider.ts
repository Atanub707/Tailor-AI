// FetchCat ATS Jobs Scraper provider (`fetch_cat/ats-jobs-scraper`).
// ATS coverage is VERIFIED against the actor's current docs (2026-08):
// Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, Personio — six
// platforms, nothing invented. Actor-side filtering (keywordFilter /
// locationFilter) is used when supported; Tailor ALWAYS revalidates locally
// (relevance engine is the final authority).
//
// Input schema (verified): greenhouseBoards[], leverCompanies[],
// ashbyBoards[], recruiteeCompanies[], smartRecruitersCompanies[],
// personioCompanies[], startUrls[], maxItems, includeDescriptions,
// departmentFilter, locationFilter, keywordFilter, runTimeSecs.
// Pricing is pay-per-event (approx $0.06/1K saved) — never hard-coded in
// business logic; cost telemetry is metadata only.

import { getProviderBudget } from './providerBudget.js';
import type { JobSearchParams, NormalizedJob, JobSearchProvider, ProviderSearchResult } from './types.js';

const FETCHCAT_ACTOR_ID = 'fetch_cat~ats-jobs-scraper';

// Which ATS platforms the actor currently documents as supported.
export const FETCHCAT_ATS_COVERAGE = ['greenhouse', 'lever', 'ashby', 'recruitee', 'smartrecruiters', 'personio'] as const;

function apifyToken(): string | undefined {
  const t = (process.env.APIFY_API_TOKEN || '').trim();
  return t || undefined;
}

interface FetchCatItem {
  source?: string;
  companySlug?: string;
  companyName?: string;
  jobId?: string | number;
  title?: string;
  location?: string;
  applyUrl?: string;
  url?: string;
  postedDate?: string;
  publishedDate?: string;
  description?: string;
  remote?: boolean;
  department?: string;
}

export class FetchCatProvider implements JobSearchProvider {
  readonly id = 'fetchcat';

  supports(_params: JobSearchParams): boolean {
    return !!apifyToken();
  }

  estimatedCost(fetchLimit: number): number | null {
    // Pay-per-saved-event; ~$0.06 per 1K jobs. Cost telemetry only —
    // pricing changes, so this is metadata, not business logic.
    return fetchLimit > 0 ? Math.round((fetchLimit * 0.00006) * 10000) / 10000 : null;
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const start = Date.now();
    const token = apifyToken();
    if (!token) {
      return { provider: this.id, jobs: [], requestedLimit: fetchLimit, returnedCount: 0, durationMs: Date.now() - start, error: 'FetchCat unavailable — APIFY_API_TOKEN not configured' };
    }

    // Budget is ALWAYS the orchestrator's fetchLimit — never a literal.
    const budget = Math.min(fetchLimit, getProviderBudget(params.limit));

    // Actor-side filters where the schema supports them. FetchCat's
    // keywordFilter matches title AND description — that's broader than
    // Tailor's title-first relevance, so we still pass everything through
    // the local relevance engine afterward.
    const input: Record<string, unknown> = {
      maxItems: budget,
      includeDescriptions: true,
      keywordFilter: params.keywords,
      runTimeSecs: 270,
    };
    if (params.location && params.location.trim()) {
      input.locationFilter = params.location.trim();
    }

    try {
      const items = await this.runActor(token, input);
      const jobs = items
        .map((item) => this.normalize(item))
        .filter((j): j is NormalizedJob => !!j);
      return {
        provider: this.id,
        jobs,
        requestedLimit: budget,
        returnedCount: jobs.length,
        durationMs: Date.now() - start,
        costEstimate: this.estimatedCost?.(budget) ?? null,
      };
    } catch (err: any) {
      return { provider: this.id, jobs: [], requestedLimit: budget, returnedCount: 0, durationMs: Date.now() - start, error: err?.message || 'FetchCat request failed' };
    }
  }

  private normalize(item: FetchCatItem): NormalizedJob | null {
    const title = item.title;
    const company = item.companyName || item.companySlug;
    const applyUrl = item.applyUrl || item.url;
    if (!title || !company || !applyUrl) return null;

    const atsPlatform = (item.source || 'other').toLowerCase();
    const postedDate = item.publishedDate || item.postedDate;
    const externalId = item.jobId !== undefined ? String(item.jobId) : '';

    // Canonical fingerprint: ATS + external job id first, else apply URL.
    const fingerprint = externalId
      ? `fetchcat-${atsPlatform}-${externalId.replace(/[^a-z0-9]/gi, '').slice(0, 40)}`
      : `fetchcat-${applyUrl.replace(/[^a-z0-9]/gi, '').slice(0, 40)}`;

    return {
      id: fingerprint,
      title,
      company,
      location: item.location,
      description: item.description,
      applyUrl,
      url: item.url || applyUrl,
      atsPlatform,
      source: 'fetchcat',
      postedDate,
      postedDateSemantics: postedDate ? 'published' : 'unknown',
      employmentType: undefined,
      remote: item.remote === true,
      fingerprint,
      raw: item as unknown as Record<string, unknown>,
    };
  }

  private async runActor(token: string, input: Record<string, unknown>): Promise<FetchCatItem[]> {
    const createRes = await fetch(`https://api.apify.com/v2/acts/${FETCHCAT_ACTOR_ID}/runs?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
    if (!createRes.ok) throw new Error(`FetchCat create run failed ${createRes.status}`);
    const createData: any = await createRes.json();
    const runId = createData?.data?.id;
    if (!runId) throw new Error('FetchCat runId not returned');

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!statusRes.ok) continue;
      const statusData: any = await statusRes.json();
      const status = statusData?.data?.status;
      if (status === 'SUCCEEDED') {
        const datasetId = statusData?.data?.defaultDatasetId;
        if (!datasetId) return [];
        const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}`, {
          signal: AbortSignal.timeout(60000),
        });
        if (!itemsRes.ok) throw new Error(`FetchCat dataset fetch failed ${itemsRes.status}`);
        const items = await itemsRes.json();
        return Array.isArray(items) ? (items as FetchCatItem[]) : [];
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`FetchCat run ${status}`);
    }
    throw new Error('FetchCat run timed out');
  }
}