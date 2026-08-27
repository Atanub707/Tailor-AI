import type { Job } from '../../src/types.js';
import { getDb } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';
import { loadConfig } from '../config.js';

/**
 * Direct free-API provider — Greenhouse, Lever, Ashby, SmartRecruiters all
 * publish OPEN job APIs (no key, no Apify credits). This is the default path
 * for those three; no paid-actor fallback in V1
 * no public API.
 *
 * Budget rule (same as searchBudget.ts): fetch up to 50 jobs per company,
 * never more; the caller's LIMIT caps what we keep.
 */

const API_BASE: Record<string, string> = {
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards',
  lever: 'https://api.lever.co/v0/postings',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board',
  smartrecruiters: 'https://api.smartrecruiters.com/v1/companies',
};

const SLUG_RE: Record<string, RegExp> = {
  greenhouse: /boards\.greenhouse\.io\/([^/]+)/,
  lever: /jobs\.lever\.co\/([^/]+)/,
  ashby: /jobs\.ashbyhq\.com\/([^/]+)/,
  smartrecruiters: /careers\.smartrecruiters\.com\/([^/]+)/,
};

// Priority boards are ALWAYS checked so results are never empty; remaining
// slots rotate through the long tail (offset advances every 30 min).
const PRIORITY_BY_PLATFORM: Record<string, string[]> = {
  greenhouse: ['stripe', 'airbnb', 'datadog', 'reddit', 'dropbox', 'coinbase', 'instacart', 'roblox', 'duolingo', 'gitlab', 'mongodb', 'twilio', 'webflow', 'vercel', 'databricks', 'chime', 'gusto', 'brex', 'nubank', 'asana', 'okta'],
  lever: ['palantir', 'kraken'],
  ashby: ['openai', 'notion', 'perplexity', 'linear', 'reddit'],
  smartrecruiters: ['amazon', 'airbnb', 'dropbox', 'palantir', 'perplexity'],
};

function pickBoards(platform: string, cap: number): { companyName: string; slug: string }[] {
  ensureV2Tables();
  const db = getDb();
  const priorities = (PRIORITY_BY_PLATFORM[platform] || []).map((s) => `%/${s}%` as const);
  const where = `LOWER(atsPlatform) = ?`;
  const args: any[] = [platform];
  // Priority boards ALWAYS included (results never empty); the tail rotates
  // each search so repeated searches explore new boards instead of returning
  // the same jobs ("all already in your job list" every time).
  const prioRows = priorities.length
    ? (db.prepare(`SELECT companyName, careerUrl FROM company_career_sites WHERE isActive = 1 AND ${where} AND (${priorities.map(() => `careerUrl LIKE ?`).join(' OR ')}) ORDER BY rowid LIMIT 3`).all(...args, ...priorities) as { companyName: string; careerUrl: string }[])
    : [];
  const tailRows = db.prepare(`SELECT companyName, careerUrl FROM company_career_sites WHERE isActive = 1 AND ${where} ORDER BY rowid`).all(...args) as { companyName: string; careerUrl: string }[];
  const tail = tailRows.filter((r) => !priorities.some((p) => r.careerUrl.toLowerCase().includes(p.slice(1, -1))));
  const tailCap = Math.max(cap - prioRows.length, 1);
  // Advance ~1 board per 15s of wall clock — each search lands on a fresh
  // slice; wraps so every board is eventually reached.
  const offset = Math.floor(Date.now() / 15000) % Math.max(tail.length, tailCap);
  const slice = [...tail.slice(offset), ...tail.slice(0, offset)].slice(0, tailCap);
  return [...prioRows, ...slice]
    .map((r) => {
      const m = (r.careerUrl || '').match(SLUG_RE[platform]);
      return m ? { companyName: r.companyName, slug: m[1] } : null;
    })
    .filter((x): x is { companyName: string; slug: string } => !!x);
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'TailorAI/1.0' } });
  if (!res.ok) throw new Error(`${url.split('/')[2]} API ${res.status}`);
  return res.json();
}

