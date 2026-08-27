import { queryJobs, getAllJobs } from '../storage/fileStorage.js';
import { ensureV2Tables, isJobFresh } from '../storage/v2Tables.js';
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
 * Job Search Service — DB-first, local-only.
 * Keeps V1 POST /api/jobs/scrape untouched; this is the legacy V2 path.
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

  // 8: Insufficient fresh jobs → return what we have locally. Provider
  // top-up is handled by the V2 search path (search-v2 + orchestrator);
  // this legacy service is local-only.
  return {
    jobs: rankedLocal.slice(0, params.limit),
    fromCache: true,
    totalReturned: rankedLocal.length,
  };
}
