// V2 search orchestrator — cache-first, provider top-up, relevance pipeline.
//
// Flow per spec:
//   UI → orchestrator → query fingerprint → cache?
//   cache hit (enough) → ranked cached candidates
//   else → primary provider → normalize → relevance guard (DROP score=0
//   unconditionally) → date/location/work-mode filters → dedupe → rank →
//   top-up for shortage → return LIMIT → store short-TTL candidates.
//   User-interacted candidates are promoted to durable jobs by the caller.

import { getDb, runWithUser, getCurrentUserId } from '../storage/fileStorage.js';
import { canonicalQueryFp, getOrCreateSearch, linkJobsToSearch } from '../storage/v2Tables.js';
import { evaluateRelevance, type MatchTier } from './relevance.js';
import { rankRelevant } from './rank.js';
import { matchesLocation } from './location.js';
import { getProviderBudget } from '../providers/providerBudget.js';
import { getCachedCandidates, storeCandidates, type CachedCandidate } from './searchCache.js';
import type { JobSearchParams, JobSearchProvider, NormalizedJob, ProviderSearchResult } from '../providers/types.js';

export interface ProviderCall {
  id: string;
  requested: number;
  returned: number;
  accepted: number;
  error?: string;
}

export interface OrchestratorResult {
  searchId: string;
  queryFp: string;
  cacheHit: boolean;
  requestedLimit: number;
  returnedCount: number;
  jobs: NormalizedJob[];
  providers: ProviderCall[];
}

const TIER_ORDER: Record<MatchTier, number> = {
  exact: 0,
  strong_related: 1,
  related: 2,
  weak_related: 3,
  irrelevant: 4,
};

// Re-export the relevance guard so the pipeline is explicit.
export { applyRelevanceGuard } from './relevance.js';

/**
 * Run the full V2 pipeline for one user request.
 * `providers` is the ordered enabled provider list (from providerRegistry).
 */
export async function runV2Search(
  userId: string,
  params: JobSearchParams,
  providers: JobSearchProvider[]
): Promise<OrchestratorResult> {
  // The cache fingerprint isolates every user-visible filter: source, work
// mode and job type. A remote-only "DevOps Engineer" search must NEVER
// reuse an all-modes cache (candidates are stored post-filter).
  const queryFp = canonicalQueryFp(params.keywords, params.location, params.postedWindow || 'any', `${params.source}|${params.workMode || 'all'}|${params.jobType || 'all'}`);
  // The search CONTEXT is source-isolated too (same filterKey pattern as the
  // V1 scrape path): a Greenhouse "DevOps Engineer" search never reuses a
  // Lever or Ashby context for the same query.
  const searchId = getOrCreateSearch(userId, params.keywords, params.location, params.postedWindow || 'all', params.source);
  const providerCalls: ProviderCall[] = [];

  // ── Step 1: cache ──
  let cached = getCachedCandidates(userId, queryFp);
  let cacheHit = cached.length >= params.limit;

  // ── Step 2: top-up from providers until we have >= LIMIT (or exhausted) ──
  let candidates: CachedCandidate[] = [...cached];
  const seen = new Set(candidates.map((c) => c.fingerprint));

  for (const provider of providers) {
    if (candidates.length >= params.limit) break;
    if (!provider.supports(params)) continue;

    const remaining = params.limit - candidates.length;
    const budget = getProviderBudget(remaining);
    let result: ProviderSearchResult;
    try {
      result = await provider.search(params, budget);
    } catch (err: any) {
      // Provider failure must never crash the search — record and continue.
      providerCalls.push({ id: provider.id, requested: budget, returned: 0, accepted: 0, error: err?.message || 'provider error' });
      continue;
    }
    providerCalls.push({ id: provider.id, requested: budget, returned: result.returnedCount, accepted: 0 });

    const accepted = acceptResults(result.jobs, params, queryFp);
    providerCalls[providerCalls.length - 1].accepted = accepted.length;

    for (const job of accepted) {
      if (seen.has(job.fingerprint)) continue; // dedupe across providers
      seen.add(job.fingerprint);
      candidates.push({
        fingerprint: job.fingerprint,
        provider: job.source || provider.id,
        job,
        relevanceScore: jobRelevance(job, params.keywords).score,
        matchType: jobRelevance(job, params.keywords).matchType,
        discoveredAt: new Date().toISOString(),
      });
    }
  }

  // ── Step 3: rank (relevance DESC → tier → freshness → tie-breaker) ──
  const ranked = [...candidates].sort((a, b) => {
    const sa = b.relevanceScore - a.relevanceScore;
    if (sa !== 0) return sa;
    const ta = TIER_ORDER[(a.matchType as MatchTier) || 'related'];
    const tb = TIER_ORDER[(b.matchType as MatchTier) || 'related'];
    if (ta !== tb) return ta - tb;
    const da = a.job.postedDate ? new Date(a.job.postedDate).getTime() : 0;
    const db = b.job.postedDate ? new Date(b.job.postedDate).getTime() : 0;
    if (db !== da) return db - da;
    return `${a.job.company}|${a.job.title}`.localeCompare(`${b.job.company}|${b.job.title}`);
  }).slice(0, params.limit);

  // ── Step 4: store candidates (short TTL) + link to search context ──
  storeCandidates(userId, queryFp, ranked);
  linkJobsToSearch(searchId, ranked.map((c) => c.fingerprint));

  return {
    searchId,
    queryFp,
    cacheHit,
    requestedLimit: params.limit,
    returnedCount: ranked.length,
    jobs: ranked.map((c) => c.job),
    providers: providerCalls,
  };
}

