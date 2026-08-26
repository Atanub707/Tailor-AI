// Deterministic ranking: relevance tier FIRST, freshness second, stable
// tie-breakers last. A newer weak match never outranks an older exact match;
// among equal relevance the newer posting wins.
import { evaluateRelevance, TIER_WEIGHT, type RelevanceResult } from './relevance.js';

export interface RankedJob<T> {
  job: T;
  relevance: RelevanceResult;
}

function postedTime(job: any): number {
  if (job.postedDate) {
    const t = new Date(job.postedDate).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (job.createdAt) {
    const t = new Date(job.createdAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Rank jobs by: relevance score DESC → freshness DESC → title ASC → company ASC.
 * The LIMIT is applied by the caller after ranking.
 */
export function rankByRelevance<T>(jobs: T[], query: string, titleOf: (j: T) => string, companyOf: (j: T) => string): RankedJob<T>[] {
  return jobs
    .map((job) => ({ job, relevance: evaluateRelevance(query, `${titleOf(job)} ${companyOf(job)}`) }))
    .sort((a, b) => {
      const sa = a.relevance.relevanceScore;
      const sb = b.relevance.relevanceScore;
      if (sb !== sa) return sb - sa; // tier first
      const ta = postedTime(a.job);
      const tb = postedTime(b.job);
      if (tb !== ta) return tb - ta; // then freshness
      const titleCmp = titleOf(a.job).localeCompare(titleOf(b.job));
      if (titleCmp !== 0) return titleCmp; // deterministic
      return companyOf(a.job).localeCompare(companyOf(b.job));
    });
}

/** Keep only jobs that pass the minimum relevance bar, ranked. */
export function rankRelevant<T>(jobs: T[], query: string, titleOf: (j: T) => string, companyOf: (j: T) => string, minScore = 1): RankedJob<T>[] {
  return rankByRelevance(jobs, query, titleOf, companyOf).filter((r) => r.relevance.relevanceScore >= minScore);
}

// Export the weights for tests/UI explanations.
export { TIER_WEIGHT };