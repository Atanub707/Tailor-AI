import type { Job } from '../../src/types.js';
import { classifyFromText } from '../scraper/workMode.js';
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
  // Verified live (free probes, 2026-10): the SR API is company-ID based and
  // most guessed IDs return 0 — BoschGroup is a real 5k-job board.
  smartrecruiters: ['BoschGroup'],
  // Verified live Workable boards with active DevOps/infra roles (of 160
  // sampled, ~5% had any — random slices alone often return zero).
  workable: ['2070health', '1global', 'ajaib', 'activate-interactive-pte-ltd', 'advansys-esc-1', 'aerones', 'agileactors', 'abtrace'],
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
  const tail = tailRows.filter((r) => !priorities.some((p) => r.careerUrl.toLowerCase().includes(p.slice(1, -1).toLowerCase())));
  const tailCap = Math.max(cap - prioRows.length, 1);
  // Advance ~1 board per 15s of wall clock — each search lands on a fresh
  // slice; wraps so every board is eventually reached.
  const offset = Math.floor(Date.now() / 15000) % Math.max(tail.length, tailCap);
  const slice = [...tail.slice(offset), ...tail.slice(0, offset)].slice(0, tailCap);
  const seenBoards = new Set<string>();
  return [...prioRows, ...slice]
    .filter((r) => { const k = (r.careerUrl || '').toLowerCase(); if (seenBoards.has(k)) return false; seenBoards.add(k); return true; })
    .map((r) => {
      const m = (r.careerUrl || '').match(SLUG_RE[platform]);
      return m ? { companyName: r.companyName, slug: m[1] } : null;
    })
    .filter((x): x is { companyName: string; slug: string } => !!x);
}

/** Board URLs for a platform (priority boards + rotating tail) — the input
 *  for the career-site ATS actor. Same rotation as pickBoards so repeated
 *  searches explore new companies instead of re-reading the same jobs. */
export function pickBoardUrls(platform: string, cap: number): { companyName: string; careerUrl: string }[] {
  ensureV2Tables();
  const db = getDb();
  const priorities = (PRIORITY_BY_PLATFORM[platform] || []).map((s) => `%/${s}%` as const);
  const where = `LOWER(atsPlatform) = ?`;
  const prioRows = priorities.length
    ? (db.prepare(`SELECT companyName, careerUrl FROM company_career_sites WHERE isActive = 1 AND ${where} AND (${priorities.map(() => `careerUrl LIKE ?`).join(' OR ')}) ORDER BY rowid LIMIT 8`).all(platform, ...priorities) as { companyName: string; careerUrl: string }[])
    : [];
  const tailRows = db.prepare(`SELECT companyName, careerUrl FROM company_career_sites WHERE isActive = 1 AND ${where} ORDER BY rowid`).all(platform) as { companyName: string; careerUrl: string }[];
  const tail = tailRows.filter((r) => !priorities.some((p) => r.careerUrl.toLowerCase().includes(p.slice(1, -1).toLowerCase())));
  const tailCap = Math.max(cap - prioRows.length, 1);
  const offset = Math.floor(Date.now() / 15000) % Math.max(tail.length, tailCap);
  const slice = [...tail.slice(offset), ...tail.slice(0, offset)].slice(0, tailCap);
  const seenBoards = new Set<string>();
  return [...prioRows, ...slice]
    .filter((r) => { const k = (r.careerUrl || '').toLowerCase(); if (!/^https?:\/\//i.test(k) || seenBoards.has(k)) return false; seenBoards.add(k); return true; });
}

// Test seam: override the network fetcher (fixtures/mocks, never live calls).
// Default = global fetch. Production code never calls this.
type JsonFetcher = (url: string, timeoutMs?: number) => Promise<any>;
let fetcherOverride: JsonFetcher | undefined;
export function setDirectAtsFetcher(fn: JsonFetcher | undefined): void {
  fetcherOverride = fn;
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  if (fetcherOverride) return fetcherOverride(url, timeoutMs);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'TailorAI/1.0' } });
  if (!res.ok) throw new Error(`${url.split('/')[2]} API ${res.status}`);
  return res.json();
}

// Single source of truth for board API URLs — shared by the interactive
// search path (scrapeDirectAts) and the board-level watcher fetch.
function boardUrl(platform: string, slug: string, query?: string): string {
  const base = API_BASE[platform];
  if (platform === 'smartrecruiters') {
    // SR's API supports server-side keyword search (`q`) — without it we'd
    // fetch the first N postings of a 5k-job board and never see the role.
    const q = query && query.trim() ? `?limit=50&q=${encodeURIComponent(query.trim())}` : '?limit=50';
    return `${base}/${encodeURIComponent(slug)}/postings${q}`;
  }
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

/** Explicit workplace type from a provider payload ("remote"/"hybrid"/
 *  "onsite") — or null when the provider didn't state one. NEVER inferred
 *  from description text here: that fabrication produced Remote labels for
 *  on-site jobs (Lever CCTV-technician regression). */
function providerWorkMode(raw: unknown): 'Remote' | 'Hybrid' | 'On-site' | null {
  const v = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'remote') return 'Remote';
  if (v === 'hybrid') return 'Hybrid';
  if (v === 'onsite') return 'On-site';
  return null;
}

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
    workMode: classifyFromText(j.location?.name) ?? undefined,
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
    // Lever's postings API carries workplaceType (remote/hybrid/onsite) —
    // authoritative; otherwise the LOCATION text only (never the description).
    workMode: providerWorkMode(j.workplaceType) ?? classifyFromText(j.categories?.location) ?? undefined,
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
    workMode:
      providerWorkMode(j.workplaceType) ?? (j.isRemote === true ? 'Remote' : null) ?? classifyFromText(String(j.location || '')) ?? undefined,
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