// ── Local filter pipeline: hard validity → date → location → work-mode → relevance ──
function acceptResults(jobs: NormalizedJob[], params: JobSearchParams, queryFp: string): NormalizedJob[] {
  return jobs.filter((j) => {
    // Hard validity.
    if (!j.title || (!j.applyUrl && !j.url)) return false;
    // Date — Tailor always revalidates, provider-side is a bonus.
    if (!withinWindow(j, params.postedWindow)) return false;
    // Location — matches the requested PLACE only. Work-mode (remote/hybrid/
    // on-site) is a separate filter below: a "Remote" work-mode search must
    // not turn the location matcher remote-only (a Bengaluru office job
    // described as Remote would otherwise be wrongly rejected). The user's
    // location choice 'Remote' is handled by the matcher's own want-tokens.
    if (!matchesLocation(j.location, params.location)) return false;
    // Work-mode.
    if (params.workMode && params.workMode !== 'all') {
      const wm = detectWorkMode(j);
      if (wm && params.workMode !== wm) return false;
    }
    // Relevance — DROP score=0 unconditionally (never a conditional guard).
    const rel = jobRelevance(j, params.keywords);
    if (rel.score <= 0) return false;
    return true;
  });
}

function withinWindow(j: NormalizedJob, window?: string): boolean {
  if (!window || window === 'any') return true;
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[window as '24h' | '7d' | '30d'];
  const ts = j.postedDate ? new Date(j.postedDate).getTime() : NaN;
  if (!Number.isFinite(ts)) return false; // unknown timestamp fails strict windows
  return Date.now() - ts <= hours * 60 * 60 * 1000;
}

function detectWorkMode(j: NormalizedJob): 'remote' | 'hybrid' | 'onsite' | undefined {
  const s = `${j.location || ''} ${j.description || ''}`.toLowerCase();
  if (/\bhybrid\b/.test(s)) return 'hybrid';
  if (/\bremote\b|work from home|wfh\b|anywhere/.test(s)) return 'remote';
  if (/\bon-?site\b|in-?office\b/.test(s)) return 'onsite';
  return undefined;
}

function jobRelevance(j: NormalizedJob, query: string): { score: number; matchType: string } {
  const r = evaluateRelevance(query, `${j.title} ${j.company}`);
  return { score: r.relevanceScore, matchType: r.matchType };
}

// ── Promotion: cached candidate → durable job (called on Tailor/Apply/Save) ──
export function promoteCandidate(userId: string, candidate: NormalizedJob): void {
  runWithUser(userId, () => {
    const db = getDb();
    const existing = db.prepare('SELECT data FROM jobs WHERE user_id = ? AND id = ?').get(userId, candidate.fingerprint) as { data: string } | undefined;
    const job = existing ? JSON.parse(existing.data) : candidate;
    if (!existing) {
      const full = {
        ...candidate,
        id: candidate.fingerprint,
        source: candidate.source,
        atsPlatform: candidate.atsPlatform,
        url: candidate.applyUrl || candidate.url,
        applyUrl: candidate.applyUrl,
        postedDate: candidate.postedDate,
        postedDateSemantics: candidate.postedDateSemantics,
        state: 'pending',
        createdAt: new Date().toISOString(),
        scrapedAt: new Date().toISOString(),
        fingerprint: candidate.fingerprint,
      };
      db.prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)').run(full.id, userId, JSON.stringify(full));
    }
  });
}

export { getCurrentUserId };