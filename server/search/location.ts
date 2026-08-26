// Location normalization + matching for the LOCAL filter stage.
// ATS location formats are wildly inconsistent ("Bengaluru, Karnataka, India",
// "Remote - India", "Hyderabad, India", "Remote", "US - Remote") — we normalize
// before comparing, and country-level search ("India") matches city+country
// strings. Pure local, no geocoding API, no LLM.

// Country name → canonical token (+ common abbreviations).
const COUNTRIES: Record<string, string> = {
  india: 'india',
  bharat: 'india',
  usa: 'usa',
  'united states': 'usa',
  'united states of america': 'usa',
  us: 'usa',
  america: 'usa',
  uk: 'uk',
  'united kingdom': 'uk',
  'great britain': 'uk',
  england: 'uk',
  australia: 'australia',
  canada: 'canada',
  germany: 'germany',
  france: 'france',
  spain: 'spain',
  italy: 'italy',
  netherlands: 'netherlands',
  poland: 'poland',
  ireland: 'ireland',
  singapore: 'singapore',
  japan: 'japan',
  brazil: 'brazil',
  mexico: 'mexico',
  'new zealand': 'new zealand',
  switzerland: 'switzerland',
  sweden: 'sweden',
  norway: 'norway',
  denmark: 'denmark',
  belgium: 'belgium',
  austria: 'austria',
  portugal: 'portugal',
  romania: 'romania',
  'united arab emirates': 'uae',
  uae: 'uae',
  dubai: 'uae',
  'hong kong': 'hong kong',
  malaysia: 'malaysia',
  indonesia: 'indonesia',
  'south africa': 'south africa',
};

// Major cities → country (so "Bengaluru" matches a search for "India").
const CITIES: Record<string, string> = {
  bengaluru: 'india',
  bangalore: 'india',
  hyderabad: 'india',
  pune: 'india',
  mumbai: 'india',
  delhi: 'india',
  'new delhi': 'india',
  gurgaon: 'india',
  gurugram: 'india',
  noida: 'india',
  chennai: 'india',
  kolkata: 'india',
  ahmedabad: 'india',
  'san francisco': 'usa',
  'new york': 'usa',
  austin: 'usa',
  seattle: 'usa',
  chicago: 'usa',
  boston: 'usa',
  'los angeles': 'usa',
  'santa clara': 'usa',
  london: 'uk',
  'manchester': 'uk',
  berlin: 'germany',
  munich: 'germany',
  'amsterdam': 'netherlands',
  paris: 'france',
  warsaw: 'poland',
  dublin: 'ireland',
  toronto: 'canada',
  vancouver: 'canada',
  sydney: 'australia',
  melbourne: 'australia',
  'singapore': 'singapore',
  tokyo: 'japan',
  'sao paulo': 'brazil',
};

/** Normalize a location string into canonical tokens (lowercase, deduped). */
export function normalizeLocation(raw?: string | string[]): string[] {
  const source = Array.isArray(raw) ? raw.join(', ') : String(raw || '');
  const out = new Set<string>();
  const s = source.toLowerCase();

  // Explicit remote/hybrid markers survive as tokens of their own.
  if (/\bremote\b|work from home|wfh|anywhere|telecommute|100%\s*remote|virtual\b/.test(s)) out.add('remote');
  if (/\bhybrid\b/.test(s)) out.add('hybrid');
  if (/\bon-?site\b|in-?office\b/.test(s)) out.add('onsite');

  // Country match (full string scan, e.g. "Remote - India", "Bengaluru, India").
  for (const [key, canonical] of Object.entries(COUNTRIES)) {
    if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) out.add(canonical);
  }
  // City → country.
  for (const [city, country] of Object.entries(CITIES)) {
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) out.add(country);
  }
  return [...out];
}

export interface LocationMatchOptions {
  remote?: boolean;      // user asked for remote-only
  allowHybridForRemote?: boolean; // treat hybrid as remote-compatible (default true, matches work-mode rules)
}

/**
 * Does a job's location satisfy the user's location constraint?
 *   searchLocation "India"  → job in Bengaluru/Hyderabad/Remote-India ✅, US ❌
 *   searchLocation "Remote" → job labelled remote ✅, hybrid ✅ (compatible), onsite ❌
 *   searchLocation empty    → everything passes (no constraint)
 */
export function matchesLocation(jobLocation: string | string[] | undefined, searchLocation?: string, opts: LocationMatchOptions = {}): boolean {
  const want = (searchLocation || '').trim().toLowerCase();
  if (!want) return true;

  const jobTokens = normalizeLocation(jobLocation);
  const wantTokens = normalizeLocation(want);

  // Remote-only request.
  if (opts.remote === true || wantTokens.includes('remote')) {
    if (jobTokens.includes('remote')) return true;
    if (opts.allowHybridForRemote !== false && jobTokens.includes('hybrid')) return true;
    return false;
  }

  // Country/city request: job must reference that country (directly or via
  // city). "Remote - India" matches "India".
  for (const w of wantTokens) {
    if (w === 'remote' || w === 'hybrid' || w === 'onsite') continue;
    if (jobTokens.includes(w)) return true;
  }
  return false;
}