function srSectionsText(jobAd: any): string {
  const secs = jobAd?.sections;
  if (Array.isArray(secs)) return secs.map((s: any) => s?.text || s?.content || '').filter(Boolean).join('\n\n');
  if (secs && typeof secs === 'object') {
    return Object.values(secs)
      .map((v: any) => (typeof v === 'string' ? v : v?.text || v?.content || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function srJob(j: any, companyName: string, platform: string, slug?: string): Job | null {
  if (!j.name) return null;
  // List rows carry no public URL — construct the canonical posting URL.
  const url = j.postingUrl || j.externalUrl || j.internalUrl
    || (slug && j.id ? `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(String(j.id))}` : '');
  if (!url) return null;
  const sections = srSectionsText(j.jobAd);
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

export function stripHtml(html: string): string {
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
  const norm = (fn: (j: any, c: string, p: string, slug?: string) => Job | null) => async (b: { companyName: string; slug: string }) => {
    try {
      const srQuery = keywords.find((t) => t.length > 2) || keywords.join(' ');
      const url = boardUrl(platform, b.slug, platform === 'smartrecruiters' ? srQuery : undefined);
      const data = await fetchJson(url);
      const raw = platform === 'smartrecruiters' ? data.content : platform === 'ashby' ? data.jobs : data.jobs || data;
      if (!Array.isArray(raw)) return [];
      // Budget: keep at most 50 per board, newest-first.
      const jobs = raw
        .map((j: any) => fn(j, b.companyName, platform, b.slug))
        .filter((j: Job | null): j is Job => !!j)
        .sort((a: Job, c: Job) => new Date(c.postedDate || 0).getTime() - new Date(a.postedDate || 0).getTime())
        .slice(0, Math.max(cap, 15));
      // SmartRecruiters list rows are snippet-free — open the detail endpoint
      // for the jobs we'd keep (≤ cap) to get the full description + apply URL.
      if (platform === 'smartrecruiters') {
        const kept = jobs.slice(0, cap);
        await Promise.all(kept.map(async (job) => {
          try {
            const detailUrl = `${base}/${encodeURIComponent(b.slug)}/postings/${encodeURIComponent(String(job.externalId))}`;
            const detail = await fetchJson(detailUrl);
            const text = srSectionsText(detail?.jobAd);
            if (text) job.description = stripHtml(text);
            if (detail?.applyUrl) job.applyUrl = detail.applyUrl;
            if (detail?.postingUrl) {
              job.url = detail.postingUrl;
              (job as any).jobUrl = detail.postingUrl;
            }
          } catch { /* keep the list row */ }
        }));
        // SR's `q` is fuzzy (OR-ish): keep only rows whose title/company/
        // description mentions a query term — is same evidence the actor path
        // relies on.
        const terms = keywords.filter((t) => t.length > 2).map((t) => t.toLowerCase());
        if (terms.length) {
          const relevant = jobs.filter((job) => {
            const hay = `${job.title} ${job.company || ''} ${job.description || ''}`.toLowerCase();
            return terms.some((t) => hay.includes(t));
          });
          if (relevant.length !== jobs.length) {
            console.log(`[DirectATS] SmartRecruiters ${b.slug}: ${jobs.length - relevant.length} off-query rows dropped`);
          }
          jobs.length = 0;
          jobs.push(...relevant);
        }
      }
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

/**
 * Fetch ONE board fully (all currently-open jobs) for the background indexer.
 * Unlike scrapeDirectAts (capped, request-driven, failure-tolerant), this
 * THROWS on failure so the indexer can record board-refresh state honestly —
 * a failed fetch must never be treated as "board has no jobs".
 */
export async function fetchAtsBoard(
  source: string,
  platform: string,
  slug: string,
  companyName: string,
  timeoutMs = 15000
): Promise<Job[]> {
  const fns = { greenhouse: ghJob, lever: leverJob, ashby: ashbyJob, smartrecruiters: srJob };
  const fn = fns[platform as keyof typeof fns];
  if (!fn) return [];
  const url = boardUrl(platform, slug);
  const data = await fetchJson(url, timeoutMs);
  const raw = platform === 'smartrecruiters' ? data.content : platform === 'ashby' ? data.jobs : data.jobs || data;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((j: any) => fn(j, companyName, platform))
    .filter((j: Job | null): j is Job => !!j);
}