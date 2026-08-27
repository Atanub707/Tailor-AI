import { getAllJobs, getCurrentUserId, saveNewJobs, getDb } from '../storage/fileStorage.js';
import { isJobFresh, fingerprintJob, markSeen, getSeenFingerprints, isWithinPostedWindow } from '../storage/v2Tables.js';
import { rankRelevant } from '../search/rank.js';
import { matchesLocation } from '../search/location.js';
import { getFetchBudget } from '../providers/searchBudget.js';
import type { SearchRequest } from '../providers/searchBudget.js';

// ── LOCAL FILTER PIPELINE (applied to EVERY candidate before it can be
//    shown or saved). Retrieval decides how many candidates we fetch;
//    these stages decide which of them satisfy the user's constraints.
//    Order matters: cheap/structural filters first, expensive relevance last.
//    1. validity   — missing title/apply URL → reject
//    2. date       — provider-aware postedDate window (24h/7d/30d)
//    3. location   — normalized country/city/remote matching
//    4. job type   — contract/employment type, only when requested
//    5. relevance  — query-profile score; IRRELEVANT → reject
//    (dedup + ranking + LIMIT happen after, in the search flow)
export interface LocalFilterResult {
  passed: boolean;
  reason?: 'invalid' | 'date' | 'location' | 'jobtype' | 'relevance';
}

export function passLocalFilters(job: any, req: SearchRequest): LocalFilterResult {
  // 1. Validity — unusable jobs are rejected before anything else.
  if (!job || !job.title || (!job.applyUrl && !job.url)) {
    return { passed: false, reason: 'invalid' };
  }
  // 2. Date — semantics-aware (published/created/updated/unknown).
  if (!isWithinPostedWindow(job, req.postedWithin)) {
    return { passed: false, reason: 'date' };
  }
  // 3. Location — normalized matching (India → Bengaluru/Remote-India).
  if (!matchesLocation(job.location || job.locations, req.location, { remote: req.remote })) {
    return { passed: false, reason: 'location' };
  }
  // 4. Job type — only when the user picked one (full-time/contract/…).
  if (req.jobType && req.jobType !== 'any' && req.jobType !== 'all') {
    const t = String(job.employmentType || job.jobType || '').toLowerCase();
    const want = String(req.jobType).toLowerCase();
    if (t && !t.includes(want)) return { passed: false, reason: 'jobtype' };
  }
  return { passed: true };
}

export interface ProviderResult {
  providerId: string;
  jobs: any[];
  requested: number;
  returned: number;
  duration: number;
  error?: string;
}

// Deterministic provider priority — no LLM.
// Job-board providers first (LinkedIn/Naukri/Indeed); ATS coverage is handled
// by the V2 search-v2 path. Budget still caps each provider.
const PROVIDER_PRIORITY: Record<string, string[]> = {
  india: ['naukri', 'indeed', 'linkedin'],
  remote: ['indeed', 'linkedin', 'upwork'],
  default: ['linkedin', 'indeed', 'naukri'],
};

function getProviderOrder(location?: string, remote?: boolean): string[] {
  const loc = (location || '').toLowerCase();
  if (loc.includes('india')) return PROVIDER_PRIORITY.india;
  if (remote) return PROVIDER_PRIORITY.remote;
  return PROVIDER_PRIORITY.default;
}

export function getSearchFingerprint(req: SearchRequest): string {
  const q = req.query.toLowerCase().trim().replace(/\s+/g, '-');
  const loc = (req.location || 'any').toLowerCase().trim().replace(/\s+/g, '-');
  const posted = req.postedWithin || 'all';
  const remote = req.remote ? 'remote' : 'any';
  const jobType = req.jobType || 'any';
  return `${q}|${loc}|${posted}|${remote}|${jobType}`;
}

