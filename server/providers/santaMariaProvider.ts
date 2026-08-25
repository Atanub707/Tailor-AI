import type { JobProvider, JobSearchParams, JobProviderResult } from './jobProvider.js';
import type { Job } from '../../src/types.js';
import { loadConfig } from '../config.js';
import { getProviderFetchLimit } from './searchBudget.js';
import { getDb } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';

/**
 * Santa Maria Apify Provider — BYOK, provider-agnostic.
 * Wraps santamaria-automations/career-site-jobs-scraper.
 * maxJobsPerCompany is ALWAYS derived from the central fetch budget
 * (searchBudget.ts) — it can never be 500 for user LIMIT 5/10/25/50.
 */
export class SantaMariaApifyProvider implements JobProvider {
  readonly id = 'santa-maria';
  private readonly actorId = 'santamaria-automations~career-site-jobs-scraper';

  async search(params: JobSearchParams): Promise<JobProviderResult> {
    const config = loadConfig();
    const token = config.apify.token?.trim();
    if (!token || config.apify.enabled !== true) {
      throw new Error('Apify API token not configured. Add it in Settings → Integrations.');
    }

    // Build Santa Maria input — queries can be career URLs or {platform, company}
    const queries = params.queries?.length ? params.queries : this.buildDefaultQueries(params);
    if (queries.length === 0) {
      // Never call Apify with an empty query list — it returns a 400 and
      // burns a run attempt for nothing. Fail fast with a human-readable reason.
      throw new Error('No company career sites configured for Santa Maria search. Please seed company_career_sites first.');
    }

    // Central budget — the ONLY source of maxJobsPerCompany. Never a literal.
    const providerBudget = getProviderFetchLimit(params.limit, this.id);

    const input = {
      queries,
      maxJobsPerCompany: providerBudget,
      includeDescription: true,
    };

    // Async run: create run → poll → dataset
    const runId = await this.createRun(token, input);
    const items = await this.pollAndFetch(token, runId);

    let jobs = items.map((item) => this.normalize(item, runId)).filter((j): j is Job => j !== null);

    // Keyword relevance (deterministic, no LLM) — RANK, don't over-filter:
    //   1. exact primary term in title/company (e.g. "devops" in "DevOps Engineer")
    //   2. all terms in description (e.g. a Platform Engineer describing DevOps work)
    //   3. DevOps-adjacent titles (SRE, Platform, Infrastructure, Cloud) as a
    //      soft fallback so the 25 ATS never collapse to 1 job.
    // Irrelevant roles (Account Executive, Sales) never sneak in — they match none.
    const terms = params.keywords.map((k) => String(k).toLowerCase()).filter((t) => t.length > 2);
    if (terms.length > 0) {
      const before = jobs.length;
      const primary = terms[0];
      const hay = (j: Job) => `${j.title} ${j.company} ${j.description || ''}`.toLowerCase();
      const titleExact = jobs.filter((j) => `${j.title} ${j.company}`.toLowerCase().includes(primary) && terms.every((t) => hay(j).includes(t)));
      if (titleExact.length >= Math.min(params.limit, 5)) {
        jobs = titleExact;
        console.log(`[SantaMaria] Keyword filter "${terms.join(' ')}" → ${before} → ${jobs.length} jobs (title/company exact)`);
      } else {
        const descMatch = jobs.filter((j) => terms.every((t) => hay(j).includes(t)));
        if (descMatch.length >= 3) {
          // Keep description matches, but push title-exact to the top.
          const titleFirst = [...titleExact, ...descMatch.filter((j) => !titleExact.includes(j))];
          jobs = titleFirst;
          console.log(`[SantaMaria] Keyword filter "${terms.join(' ')}" → ${before} → ${jobs.length} jobs (title-exact first + description matches)`);
        } else {
          // Soft fallback: DevOps-adjacent titles (SRE/Platform/Infrastructure/Cloud).
          // The title/company match IS the relevance — a "Platform Engineer" is a
          // DevOps role without needing the literal word in its description.
          const adjacent = /(sre|site reliability|platform|infrastructure|cloud|devops|deployment|release|systems)/i;
          const soft = jobs.filter((j) => adjacent.test(`${j.title} ${j.company}`));
          jobs = [...titleExact, ...soft.filter((j) => !titleExact.includes(j))];
          console.log(`[SantaMaria] Keyword filter "${terms.join(' ')}" → ${before} → ${jobs.length} jobs (soft fallback: DevOps-adjacent)`);
        }
      }
    }

    // Deduplicate + LIMIT enforcement is done by caller; we return filtered.
    const limited = jobs.slice(0, params.limit);

    return {
      jobs: limited,
      provider: this.id,
      providerRunId: runId,
      totalReturned: items.length,
      requestedLimit: params.limit,
    };
  }