// Single source of truth for board API URLs — shared by the interactive
// search path (scrapeDirectAts) and the board-level watcher fetch.
function boardUrl(platform: string, slug: string): string {
  const base = API_BASE[platform];
  return `${base}/${encodeURIComponent(slug)}${platform === 'lever' ? '?mode=json' : ''}${platform === 'greenhouse' ? '/jobs' : ''}`;
}

// ── Normalizers → Job (source tagged by caller) ──────────────────────────────
// Date handling rules (NEVER guess semantics):
//   * Greenhouse exposes first_published (true posting date) AND updated_at —
//     first_published is canonical. updated_at is only a fallback when the
//     board hides first_published, and is then labelled dateSemantics=updated.
//   * Lever exposes createdAt (ms epoch) — the posting creation date.
//   * Ashby exposes publishedAt — the posting date.
//   * SmartRecruiters exposes releasedDate/publicationDate — posting dates.
// The first element of the returned tuple is the FILTERING timestamp; the
// second is the semantics label.
export function normalizeDates(
  publishedRaw: string | number | undefined,
  createdRaw: string | number | undefined,
  updatedRaw: string | number | undefined,
  preferUpdatedOnly = false
): { ts?: string; semantics: 'published' | 'created' | 'updated' | 'unknown' } {
  const toIso = (v: string | number | undefined): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    const t = Number.isFinite(n) && !String(v).includes('-') && n > 1e12 ? new Date(n).getTime() : new Date(String(v)).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  };
  const published = toIso(publishedRaw);
  if (published) return { ts: published, semantics: 'published' };
  const created = toIso(createdRaw);
  if (created && !preferUpdatedOnly) return { ts: created, semantics: 'created' };
  const updated = toIso(updatedRaw);
  if (updated) return { ts: updated, semantics: 'updated' };
  return { semantics: 'unknown' };
}

