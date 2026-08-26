export interface SearchRequest {
  query: string;
  location?: string;
  postedWithin?: '24h' | '7d' | '30d' | 'all';
  limit: number; // 5/10/15/25/50 — how many jobs user sees
  remote?: boolean;
  jobType?: string;
  experience?: string;
}

export interface FetchBudget {
  fetchTarget: number; // how many candidates to fetch to get LIMIT
  maxPerProvider: number;
  multiplier: number;
}

// Config-driven, not hard-coded 500
export const SEARCH_CONFIG = {
  FETCH_MULTIPLIER: 1.5,
  MAX_FETCH_PER_PROVIDER: 50,
  ATS_MAX_RAW_RESULTS: 50,
  SEARCH_MAX_RESULTS: 50,
};

export function getFetchBudget(limit: number): FetchBudget {
  const multiplier = Number(process.env.SEARCH_FETCH_MULTIPLIER || SEARCH_CONFIG.FETCH_MULTIPLIER);
  const maxPerProvider = Number(process.env.SEARCH_MAX_RESULTS || SEARCH_CONFIG.MAX_FETCH_PER_PROVIDER);
  const atsMax = Number(process.env.ATS_MAX_RAW_RESULTS || SEARCH_CONFIG.ATS_MAX_RAW_RESULTS);

  const fetchTarget = Math.min(Math.ceil(limit * multiplier), maxPerProvider);
  // ATS budget is separate and capped
  const atsBudget = Math.min(fetchTarget, atsMax);

  return {
    fetchTarget,
    maxPerProvider: Math.min(maxPerProvider, atsMax),
    multiplier,
  };
}

export function getProviderFetchLimit(limit: number, providerId: string): number {
  const budget = getFetchBudget(limit);
  // Santa Maria gets the ATS budget, others get per-provider budget
  if (providerId === 'santa-maria') {
    return Math.min(budget.fetchTarget, Number(process.env.ATS_MAX_RAW_RESULTS || SEARCH_CONFIG.ATS_MAX_RAW_RESULTS));
  }
  return Math.min(budget.fetchTarget, budget.maxPerProvider);
}
