// JD-on-demand resolver — Tailor/Score must operate on the REAL job
// description, never title+company pretending to be a JD.
//
// Flow: job → meaningful cached description? → return as-is (0 network).
//       → Greenhouse + missing → ONE public detail request
//         (boards-api.greenhouse.io/v1/boards/{slug}/jobs/{externalId}) →
//         sanitize → validate → persist on the user's durable job → return.
//       → failure → throw JDResolutionError — the caller must NOT invoke
//         the LLM.
//
// The ATS index is intentionally description-light (search optimization);
// full JDs are fetched LAZILY per user action — never bulk-crawled.
import type { Job } from '../../src/types.js';
import { getDb, updateJobInStorage } from '../storage/fileStorage.js';
import { stripHtml } from '../providers/directAtsProvider.js';

export class JDResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JDResolutionError';
  }
}

// Conservative minimum: a REAL JD is more than a title/company fragment.
// Small valid postings can be brief — 80 chars of meaningful text is the bar.
export const MIN_JD_LENGTH = 80;

/** Strip scripts/styles, then convert HTML structure to readable text. */
export function sanitizeDescription(html: string): string {
  // The Greenhouse detail endpoint returns content ENTITY-ENCODED
  // (&lt;h3&gt;), so entities must decode BEFORE the tag-strip — otherwise
  // the decoded tags reappear after stripping.
  const decoded = String(html || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
  const withoutActive = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Strip page chrome so a full-page fetch yields the posting, not the nav.
  const withoutChrome = withoutActive
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  const text = stripHtml(withoutChrome);
  // Restore list structure: bullet markers for li/ul lists are already newline
  // separated by stripHtml; re-collapse runs of blank lines.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function isMeaningfulDescription(text: string | undefined | null): boolean {
  const t = String(text || '').trim();
  if (t.length < MIN_JD_LENGTH) return false;
  // A lone title/company echo is not a JD.
  if (!/\s/.test(t) && t.length < 200) return false;
  return true;
}

function timeoutFetch(url: string, timeoutMs = 15000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'TailorAI/1.0' } });
}

/** Greenhouse detail identity from the durable job + the ATS index. */
function greenhouseIdentity(job: Job): { slug: string; externalId: string } | null {
  // Canonical: the ats_jobs row carries company_slug + external_id keyed by
  // the same fingerprint the durable job uses.
  try {
    const row = getDb().prepare('SELECT company_slug, external_id FROM ats_jobs WHERE fingerprint = ?').get(job.fingerprint || job.id) as
      | { company_slug: string; external_id: string }
      | undefined;
    if (row && row.company_slug && row.external_id) {
      return { slug: row.company_slug, externalId: row.external_id };
    }
  } catch { /* index row may not exist (non-ATS or pre-index jobs) */ }
  // Fallback: parse the job URL (boards.greenhouse.io/{slug}/jobs/{id}).
  const u = String(job.url || job.applyUrl || '');
  const urlMatch = u.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (urlMatch) return { slug: urlMatch[1], externalId: urlMatch[2] };
  // Fallback: gh_jid query param + slug from host path if present.
  const ghJid = u.match(/[?&]gh_jid=(\d+)/);
  if (ghJid) {
    const slug = u.match(/https?:\/\/[^/]+\/([^/?]+)/);
    if (slug) return { slug: slug[1], externalId: ghJid[1] };
  }
  return null;
}

async function fetchGreenhouseJd(slug: string, externalId: string): Promise<string> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`;
  let res: Response;
  try {
    res = await timeoutFetch(url);
  } catch (err: any) {
    if (/abort|timeout/i.test(String(err?.name || ''))) {
      throw new JDResolutionError('Greenhouse JD request timed out — please try again.');
    }
    throw new JDResolutionError(`Greenhouse JD request failed: ${String(err?.message || err).slice(0, 120)}`);
  }
  if (res.status === 404) {
    throw new JDResolutionError('Job posting not found at the provider (404).');
  }
  if (!res.ok) {
    throw new JDResolutionError(`Greenhouse JD request failed (HTTP ${res.status}).`);
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data.content !== 'string' || !data.content.trim()) {
    throw new JDResolutionError('Job posting returned no description content.');
  }
  return sanitizeDescription(data.content);
}

/** Many boards embed schema.org JobPosting JSON-LD — its `description` is the
 *  CLEAN posting HTML (no nav/footer chrome, no duplicated widgets). */
function extractJobPostingLd(rawHtml: string): string | null {
  const blocks = [...rawHtml.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    try {
      const parsed = JSON.parse(String(m[1] || '').trim());
      const nodes = Array.isArray(parsed) ? parsed : (parsed && parsed['@graph'] ? parsed['@graph'] : [parsed]);
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const type = (node as any)['@type'];
        const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
        if (!isJobPosting) continue;
        const desc = (node as any).description;
        if (typeof desc === 'string' && desc.trim()) {
          const text = sanitizeDescription(desc);
          if (isMeaningfulDescription(text)) return text;
        }
      }
    } catch { /* malformed JSON-LD block — try the next one */ }
  }
  return null;
}

/** Fetch the public posting page itself. Aggregator/remote boards (RemoteJobs
 *  rows: Arbeitnow, RemoteOK, Remotive, Himalayas, Jobicy…) frequently ship
 *  list payloads WITHOUT descriptions, while their posting pages are public
 *  and fully readable. Best-effort: null when the page can't provide a real JD. */
async function fetchDirectJd(job: Job): Promise<string | null> {
  const url = String((job as any).jobUrl || job.url || job.applyUrl || '');
  if (!/^https?:\/\//i.test(url)) return null;
  let res: Response;
  try {
    res = await timeoutFetch(url, 20000);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = String(res.headers?.get?.('content-type') || '');
  if (contentType && !/html|text/i.test(contentType)) return null;
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    return null;
  }
  if (!raw || raw.length > 3_000_000) return null;
  const text = extractJobPostingLd(raw) || sanitizeDescription(raw);
  return isMeaningfulDescription(text) ? text : null;
}

/**
 * Ensure a job carries a meaningful full JD. Returns the (possibly
 * description-enriched) job; throws JDResolutionError when the JD cannot be
 * resolved — callers must NOT proceed to the LLM in that case.
 */
export async function ensureJobDescription(job: Job, opts: { force?: boolean } = {}): Promise<Job> {
  if (!opts.force && isMeaningfulDescription(job.description)) return job;

  const isGreenhouse = String(job.source || job.atsPlatform || '').toLowerCase() === 'greenhouse';
  if (!isGreenhouse) {
    // Aggregator/remote-board rows + any other provider: read the public
    // posting page. If that fails too, surface honestly (never fabricate).
    const direct = await fetchDirectJd(job);
    if (direct) {
      return updateJobInStorage({ ...job, description: direct } as Job);
    }
    throw new JDResolutionError("Couldn't read this job's description from the posting page (it may require a login or render via JavaScript). Open the posting via View to review it, or apply for the role manually.");
  }

  const identity = greenhouseIdentity(job);
  if (!identity) {
    throw new JDResolutionError("Couldn't resolve this job's provider identity. Please open the job posting to review it.");
  }

  const jd = await fetchGreenhouseJd(identity.slug, identity.externalId);
  if (!isMeaningfulDescription(jd)) {
    throw new JDResolutionError('The job posting returned an incomplete description.');
  }

  // Persist on the USER's durable job (the record the user acted on) so
  // repeated Tailor/Score actions need zero provider requests. The shared
  // ats_jobs index stays description-light on purpose.
  const enriched = updateJobInStorage({ ...job, description: jd } as Job);
  return enriched;
}