// Greenhouse: first_published is the canonical posting date. updated_at is
// NEVER presented as a posting date when first_published exists.
function ghJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.absolute_url || j.id;
  if (!j.title || !url) return null;
  const description = stripHtml(j.content || '');
  const d = normalizeDates(j.first_published, undefined, j.updated_at);
  return {
    id: `gh-${j.id}`,
    externalId: String(j.id),
    title: j.title,
    company: j.company_name || companyName,
    companyId: companyName,
    location: j.location?.name,
    locations: j.location ? [j.location.name].filter(Boolean) : undefined,
    department: j.departments?.[0]?.name,
    employmentType: undefined,
    remote: /remote/i.test(String(j.location?.name || '')),
    description,
    atsPlatform: platform as any,
    jobUrl: url,
    applyUrl: url,
    url,
    source: 'Custom' as any,
    postedDate: d.ts,
    postedDateSemantics: d.semantics,
    createdAt: d.semantics === 'created' ? d.ts : undefined,
    updatedAt: j.updated_at ? new Date(j.updated_at).toISOString() : undefined,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `gh-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

// Lever: createdAt (ms epoch) is the posting creation date.
function leverJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.hostedUrl || j.applyUrl;
  if (!j.text || !url) return null;
  const d = normalizeDates(undefined, j.createdAt, j.createdAt);
  return {
    id: `lev-${j.id}`,
    externalId: String(j.id),
    title: j.text,
    company: companyName,
    companyId: companyName,
    location: j.categories?.location || j.workplaceType,
    locations: j.categories?.allLocations?.map((l: any) => l.location) || undefined,
    department: j.categories?.team,
    employmentType: j.categories?.commitment,
    remote: /remote|anywhere/i.test(String(j.workplaceType || j.categories?.location || '')),
    description: j.descriptionPlain || stripHtml(j.description || ''),
    atsPlatform: platform as any,
    jobUrl: url,
    applyUrl: url,
    url,
    source: 'Custom' as any,
    postedDate: d.ts,
    postedDateSemantics: d.semantics,
    createdAt: d.semantics === 'created' ? d.ts : undefined,
    updatedAt: undefined,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `lev-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

// Ashby: publishedAt is the posting date.
function ashbyJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.applyUrl || j.jobUrl;
  if (!j.title || !url) return null;
  const d = normalizeDates(j.publishedAt, j.publishedAt, j.publishedAt);
  return {
    id: `ash-${j.id}`,
    externalId: String(j.id),
    title: j.title,
    company: companyName,
    companyId: companyName,
    location: j.location,
    locations: j.secondaryLocations?.length ? [j.location, ...j.secondaryLocations.map((l: any) => l.location || l)] : undefined,
    department: j.department?.name,
    employmentType: j.employmentType,
    remote: j.isRemote === true,
    description: stripHtml(j.descriptionHtml || j.descriptionPlain || ''),
    atsPlatform: platform as any,
    jobUrl: url,
    applyUrl: url,
    url,
    source: 'Custom' as any,
    postedDate: d.ts,
    postedDateSemantics: d.semantics,
    createdAt: d.semantics === 'created' ? d.ts : undefined,
    updatedAt: d.semantics === 'updated' ? d.ts : undefined,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `ash-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

function srJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.externalUrl || j.internalUrl;
  if (!j.name || !url) return null;
  const sections = (j.jobAd?.sections || []).map((s: any) => s.content || '').filter(Boolean).join('\n\n');
  const location = [j.location?.city, j.location?.country].filter(Boolean).join(', ') || j.location?.city;
  // SmartRecruiters: releasedDate (ms epoch) is the posting date.
  const d = normalizeDates(j.releasedDate ?? j.publicationDate, j.publicationDate, undefined);
  return {
    id: `sr-${j.id}`,
    externalId: String(j.id),
    title: j.name,
    company: j.company?.name || companyName,
    companyId: companyName,
    location,
    locations: location ? [location] : undefined,
    department: j.department?.label,
    employmentType: j.typeOfEmployment?.label || j.workType?.label,
    remote: /remote/i.test(String(j.workType?.label || location || '')),
    description: stripHtml(sections),
    atsPlatform: platform as any,
    jobUrl: url,
    applyUrl: url,
    url,
    source: 'Custom' as any,
    postedDate: d.ts,
    postedDateSemantics: d.semantics,
    createdAt: d.semantics === 'created' ? d.ts : undefined,
    updatedAt: d.semantics === 'updated' ? d.ts : undefined,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `sr-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
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

/**
 * Scrape a free-API ATS directly — no Apify credits.
 * Returns raw jobs (keyword filtering + tagging happens in scraperFactory,
 * exactly like the direct ATS path).
 */
export async function scrapeDirectAts(
  source: string,
  platform: string,
  keywords: string[],
  maxJobsPerSource: number
): Promise<Job[]> {
  const config = loadConfig();
  const enabled = config.scraper?.respectRobotsTxt !== false;
  void enabled; // public APIs, no robots constraint — reserved for parity
  const cap = Math.min(maxJobsPerSource || 15, 50);
  const boards = pickBoards(platform, 8);

  const base = API_BASE[platform];
  if (!base) return [];
  const norm = (fn: (j: any, c: string, p: string) => Job | null) => async (b: { companyName: string; slug: string }) => {
    try {
      const url = boardUrl(platform, b.slug);
      const data = await fetchJson(url);
      const raw = platform === 'smartrecruiters' ? data.content : platform === 'ashby' ? data.jobs : data.jobs || data;
      if (!Array.isArray(raw)) return [];
      // Budget: keep at most 50 per board, newest-first.
      const jobs = raw
        .map((j: any) => fn(j, b.companyName, platform))
        .filter((j: Job | null): j is Job => !!j)
        .sort((a: Job, c: Job) => new Date(c.postedDate || 0).getTime() - new Date(a.postedDate || 0).getTime())
        .slice(0, Math.max(cap, 15));
      console.log(`[DirectATS] ${source} ${b.slug}: ${jobs.length} jobs`);
      return jobs;
    } catch (err: any) {
      console.warn(`[DirectATS] ${source} ${b.slug} failed: ${err.message}`);
      return [];
    }
  };

  const fns = { greenhouse: ghJob, lever: leverJob, ashby: ashbyJob, smartrecruiters: srJob };
  const results = await Promise.all(boards.map(norm(fns[platform as keyof typeof fns])));
  void keywords;
  return results.flat();
}