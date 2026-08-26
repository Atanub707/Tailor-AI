import type { Job } from '../../src/types.js';
import { getDb } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';
import { loadConfig } from '../config.js';

/**
 * Direct free-API provider — Greenhouse, Lever, Ashby, SmartRecruiters all
 * publish OPEN job APIs (no key, no Apify credits). This is the default path
 * for those four; the Santa Maria actor is only a fallback when a board has
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
  // priority slugs first (by URL match), then tail with rotation
  const prioClause = priorities.length
    ? `ORDER BY CASE ${priorities.map((p, i) => `WHEN careerUrl LIKE ? THEN ${i}`).join(' ')} ELSE 999 END, rowid`
    : 'ORDER BY rowid';
  const args: any[] = [platform, ...priorities];
  const rows = db.prepare(
    `SELECT companyName, careerUrl FROM company_career_sites WHERE isActive = 1 AND ${where} ${prioClause} LIMIT ?`
  ).all(...args, cap) as { companyName: string; careerUrl: string }[];
  return rows
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

// ── Normalizers → Job (source tagged by caller) ──────────────────────────────
function ghJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.absolute_url || j.id;
  if (!j.title || !url) return null;
  const description = stripHtml(j.content || '');
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
    postedDate: j.updated_at,
    createdAt: j.updated_at,
    updatedAt: j.updated_at,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `gh-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

function leverJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.hostedUrl || j.applyUrl;
  if (!j.text || !url) return null;
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
    postedDate: j.createdAt,
    createdAt: j.createdAt,
    updatedAt: j.createdAt,
    scrapedAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: `lev-${j.id}`,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}

function ashbyJob(j: any, companyName: string, platform: string): Job | null {
  const url = j.applyUrl || j.jobUrl;
  if (!j.title || !url) return null;
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
    postedDate: j.publishedAt,
    createdAt: j.publishedAt,
    updatedAt: j.publishedAt,
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
    postedDate: j.releasedDate ? new Date(j.releasedDate).toISOString() : j.publicationDate ? new Date(j.publicationDate).toISOString() : undefined,
    createdAt: j.publicationDate ? new Date(j.publicationDate).toISOString() : undefined,
    updatedAt: j.releasedDate ? new Date(j.releasedDate).toISOString() : undefined,
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
 * exactly like the Santa Maria path).
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
      const url = `${base}/${encodeURIComponent(b.slug)}${platform === 'lever' ? '?mode=json' : ''}${platform === 'greenhouse' ? '/jobs' : ''}${platform === 'ashby' ? '' : ''}`;
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