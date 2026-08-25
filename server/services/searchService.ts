import { getAllJobs, getCurrentUserId, saveNewJobs, getDb } from '../storage/fileStorage.js';
import { isJobFresh, fingerprintJob } from '../storage/v2Tables.js';
import { getFetchBudget } from '../providers/searchBudget.js';
import type { SearchRequest } from '../providers/searchBudget.js';

export interface ProviderResult {
  providerId: string;
  jobs: any[];
  requested: number;
  returned: number;
  duration: number;
  error?: string;
}

// Deterministic provider priority — no LLM
const PROVIDER_PRIORITY: Record<string, string[]> = {
  india: ['naukri', 'indeed', 'santa-maria', 'linkedin'],
  remote: ['indeed', 'santa-maria', 'linkedin', 'upwork'],
  default: ['linkedin', 'indeed', 'santa-maria', 'naukri'],
};

function getProviderOrder(location?: string, remote?: boolean): string[] {
  const loc = (location || '').toLowerCase();
  if (loc.includes('india')) return PROVIDER_PRIORITY.india;
  if (remote) return PROVIDER_PRIORITY.remote;
  return PROVIDER_PRIORITY.default;
}

function getSearchFingerprint(req: SearchRequest): string {
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
): Promise<{ jobs: any[]; providersCalled: string[]; cacheHit: boolean; providerResults: ProviderResult[] }> {
  const allJobs = getAllJobs() as any[];
  const freshJobs = allJobs.filter((j) => {
    if ((j as any).isActive === false) return false;
    if (!isJobFresh((j as any).scrapedAt)) return false;
    const hay = `${j.title} ${j.company} ${j.description || ''}`.toLowerCase();
    const terms = req.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length > 0 && !terms.some((t) => hay.includes(t))) return false;
    if (req.location && req.location.toLowerCase() !== 'anywhere' && req.location.toLowerCase() !== 'worldwide') {
      if (!hay.includes(req.location.toLowerCase())) {
        // Keep if no location in job (unknown) — don't drop
      }
    }
    return true;
  });

  if (freshJobs.length >= req.limit) {
    // Enough fresh in DB — return without calling any provider
    const ranked = [...freshJobs].sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(req.query.toLowerCase()) ? 0 : 1;
      const bTitle = b.title.toLowerCase().includes(req.query.toLowerCase()) ? 0 : 1;
      if (aTitle !== bTitle) return aTitle - bTitle;
      return (b.postedDate || '').localeCompare(a.postedDate || '');
    });
    return {
      jobs: ranked.slice(0, req.limit),
      providersCalled: [],
      cacheHit: true,
      providerResults: [],
    };
  }

  // Progressive fan-out
  const budget = getFetchBudget(req.limit);
  const needed = req.limit - freshJobs.length;
  const providerOrder = getProviderOrder(req.location, req.remote);
  const providersCalled: string[] = [];
  const providerResults: ProviderResult[] = [];
  let collected = [...freshJobs];
  const seenFingerprints = new Set(freshJobs.map((j) => (j as any).fingerprint || fingerprintJob(j)));

  for (const providerId of providerOrder) {
    if (collected.length >= req.limit) break;

    const remaining = req.limit - collected.length;
    const providerLimit = Math.min(Math.ceil(remaining * 1.2), budget.maxPerProvider);

    const start = Date.now();
    try {
      const { jobs } = await fetchFn(providerId, providerLimit);
      const duration = Date.now() - start;
      const unique = jobs.filter((j: any) => {
        const fp = (j as any).fingerprint || fingerprintJob(j);
        if (seenFingerprints.has(fp)) return false;
        seenFingerprints.add(fp);
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
  const seenFinal = new Set<string>();
  const deduped = collected.filter((j) => {
    const fp = (j as any).fingerprint || fingerprintJob(j);
    if (seenFinal.has(fp)) return false;
    seenFinal.add(fp);
    return true;
  });

  const ranked = [...deduped].sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(req.query.toLowerCase()) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(req.query.toLowerCase()) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return (b.postedDate || '').localeCompare(a.postedDate || '');
  });

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

  return {
    jobs: ranked.slice(0, req.limit),
    providersCalled,
    cacheHit: false,
    providerResults,
  };
}
