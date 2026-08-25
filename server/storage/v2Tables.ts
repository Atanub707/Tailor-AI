import { getDb } from './fileStorage.js';

export interface CompanyCareerSite {
  id: string;
  companyName: string;
  websiteUrl?: string;
  careerUrl: string;
  atsPlatform: string;
  atsCompanySlug?: string;
  country?: string;
  industry?: string;
  isActive: boolean;
  lastScrapedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRun {
  id: string;
  provider: string;
  externalRunId?: string;
  requestedLimit: number;
  jobsReturned: number;
  status: string;
  startedAt: string;
  completedAt?: string;
}

const JOB_CACHE_TTL_HOURS = 24;

export function ensureV2Tables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_career_sites (
      id TEXT PRIMARY KEY,
      companyName TEXT NOT NULL,
      websiteUrl TEXT,
      careerUrl TEXT NOT NULL UNIQUE,
      atsPlatform TEXT NOT NULL,
      atsCompanySlug TEXT,
      country TEXT,
      industry TEXT,
      isActive INTEGER NOT NULL DEFAULT 1,
      lastScrapedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_runs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      externalRunId TEXT,
      requestedLimit INTEGER NOT NULL,
      jobsReturned INTEGER NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_company_career_sites_ats ON company_career_sites(atsPlatform);
    CREATE INDEX IF NOT EXISTS idx_provider_runs_provider ON provider_runs(provider);
  `);

  // Add indexes on jobs JSON for V2 fields (if not exists, SQLite will ignore duplicate)
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(json_extract(data, '$.fingerprint'))`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_atsPlatform ON jobs(json_extract(data, '$.atsPlatform'))`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_isActive ON jobs(json_extract(data, '$.isActive'))`);
  } catch {
    // json_extract index may fail on older SQLite — non-critical
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove tracking params, fragments, trailing slashes
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((p) => u.searchParams.delete(p));
    u.hash = '';
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s.toLowerCase();
  } catch {
    return url.toLowerCase().trim().replace(/\/$/, '');
  }
}

export function fingerprintJob(job: { atsPlatform?: string; externalId?: string; applyUrl?: string; jobUrl?: string; url: string; company: string; title: string; location?: string }): string {
  const ats = (job.atsPlatform || 'other').toLowerCase();
  const ext = (job.externalId || '').trim();
  if (ext) return `${ats}-${ext.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  const url = normalizeUrl(job.applyUrl || job.jobUrl || job.url);
  if (url && url !== 'other-') return `${ats}-${url.replace(/[^a-z0-9]/g, '').slice(0, 32)}`;

  const base = `${job.company.toLowerCase()}|${job.title.toLowerCase()}|${(job.location || '').toLowerCase()}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return `${ats}-${hash.toString(16)}`;
}

export function isJobFresh(scrapedAt?: string, ttlHours = JOB_CACHE_TTL_HOURS): boolean {
  if (!scrapedAt) return false;
  const age = Date.now() - new Date(scrapedAt).getTime();
  return age < ttlHours * 60 * 60 * 1000;
}
