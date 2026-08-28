// Location normalization + matching for the LOCAL filter stage.
// ATS location formats are wildly inconsistent ("Bengaluru, Karnataka, India",
// "Remote - India", "Hyderabad, India", "Remote", "US - Remote") — we normalize
// before comparing, and country-level search ("India") matches city+country
// strings. Pure local, no geocoding API, no LLM.
//
// PERFORMANCE CONTRACT: matchesLocation() is a FAST PATH over the original
// matcher (kept verbatim as matchesLocationRef/normalizeLocationRef and used
// as the correctness fallback). The fast path may ONLY reject a candidate
// when a non-match is CERTAIN (alias-substring absence implies no regex can
// match); anything uncertain falls through to the reference implementation.
// Results are therefore bit-identical to the reference — equivalence is
// regression-tested.

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

// ── Precompiled structures (built ONCE — the reference rebuilt these
//    RegExps on every call, per candidate). Semantics identical. ──
type AliasEntry = { re: RegExp; canonical: string };
const COUNTRY_ENTRIES: AliasEntry[] = Object.entries(COUNTRIES).map(([key, canonical]) => ({
  re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  canonical,
}));
const CITY_ENTRIES: AliasEntry[] = Object.entries(CITIES).map(([city, country]) => ({
  re: new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  canonical: country,
}));

// Alias substrings that could produce each canonical token — used by the
// certain-reject prepass. If NONE of these appear in a candidate's raw
// location string, no word-boundary regex can match, so the token is
// impossible. Derived from the same maps — they cannot drift.
const TOKEN_ALIASES: Record<string, string[]> = {};
for (const [key, canonical] of Object.entries(COUNTRIES)) (TOKEN_ALIASES[canonical] ??= []).push(key);
for (const [city, country] of Object.entries(CITIES)) (TOKEN_ALIASES[country] ??= []).push(city);

// Marker substrings for remote/hybrid/onsite detection. A substring is a
// SUPERSET of every regex match (a word-boundary match implies the literal
// text is present), so substring-absence ⇒ regex-absence is certain.
const REMOTE_MARKERS = ['remote', 'work from home', 'wfh', 'anywhere', 'telecommute', 'virtual'];
const HYBRID_MARKERS = ['hybrid'];
const ONSITE_MARKERS = ['onsite', 'on-site', 'on site', 'in-office', 'in office', 'office', 'in-person', 'on premise'];
const MARKER_TOKENS = new Set(['remote', 'hybrid', 'onsite']);

// ── Bounded memos (per-process; deterministic functions only) ──
const NORM_CACHE = new Map<string, string[]>();
const NORM_CACHE_MAX = 4096;
const WANT_CACHE = new Map<string, string[]>();
const WANT_CACHE_MAX = 256;

function containsAnySubstr(s: string, subs: string[]): boolean {
  for (const sub of subs) {
    if (s.includes(sub)) return true;
  }
  return false;
}

/** True if any wanted token's alias substrings appear in the raw string. */
function wantedAliasPresent(s: string, wantTokens: string[]): boolean {
  for (const tok of wantTokens) {
    if (MARKER_TOKENS.has(tok)) continue; // marker tokens take the remote path
    const aliases = TOKEN_ALIASES[tok];
    if (aliases && containsAnySubstr(s, aliases)) return true;
    // Unknown token (not derivable from the maps): cannot precheck — treat as
    // "maybe", the reference decides.
    if (!aliases) return true;
  }
  return false;
}

/**
 * REFERENCE normalization — verbatim original. Kept exported so the
 * equivalence tests can prove the optimized path is bit-identical.
 */
export function normalizeLocationRef(raw?: string | string[]): string[] {
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

/** Normalize a location string into canonical tokens (lowercase, deduped). */
export function normalizeLocation(raw?: string | string[]): string[] {
  const source = Array.isArray(raw) ? raw.join(', ') : String(raw || '');
  const hit = NORM_CACHE.get(source);
  if (hit) return hit.slice(); // copy — callers must never mutate cached state
  const out = normalizeLocationRef(raw);
  if (NORM_CACHE.size >= NORM_CACHE_MAX) NORM_CACHE.clear();
  NORM_CACHE.set(source, out);
  return out;
}

export interface LocationMatchOptions {
  remote?: boolean;      // user asked for remote-only
  allowHybridForRemote?: boolean; // treat hybrid as remote-compatible (default true, matches work-mode rules)
}

/**
 * REFERENCE matcher — verbatim original. The correctness fallback: the
 * optimized path only short-circuits CERTAIN rejections, everything else
 * lands here.
 */
export function matchesLocationRef(jobLocation: string | string[] | undefined, searchLocation?: string, opts: LocationMatchOptions = {}): boolean {
  const want = (searchLocation || '').trim().toLowerCase();
  if (!want) return true;

  const jobTokens = normalizeLocationRef(jobLocation);
  const wantTokens = normalizeLocationRef(want);

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

function wantTokensFor(want: string): string[] {
  const hit = WANT_CACHE.get(want);
  if (hit) return hit;
  const tokens = normalizeLocationRef(want);
  if (WANT_CACHE.size >= WANT_CACHE_MAX) WANT_CACHE.clear();
  WANT_CACHE.set(want, tokens);
  return tokens;
}

/**
 * Does a job's location satisfy the user's location constraint?
 * FAST PATH over matchesLocationRef with a certain-reject prepass:
 *   1. remote-only want → reject iff no remote/hybrid marker is present
 *      (a marker regex match always implies the literal substring)
 *   2. country/city want → reject iff no alias substring of ANY wanted
 *      token is present (an alias regex match always implies the literal)
 *   3. anything uncertain → the reference matcher decides (unchanged logic)
 */
export function matchesLocation(jobLocation: string | string[] | undefined, searchLocation?: string, opts: LocationMatchOptions = {}): boolean {
  const want = (searchLocation || '').trim().toLowerCase();
  // Empty AND the UI's neutral 'Worldwide' placeholder mean "no location
  // constraint" — except remote-only requests, which still require an actual
  // remote marker (reference semantics preserved there).
  if (!want || want === 'worldwide') {
    return opts.remote === true ? matchesLocationRef(jobLocation, searchLocation, opts) : true;
  }

  const wantTokens = wantTokensFor(want);
  const raw = Array.isArray(jobLocation) ? jobLocation.join(', ') : String(jobLocation || '');
  const s = raw.toLowerCase();

  if (opts.remote === true || wantTokens.includes('remote')) {
    const hybridAllowed = opts.allowHybridForRemote !== false;
    if (!containsAnySubstr(s, REMOTE_MARKERS) && (!hybridAllowed || !containsAnySubstr(s, HYBRID_MARKERS))) {
      return false; // CERTAIN reject — no marker regex can match this string
    }
  } else if (!wantedAliasPresent(s, wantTokens)) {
    return false; // CERTAIN reject — no alias regex can produce a wanted token
  }

  // Uncertain → the reference implementation is the correctness fallback.
  return matchesLocationRef(jobLocation, searchLocation, opts);
}