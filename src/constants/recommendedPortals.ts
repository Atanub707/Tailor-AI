// Curated by us, not by the data. Wellfound's sign-up goes through our
// referral link, so users who join through it support the project — that is
// the product reason these two are surfaced as a standing filter.
export const RECOMMENDED_PORTALS = [
  'LinkedIn Jobs',
  'Wellfound (AngelList)',
] as const;

export type RecommendedPortal = (typeof RECOMMENDED_PORTALS)[number];

export const RECOMMENDED_SET: ReadonlySet<string> = new Set(RECOMMENDED_PORTALS);

export const RECOMMENDED_REASON =
  'Curated picks that work best with Tailor CV. Creating a Wellfound account through our referral link supports the project.';
