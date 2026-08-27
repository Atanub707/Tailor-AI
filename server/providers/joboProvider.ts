// Jobo ATS Jobs API provider (jobo.world/ats-jobs-api).
// Primary indexed ATS search provider for V2. Runs against a pre-built,
// continuously updated job index — the right shape for cost-predictable
// search (billing on returned jobs, not scraping).
//
// Two transport modes (config-driven, never hard-coded):
//   apify  — if APIFY_API_TOKEN is configured (Apify actor)
//   direct — if JOBO_API_KEY is configured (direct Jobo API)
//   none   — provider unavailable (both missing)
//
// IMPORTANT: title-oriented search by default (search_description=false).
// Location/date filters sent server-side when supported. fetchLimit comes
// ONLY from providerBudget — never a literal.

import { getProviderBudget } from './providerBudget.js';
import type { JobSearchParams, NormalizedJob, JobSearchProvider, ProviderSearchResult } from './types.js';

const JOBO_ACTOR_ID = 'jobo.world/ats-jobs-api';
const JOBO_DIRECT_ENDPOINT = 'https://api.jobo.world/v1/jobs/search'; // per Jobo docs; env-overridable

function config(): { mode: 'apify' | 'direct' | 'none'; apifyToken?: string; apiKey?: string } {
  const apifyToken = (process.env.APIFY_API_TOKEN || '').trim();
  const apiKey = (process.env.JOBO_API_KEY || '').trim();
  if (apifyToken) return { mode: 'apify', apifyToken };
  if (apiKey) return { mode: 'direct', apiKey };
  return { mode: 'none' };
}

/** Map user postedWindow to Jobo's posted_after phrasing. */
function postedAfter(window?: string): string | undefined {
  switch (window) {
    case '24h': return '1 day ago';
    case '7d': return '7 days ago';
    case '30d': return '30 days ago';
    default: return undefined;
  }
}

interface JoboItem {
  title?: string;
  company?: string;
  company_name?: string;
  location?: string;
  description?: string;
  apply_url?: string;
  url?: string;
  posted_at?: string;
  published_at?: string;
  ats_platform?: string;
  id?: string;
  fingerprint?: string;
}

export class JoboProvider implements JobSearchProvider {
  readonly id = 'jobo';

  supports(_params: JobSearchParams): boolean {
    return config().mode !== 'none';
  }

  estimatedCost(fetchLimit: number): number | null {
    // Jobo is billed on returned jobs; conservative estimate: per-job cost ×
    // fetch limit. Exposed for telemetry only — providers may return null.
    return fetchLimit > 0 ? Math.round(fetchLimit * 0.002 * 100) / 100 : null;
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const start = Date.now();
    const cfg = config();
    if (cfg.mode === 'none') {
      return { provider: this.id, jobs: [], requestedLimit: fetchLimit, returnedCount: 0, durationMs: Date.now() - start, error: 'JOBO not configured (APIFY_API_TOKEN or JOBO_API_KEY)' };
    }

    // Budget is ALWAYS the orchestrator's fetchLimit — never a literal.
    const budget = Math.min(fetchLimit, getProviderBudget(params.limit));
    const body = {
      queries: [params.keywords],
      search_description: false,
      location: params.location || undefined,
      posted_after: postedAfter(params.postedWindow),
      page_size: budget,
    };

    let raw: JoboItem[] = [];
    try {
      if (cfg.mode === 'apify') {
        raw = await this.runApify(cfg.apifyToken!, body as Record<string, unknown>);
      } else {
        raw = await this.runDirect(cfg.apiKey!, body as Record<string, unknown>);
      }
    } catch (err: any) {
      return { provider: this.id, jobs: [], requestedLimit: budget, returnedCount: 0, durationMs: Date.now() - start, error: err?.message || 'Jobo request failed' };
    }

    const jobs = (raw as JoboItem[]).map((item) => this.normalize(item)).filter((j): j is NormalizedJob => !!j);
    return {
      provider: this.id,
      jobs,
      requestedLimit: budget,
      returnedCount: jobs.length,
      durationMs: Date.now() - start,
      costEstimate: this.estimatedCost?.(budget) ?? null,
    };
  }

  private normalize(item: JoboItem): NormalizedJob | null {
    const title = item.title;
    const company = item.company || item.company_name;
    const applyUrl = item.apply_url || item.url;
    if (!title || !company || !applyUrl) return null;

    const postedDate = item.published_at || item.posted_at;
    const atsPlatform = item.ats_platform || 'other';
    // Canonical fingerprint: prefer provider id + external id, else applyUrl.
    const fingerprint = item.fingerprint
      || (item.id ? `jobo-${item.id}` : `jobo-${applyUrl.replace(/[^a-z0-9]/gi, '').slice(0, 40)}`);

    return {
      id: fingerprint,
      title,
      company,
      location: item.location,
      description: item.description,
      applyUrl,
      url: item.url || applyUrl,
      atsPlatform,
      source: 'jobo',
      postedDate,
      postedDateSemantics: postedDate ? 'published' : 'unknown',
      fingerprint,
      raw: item as unknown as Record<string, unknown>,
    };
  }

  private async runApify(token: string, body: Record<string, unknown>): Promise<JoboItem[]> {
    // Create run, poll, fetch dataset — the same async pattern the Santa
    // Maria provider uses. Mocked in tests; never hit live.
    const createRes = await fetch(`https://api.apify.com/v2/acts/${JOBO_ACTOR_ID}/runs?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, limit: body.page_size }),
      signal: AbortSignal.timeout(30000),
    });
    if (!createRes.ok) throw new Error(`Jobo Apify create run failed ${createRes.status}`);
    const createData: any = await createRes.json();
    const runId = createData?.data?.id;
    if (!runId) throw new Error('Jobo runId not returned');

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
      if (!statusRes.ok) continue;
      const statusData: any = await statusRes.json();
      const status = statusData?.data?.status;
      if (status === 'SUCCEEDED') {
        const datasetId = statusData?.data?.defaultDatasetId;
        if (!datasetId) return [];
        const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(60000) });
        if (!itemsRes.ok) throw new Error(`Jobo dataset fetch failed ${itemsRes.status}`);
        const items = await itemsRes.json();
        return Array.isArray(items) ? (items as JoboItem[]) : [];
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Jobo Apify run ${status}`);
    }
    throw new Error('Jobo Apify run timed out');
  }

  private async runDirect(apiKey: string, body: Record<string, unknown>): Promise<JoboItem[]> {
    const endpoint = process.env.JOBO_DIRECT_ENDPOINT || JOBO_DIRECT_ENDPOINT;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Jobo direct API ${res.status}`);
    const data: any = await res.json();
    const items = data?.jobs ?? data?.results ?? data;
    return Array.isArray(items) ? (items as JoboItem[]) : [];
  }
}