  private buildDefaultQueries(params: JobSearchParams): Array<string | { platform: string; company: string }> {
    try {
      ensureV2Tables();
      const db = getDb();
      const platforms = params.atsPlatforms?.length
        ? params.atsPlatforms.map((p) => String(p).toLowerCase())
        : null;
      const cap = 8;
      // Priority boards — the hand-verified big-tech companies with real
      // DevOps hiring (Stripe, GitLab, MongoDB, Twilio…). Always queried so
      // results are never empty; remaining slots rotate through the long tail
      // of the 6k-company official list.
      const PRIORITY_IDS = ['stripe', 'airbnb', 'datadog', 'reddit', 'dropbox', 'coinbase', 'instacart', 'roblox', 'duolingo', 'gitlab', 'mongodb', 'twilio', 'webflow', 'vercel', 'databricks', 'chime', 'gusto', 'brex', 'nubank', 'asana', 'okta'];
      const placeholders = platforms ? platforms.map(() => '?').join(',') : null;
      const platformWhere = placeholders ? `AND LOWER(atsPlatform) IN (${placeholders})` : '';
      const platformArgs = platforms ? platforms : [];

      const priorityRows = db.prepare(
        `SELECT careerUrl FROM company_career_sites WHERE isActive = 1 ${platformWhere} AND id IN (${PRIORITY_IDS.map(() => '?').join(',')}) LIMIT 3`
      ).all(...platformArgs, ...PRIORITY_IDS) as { careerUrl: string }[];

      const total = (db.prepare(`SELECT count(*) c FROM company_career_sites WHERE isActive = 1 ${platformWhere} AND id NOT IN (${PRIORITY_IDS.map(() => '?').join(',')})`).get(...platformArgs, ...PRIORITY_IDS) as any).c;
      const tailCap = cap - priorityRows.length;
      const offset = (Math.floor(Date.now() / (30 * 60 * 1000)) * tailCap) % Math.max(total, tailCap);
      const tailRows = db.prepare(
        `SELECT careerUrl FROM company_career_sites WHERE isActive = 1 ${platformWhere} AND id NOT IN (${PRIORITY_IDS.map(() => '?').join(',')}) ORDER BY rowid LIMIT ${tailCap} OFFSET ${offset}`
      ).all(...platformArgs, ...PRIORITY_IDS) as { careerUrl: string }[];

      return [...priorityRows, ...tailRows].map((r) => r.careerUrl);
    } catch {
      return [];
    }
  }

  private async createRun(token: string, input: Record<string, unknown>): Promise<string> {
    const res = await fetch(`https://api.apify.com/v2/acts/${this.actorId}/runs?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Apify create run failed ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const runId = data?.data?.id || data?.id;
    if (!runId) throw new Error('Apify runId not returned');
    return runId;
  }

  private async pollAndFetch(token: string, runId: string): Promise<any[]> {
    const maxPolls = 60; // ~5 min
    for (let i = 0; i < maxPolls; i++) {
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
        if (!itemsRes.ok) throw new Error(`Dataset fetch failed ${itemsRes.status}`);
        const items = await itemsRes.json();
        return Array.isArray(items) ? items : [];
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
        throw new Error(`Apify run ${status}`);
      }
    }
    throw new Error('Apify run timed out');
  }

  private normalize(item: any, runId: string): Job | null {
    const title = item.title || item.jobTitle;
    const company = item.company || item.companyName;
    // Santa Maria returns snake_case fields (job_url, apply_url, ats_platform);
    // the Valig actors return camelCase — handle both so no job is dropped.
    const jobUrl = item.jobUrl || item.job_url || item.url || item.applyUrl || item.apply_url;
    const applyUrl = item.applyUrl || item.apply_url || item.jobUrl || item.job_url || item.url;
    const atsPlatform = (item.atsPlatform || item.ats_platform || item.platform || 'other').toString().toLowerCase();
    if (!title || !company || !jobUrl || !applyUrl) return null;

    const now = new Date().toISOString();
    const fingerprint = this.fingerprint(atsPlatform, item.externalId || item.id || applyUrl, company, title, item.location);

    return {
      id: `santa-${fingerprint.slice(0, 16)}`,
      externalId: item.externalId || item.id,
      title: String(title).trim(),
      company: String(company).trim(),
      companyId: item.companyId || (item as any).company_id,
      location: item.location || (Array.isArray(item.locations) ? item.locations[0] : undefined),
      locations: Array.isArray(item.locations) ? item.locations : undefined,
      department: item.department,
      employmentType: item.employmentType || (item as any).employment_type,
      remote: item.remote,
      description: item.description || '',
      atsPlatform: atsPlatform as any,
      jobUrl: String(jobUrl),
      applyUrl: String(applyUrl),
      url: String(applyUrl), // backward compat with existing Job.url
      source: 'Custom' as any, // will be mapped to ATS source later
      createdAt: item.createdAt || (item as any).created_at || now,
      updatedAt: item.updatedAt || (item as any).updated_at || now,
      scrapedAt: now,
      provider: this.id,
      providerRunId: runId,
      fingerprint,
      isActive: true,
      state: 'pending',
    } as unknown as Job;
  }

  private fingerprint(ats: string, externalId: string, company: string, title: string, location?: string): string {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '');
    const base = `${ats}|${norm(externalId)}`.trim();
    if (norm(externalId)) return `${ats}-${norm(externalId)}`;
    const fallback = `${norm(company)}|${norm(title)}|${norm(location || '')}`;
    // Simple hash — not crypto, just dedup key
    let hash = 0;
    for (let i = 0; i < fallback.length; i++) hash = (hash * 31 + fallback.charCodeAt(i)) >>> 0;
    return `${ats}-${hash.toString(16)}`;
  }
}
