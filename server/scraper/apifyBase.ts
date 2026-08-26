import { Job, JobSource, ScraperParams } from '../../src/types.js';
import { loadConfig } from '../config.js';

const RUN_SYNC_URL = (token: string, actorId: string) =>
  `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

export function readableApifyError(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail);
    detail = String(parsed?.error?.message || parsed?.message || parsed?.error || '').trim();
  } catch {
    // Non-JSON gateway/proxy response — keep a short plain-text excerpt.
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 180);
  return `Apify actor returned ${status}${detail ? `: ${detail}` : ''}`;
}

export function cleanDescription(raw: string | undefined): string {
  return (raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseApplicants(caption: string | undefined): { count?: number; caption?: string; lowCompetition?: boolean } {
  if (!caption) return {};
  const clean = String(caption).trim();
  if (!clean || /^null$/i.test(clean)) return {};
  const firstMatch = clean.match(/be among the first\s+([\d,.]+)\s+applicants?/i);
  const overMatch = clean.match(/over\s+([\d,.]+)\s+applicants?/i);
  const numMatch = clean.match(/([\d,.]+)\s*applicants?/i);
  let count: number | undefined;
  if (firstMatch) count = parseInt(firstMatch[1].replace(/,/g, ''), 10);
  else if (overMatch) count = parseInt(overMatch[1].replace(/,/g, ''), 10);
  else if (numMatch) count = parseInt(numMatch[1].replace(/,/g, ''), 10);
  if (count !== undefined && isNaN(count)) count = undefined;
  if (count === undefined) return {};
  return {
    count,
    caption: clean.charAt(0).toUpperCase() + clean.slice(1),
    lowCompetition: !!firstMatch,
  };
}

export function parseSalary(text: string | undefined): { text?: string; min?: number; max?: number } {
  if (!text) return {};
  const nums = text.match(/([\d,.]+)/g) || [];
  const parsed = nums.map((n) => parseInt(n.replace(/,/g, ''), 10)).filter((n) => !isNaN(n));
  return {
    text,
    min: parsed.length > 0 ? Math.min(...parsed) : undefined,
    max: parsed.length > 1 ? Math.max(...parsed) : undefined,
  };
}

// Actors change their output schema without warning; check every plausible
// variant so schema drift degrades gracefully instead of silently producing
// empty descriptions. If NONE match, log the actual keys (10-second fix).
const DESCRIPTION_FIELDS = [
  'descriptionHtml', 'description', 'descriptionText', 'jobDescription',
  'fullDescription', 'jobDescriptionHtml', 'descriptionPlain',
];

export function extractDescription(item: any): string {
  for (const field of DESCRIPTION_FIELDS) {
    const val = item?.[field];
    if (typeof val === 'string' && val.trim().length > 0) return val;
  }
  const nested = item?.details?.description || item?.jobDetails?.description;
  if (typeof nested === 'string' && nested.trim().length > 0) return nested;
  return '';
}

// Normalize any posted-date shape (full ISO string, bare YYYY-MM-DD, epoch
// ms, or a "N hours ago" relative caption) into an ISO string, or '' when
// unknown. The relative caption carries the finest precision the actors
// offer (minutes/hours) and is preferred over date stamps, which LinkedIn's
// actor rounds to midnight of the posting day. Bare dates use noon
// (least-biased point). Never show future dates and never fake a posting
// time with scrape time.
export function normalizeIsoDate(value: string | number | undefined, relativeCaption?: string): string {
  let rawPosted: Date | null = null;
  if (typeof value === 'number' && !isNaN(value)) {
    rawPosted = value > 1e12 ? new Date(value) : new Date(value * 1000); // ms vs s epoch
  } else if (typeof value === 'string' && value.trim()) {
    // Hour/minute captions ("34 minutes ago", "4 hours ago") override the
    // date stamp — day-level captions ("1 day ago") add no precision over
    // the date, so those fall through to the stamp.
    const rel = String(relativeCaption || '').match(/(\d+)\s*(min(?:ute)?|hour)s?\s*ago/i);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const ms = rel[2].toLowerCase() === 'min' ? n * 60000 : n * 3600000;
      rawPosted = new Date(Date.now() - ms);
    } else {
      const trimmed = value.trim();
      const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
      rawPosted = isBareDate ? new Date(`${trimmed}T12:00:00Z`) : new Date(trimmed);
    }
  }
  if (!rawPosted || isNaN(rawPosted.getTime())) return '';
  const iso = rawPosted.toISOString();
  return new Date(iso).getTime() > Date.now() + 2 * 60 * 60 * 1000 ? '' : iso;
}

// Posted-window post-filter for actors with no native date input (Upwork).
// Jobs without a postedDate are kept (unknown freshness must not nuke
// results); jobs proven older than the window are dropped.
const DATE_WINDOWS_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export abstract class ApifyBaseScraper {
  abstract readonly source: JobSource;
  abstract readonly actorId: string;
  // Populated when the actor could not complete. An empty successful dataset
  // remains null so callers can distinguish "no matching jobs" from an API,
  // quota, actor, or timeout failure.
  lastError: string | null = null;

  // Actors with a native date input (LinkedIn r86400, Indeed days, Naukri
  // jobAge, Glassdoor daysOld) already window correctly — double-filtering
  // on date-only stamps would wrongly drop fresh jobs (a job posted 23h ago
  // but dated "yesterday" is stamped noon-yesterday ≈ 30h → dropped). Only
  // actors WITHOUT a native date input opt in (Upwork has exact timestamps).
  protected readonly applyPostedWindowFilter: boolean = false;

  protected abstract buildInput(params: ScraperParams): Record<string, any>;
  protected abstract mapItem(item: any): Job | null;

  async scrape(params: ScraperParams): Promise<Job[]> {
    this.lastError = null;
    const config = loadConfig();
    const token = config.apify.token?.trim();
    if (!token || config.apify.enabled !== true) return [];

    try {
      const input = this.buildInput(params);
      const response = await fetch(RUN_SYNC_URL(token, this.actorId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(240000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.lastError = readableApifyError(response.status, body);
        console.warn(`[Apify] ${this.source} ${this.lastError}`);
        return [];
      }

      const items = await response.json();
      if (!Array.isArray(items) || items.length === 0) {
        console.log(`[Apify] ${this.source} actor returned no jobs`);
        return [];
      }

      let result = items
        .map((item) => this.mapItem(item))
        .filter((j): j is Job => j !== null);

      // Relevance: at least ONE significant keyword word must appear in the
      // title or company. Any term counts — requiring only the first term
      // wrongly drops Platform/SRE/Cloud Engineer roles that the board
      // matched. If nothing matches (odd query), keep everything.
      const terms = params.keywords.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      if (terms.length > 0) {
        const before = result.length;
        const relevant = result.filter((j) => {
          const hay = `${j.title} ${j.company}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        });
        if (relevant.length > 0) {
          console.log(`[Apify] ${before} ${this.source} fetched, ${before - relevant.length} irrelevant (no "${terms.join('" / "')}" in title/company)`);
          result = relevant;
        }
      }

      // Posted-window guarantee for actors without a native date input
      // (opt-in): drop jobs proven older than the selected window (unknown
      // dates kept).
      if (this.applyPostedWindowFilter && params.datePostedFilter && params.datePostedFilter !== 'all') {
        const windowMs = DATE_WINDOWS_MS[params.datePostedFilter];
        if (windowMs) {
          const cutoff = Date.now() - windowMs;
          const before = result.length;
          result = result.filter((j) => !j.postedDate || new Date(j.postedDate).getTime() >= cutoff);
          if (result.length !== before) {
            console.log(`[Apify] ${this.source}: ${before - result.length} jobs older than ${params.datePostedFilter} dropped (posted-window filter)`);
          }
        }
      }

      console.log(`[Apify] Got ${result.length} ${this.source} jobs via Apify`);
      return result;
    } catch (err: any) {
      // Isolated failure — callers fall back (LinkedIn) or report skipped.
      this.lastError = String(err?.message || err || 'Actor request failed').slice(0, 200);
      console.warn(`[Apify] ${this.source} failed: ${this.lastError}`);
      return [];
    }
  }
}
