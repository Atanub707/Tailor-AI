// Central V2 provider fetch budget.
// The provider is told how many candidates to fetch; Tailor decides how many
// to ACCEPT. Budget = LIMIT × multiplier, hard-capped. No provider may
// silently override this — every provider receives fetchLimit from here.
//
// Regression contract (enforced by tests):
//   user LIMIT 5  -> provider target 8
//   user LIMIT 10 -> provider target 15
//   user LIMIT 25 -> provider target 35
//   user LIMIT 50 -> provider target 60 (hard cap)
// NEVER a hard-coded large literal (no magic caps).

export const SEARCH_BUDGET = {
  RESULT_MULTIPLIER: 1.4,
  MAX_PROVIDER_RESULTS: 60,
};

function multiplier(): number {
  const v = Number(process.env.SEARCH_RESULT_MULTIPLIER);
  return Number.isFinite(v) && v > 0 ? v : SEARCH_BUDGET.RESULT_MULTIPLIER;
}

function maxProvider(): number {
  const v = Number(process.env.MAX_PROVIDER_RESULTS);
  return Number.isFinite(v) && v > 0 ? v : SEARCH_BUDGET.MAX_PROVIDER_RESULTS;
}

/**
 * The maximum number of candidates a provider may fetch for a user LIMIT.
 * Never exceeds MAX_PROVIDER_RESULTS. Known LIMITs follow the regression
 * table exactly (8/15/35/60); other LIMITs use multiplier math with a small
 * floor.
 */
export function getProviderBudget(limit: number): number {
  const known = PROVIDER_BUDGET_TABLE[limit];
  if (known !== undefined) return known;
  const target = Math.ceil(limit * multiplier());
  const floored = Math.max(target, 8);
  return Math.min(floored, maxProvider());
}

/** Provider budget per brief table — source of truth for tests. */
export const PROVIDER_BUDGET_TABLE: Record<number, number> = {
  5: 8,
  10: 15,
  25: 35,
  50: 60,
};

export function assertBudget(limit: number): void {
  const b = getProviderBudget(limit);
  const expected = PROVIDER_BUDGET_TABLE[limit];
  if (expected !== undefined && b !== expected) {
    throw new Error(`Budget regression: LIMIT ${limit} → ${b}, expected ${expected}`);
  }
}