export async function searchWithCache(
  req: SearchRequest,
  fetchFn: (providerId: string, limit: number) => Promise<{ jobs: any[]; runId?: string }>,
): Promise<{ jobs: any[]; providersCalled: string[]; cacheHit: boolean; providerResults: ProviderResult[]; queryFp: string; seenCount: number; totalStored: number; exhausted: boolean }> {
  const allJobs = getAllJobs() as any[];
  const queryFp = getSearchFingerprint(req);
  const seenSet = getSeenFingerprints(getCurrentUserId(), queryFp);
  const freshJobs = allJobs.filter((j) => {
    if ((j as any).isActive === false) return false;
    if (!isJobFresh((j as any).scrapedAt)) return false;
    if (!passLocalFilters(j, req).passed) return false; // date/location/jobtype/validity
    const fp = (j as any).fingerprint || fingerprintJob(j);
    if (seenSet.has(fp)) return false; // seen in this walk → skip
    const hay = `${j.title} ${j.company} ${j.description || ''}`.toLowerCase();
    const terms = req.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length > 0 && !terms.some((t) => hay.includes(t))) return false;
    return true;
  });

  if (freshJobs.length >= req.limit) {
    // Enough fresh in DB — return without calling any provider.
    // Relevance tier first, freshness second, deterministic tie-breakers.
    const ranked = rankRelevant(freshJobs, req.query, (j) => j.title || '', (j) => j.company || '')
      .map((r) => r.job)
      .slice(0, req.limit);
    markSeen(getCurrentUserId(), queryFp, ranked.map((j: any) => (j as any).fingerprint || fingerprintJob(j)));
    return {
      jobs: ranked.slice(0, req.limit),
      providersCalled: [],
      cacheHit: true,
      providerResults: [],
      queryFp,
      seenCount: ranked.length,
      totalStored: allJobs.length,
      exhausted: false,
    };
  }

  // Progressive fan-out
  const budget = getFetchBudget(req.limit);
  const needed = req.limit - freshJobs.length;
  const providerOrder = getProviderOrder(req.location, req.remote);
  const providersCalled: string[] = [];
  const providerResults: ProviderResult[] = [];
  let collected = [...freshJobs];
  const seenFinal = new Set(freshJobs.map((j) => (j as any).fingerprint || fingerprintJob(j)));

  for (const providerId of providerOrder) {
    if (collected.length >= req.limit) break;

    const remaining = req.limit - collected.length;
    const providerLimit = Math.min(Math.ceil(remaining * 1.2), budget.maxPerProvider);

    const start = Date.now();
    try {
      const { jobs } = await fetchFn(providerId, providerLimit);
      const duration = Date.now() - start;
      const unique = jobs.filter((j: any) => {
        if (!passLocalFilters(j, req).passed) return false; // date/location/jobtype/validity
        const fp = (j as any).fingerprint || fingerprintJob(j);
        if (seenSet.has(fp)) return false;      // seen in this walk
        if (seenFinal.has(fp)) return false;    // already collected
        seenFinal.add(fp);
        return true;
      });

      providersCalled.push(providerId);
      providerResults.push({
        providerId,
        jobs: unique,
        requested: providerLimit,
        returned: jobs.length,
        duration,
      });

      collected.push(...unique);

      // Provider under-delivered (unique < remaining) → it is tapped out for
      // this walk. Stop the main fan-out here; the bounded top-up below makes
      // ONE more attempt against the next uncalled provider instead of burning
      // every provider's budget in the main loop.
      if (unique.length < remaining) break;
    } catch (err: any) {
      providersCalled.push(providerId);
      providerResults.push({
        providerId,
        jobs: [],
        requested: providerLimit,
        returned: 0,
        duration: Date.now() - start,
        error: err.message,
      });
      // Continue — one provider failure must not fail the search
    }
  }

  // Final dedup + rank + slice
  const deduped = collected;

  // One bounded top-up against the next provider when still short
  if (deduped.length < req.limit && providersCalled.length < providerOrder.length) {
    const next = providerOrder.find((p) => !providersCalled.includes(p));
    if (next) {
      const remaining = req.limit - deduped.length;
      const topUpLimit = Math.min(Math.ceil(remaining * 1.2), budget.maxPerProvider);
      try {
        const { jobs } = await fetchFn(next, topUpLimit);
        const fresh = jobs.filter((j: any) => {
          if (!passLocalFilters(j, req).passed) return false; // date/location/jobtype/validity
          const fp = (j as any).fingerprint || fingerprintJob(j);
          if (seenSet.has(fp) || seenFinal.has(fp)) return false;
          seenFinal.add(fp);
          return true;
        });
        deduped.push(...fresh);
        providersCalled.push(next);
      } catch { /* top-up failure is non-fatal */ }
    }
  }

  const ranked = rankRelevant(deduped, req.query, (j: any) => j.title || '', (j: any) => j.company || '')
      .map((r) => r.job);

  // Persist provider results so the NEXT identical search within 24h hits the
  // local DB and pays $0 (DB-first). Existing jobs (e.g. from V1) are enriched
  // with V2 cache fields (scrapedAt/isActive/fingerprint) instead of being
  // skipped — that's what makes isJobFresh() true on repeat searches.
  if (deduped.length > 0) {
    try {
      const db = getDb();
      const enrich = db.prepare(
        "UPDATE jobs SET data = ? WHERE user_id = ? AND json_extract(data, '$.url') = ?"
      );
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        for (const j of deduped) {
          const url = (j as any).applyUrl?.toLowerCase?.() || (j as any).url?.toLowerCase?.() || '';
          if (!url) continue;
          const existing = (db.prepare(
            "SELECT data FROM jobs WHERE user_id = ? AND json_extract(data, '$.url') = ?"
          ).get(getCurrentUserId(), url) as any)?.data;
          if (existing) {
            const parsed = JSON.parse(existing);
            const updated = {
              ...parsed,
              ...j,
              scrapedAt: (parsed as any).scrapedAt || now,
              isActive: true,
              fingerprint: (j as any).fingerprint || (parsed as any).fingerprint,
            };
            enrich.run(JSON.stringify(updated), getCurrentUserId(), url);
          } else {
            saveNewJobs([j as any]);
          }
        }
      });
      tx();
      console.log(`[SearchService] Enriched/upserted ${deduped.length} jobs for "${req.query}" (next search → cache hit, $0)`);
    } catch (err: any) {
      console.warn('[SearchService] Persist failed (non-fatal):', err?.message);
    }
  }

  const returned = ranked.slice(0, req.limit);
  markSeen(getCurrentUserId(), queryFp, returned.map((j: any) => (j as any).fingerprint || fingerprintJob(j)));
  const exhausted = returned.length < req.limit && seenSet.size + seenFinal.size >= allJobs.length;
  return {
    jobs: returned,
    providersCalled,
    cacheHit: false,
    providerResults,
    queryFp,
    seenCount: returned.length,
    totalStored: allJobs.length,
    exhausted,
  };
}
