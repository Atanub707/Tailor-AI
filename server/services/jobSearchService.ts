import { queryJobs, saveNewJobs, getAllJobs } from '../storage/fileStorage.js';
import { ensureV2Tables, fingerprintJob, isJobFresh, normalizeUrl } from '../storage/v2Tables.js';
import { SantaMariaApifyProvider } from '../providers/santaMariaProvider.js';
import type { Job } from '../../src/types.js';

export interface SearchParams {
  keywords: string; // "DevOps Engineer"
  location?: string;
  remote?: boolean;
  atsPlatforms?: string[];
  limit: number; // 5/10/15/25/50
}

export interface SearchResult {
  jobs: Job[];
  fromCache: boolean;
  providerRunId?: string;
  totalReturned: number;
}

/**
 * Job Search Service — DB-first, Santa Maria on miss.
 * Keeps V1 POST /api/jobs/scrape untouched; this is the V2 path.
 */
export async function searchJobsV2(params: SearchParams, userId: string): Promise<SearchResult> {
  ensureV2Tables();

  const keywords = params.keywords.trim().toLowerCase();
  const terms = keywords.split(/\s+/).filter((t) => t.length > 2);

  // 1-8: Search local DB
  const localJobs = getAllJobs() as Job[];
  const freshLocal = localJobs.filter((j) => {
    if ((j as any).isActive === false) return false;
    if (!isJobFresh((j as any).scrapedAt)) return false;
    // Keyword relevance: title/department/description must contain at least one term
    if (terms.length > 0) {
      const hay = `${j.title} ${j.company} ${j.description || ''} ${(j as any).department || ''}`.toLowerCase();
      if (!terms.some((t) => hay.includes(t))) return false;
    }
    // Location / remote filter
    if (params.remote && !(j as any).remote && !j.location?.toLowerCase().includes('remote')) {
      // Keep if no remote flag but location is not filtered strictly for now
    }
    return true;
  });

  // Simple rank: title exact match first, then description
  const rankedLocal = [...freshLocal].sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(keywords) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(keywords) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return (b.postedDate || '').localeCompare(a.postedDate || '');
  });

  if (rankedLocal.length >= params.limit) {
    return {
      jobs: rankedLocal.slice(0, params.limit),
      fromCache: true,
      totalReturned: rankedLocal.length,
    };
  }

  // 8: Insufficient fresh jobs → invoke Santa Maria (if configured)
  try {
    const provider = new SantaMariaApifyProvider();
    const result = await provider.search({
      keywords: params.keywords.split(/\s+/),
      locations: params.location ? [params.location] : undefined,
      remote: params.remote,
      atsPlatforms: params.atsPlatforms as any,
      limit: params.limit,
      queries: [], // Will use company registry; empty for now means provider builds default
    });

    // Normalize + deduplicate + persist
    const normalized = result.jobs.map((j) => ({
      ...j,
      fingerprint: (j as any).fingerprint || fingerprintJob(j as any),
      isActive: true,
      scrapedAt: new Date().toISOString(),
      provider: 'santa-maria',
      providerRunId: result.providerRunId,
    }));

    // Deduplicate by fingerprint against local
    const existingFingerprints = new Set(localJobs.map((j) => (j as any).fingerprint).filter(Boolean));
    const newJobs = normalized.filter((j) => !existingFingerprints.has((j as any).fingerprint));

    if (newJobs.length > 0) {
      saveNewJobs(newJobs as Job[]);
    }

    const combined = [...rankedLocal, ...newJobs];
    // Deduplicate combined by normalized applyUrl
    const seen = new Set<string>();
    const deduped = combined.filter((j) => {
      const key = (j as any).fingerprint || normalizeUrl((j as any).applyUrl || j.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const ranked = [...deduped].sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(keywords) ? 0 : 1;
      const bTitle = b.title.toLowerCase().includes(keywords) ? 0 : 1;
      if (aTitle !== bTitle) return aTitle - bTitle;
      return (b.postedDate || '').localeCompare(a.postedDate || '');
    });

    return {
      jobs: ranked.slice(0, params.limit),
      fromCache: false,
      providerRunId: result.providerRunId,
      totalReturned: result.totalReturned,
    };
  } catch (e) {
    // On provider failure, return what we have locally
    return {
      jobs: rankedLocal.slice(0, params.limit),
      fromCache: true,
      totalReturned: rankedLocal.length,
    };
  }
}
