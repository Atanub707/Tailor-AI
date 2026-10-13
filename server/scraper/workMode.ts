// Single source of truth for work-mode (Remote/Hybrid/On-site) detection.
//
// Previously this regex logic was copy-pasted independently in FOUR places
// (apifyScraper.ts, linkedInScraper.ts, scraperFactory.ts, fileStorage.ts),
// which is exactly how the "hybrid job leaking into a remote search" bug
// happened — one copy got fixed, the other three didn't. Everything now
// imports from here.

// Order matters: Hybrid is checked first so a posting that mentions both
// "hybrid" and "remote" (common: "hybrid, remote-friendly") is never
// mis-labeled as fully remote.
const HYBRID_RE = /\bhybrid\b|hybrid\s*(work|role|model)/i;
const HYBRID_NEGATION_RE = /no hybrid|not hybrid|non-hybrid/i;

const ONSITE_RE =
  /\bon-?site\b|\bon site\b|in-?office\b|in office|office-?based|from office|in-person|at (our|their) office|on premise|office presence/i;
const ONSITE_NEGATION_RE = /no on-?site|not on-?site|remote on-?site/i;

const REMOTE_RE =
  /\bremote\b|100%\s*(remote|tele|virtual)|\bwfh\b|work from home|remote-first|fully remote|work from anywhere|anywhere|telecommute|\bvirtual\b/i;

export type WorkMode = 'Remote' | 'Hybrid' | 'On-site' | null;

// STRONG remote phrases only — used when the sole evidence is free text
// (e.g. a job description). Weak mentions ("remote team", "remote-friendly",
// "remote work options") must NOT label a job Remote: that is how on-site
// postings leaked into Remote searches.
const STRONG_REMOTE_RE =
  /fully[- ]remote|100%\s*remote|remote[- ]first\s*(role|company|position)?|work from (home|anywhere)|remote\s+(position|role|opportunity)|this\s+(role|position)\s+is\s+(fully\s+)?remote|telecommute|fully distributed/i;

export function hasStrongRemoteSignal(text: string | undefined | null): boolean {
  return STRONG_REMOTE_RE.test(String(text || ''));
}

/**
 * Classify work mode from free-text (job description, or jobType+location
 * combined). Returns null ("not stated") rather than guessing — a job with
 * no explicit signal must never be assumed to be any particular mode.
 */
export function classifyFromText(text: string | undefined | null): WorkMode {
  const d = (text || '').toLowerCase();
  if (!d) return null;
  if (HYBRID_RE.test(d) && !HYBRID_NEGATION_RE.test(d)) return 'Hybrid';
  if (ONSITE_RE.test(d) && !ONSITE_NEGATION_RE.test(d)) return 'On-site';
  if (REMOTE_RE.test(d)) return 'Remote';
  return null;
}

/**
 * True if a job's existing jobType label contradicts the wanted search
 * mode. Only jobs EXPLICITLY classified as the opposite, mutually
 * exclusive mode are dropped:
 *
 *   remote search  -> drop jobs explicitly On-site   (Hybrid passes:
 *                     remote postings commonly mention "hybrid" options,
 *                     and a hybrid job still includes remote work)
 *   onsite search  -> drop jobs explicitly Remote    (Hybrid passes, same
 *                     reasoning)
 *   hybrid search  -> drop jobs explicitly Remote or On-site
 *
 * Jobs with an unstated/unknown mode never contradict — they pass through,
 * since we can't prove they DON'T match.
 */
export function contradictsWanted(
  jobType: string | undefined | null,
  wanted: 'remote' | 'hybrid' | 'onsite'
): boolean {
  const t = jobType || '';
  if (wanted === 'remote') return t.includes('On-site');
  if (wanted === 'onsite') return t.includes('Remote');
  if (wanted === 'hybrid') return t.includes('Remote') || t.includes('On-site');
  return false;
}

/**
 * Strict classifier for the listing filter (server/storage/fileStorage.ts).
 * Unlike classifyFromText, this returns a lowercase enum with 'unknown'
 * instead of null, and is used for EXACT filtering (an "unknown" job is
 * excluded from a remote-only search, not just "not proven otherwise").
 */
export function classifyWorkMode(job: { jobType?: string; location?: string }): 'remote' | 'hybrid' | 'onsite' | 'unknown' {
  const text = `${job.jobType || ''} ${job.location || ''}`;
  const mode = classifyFromText(text);
  if (mode === 'Hybrid') return 'hybrid';
  if (mode === 'Remote') return 'remote';
  if (mode === 'On-site') return 'onsite';
  return 'unknown';
}
