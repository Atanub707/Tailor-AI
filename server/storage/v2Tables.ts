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

// 25 ATS career sites for Santa Maria — the registry Santa Maria queries.
// Idempotent: INSERT OR IGNORE on every startup, so it only seeds once.
const SEED_COMPANIES: Array<{ id: string; companyName: string; careerUrl: string; atsPlatform: string }> = [
  { id: 'stripe', companyName: 'Stripe', careerUrl: 'https://boards.greenhouse.io/stripe', atsPlatform: 'greenhouse' },
  { id: 'airbnb', companyName: 'Airbnb', careerUrl: 'https://boards.greenhouse.io/airbnb', atsPlatform: 'greenhouse' },
  { id: 'datadog', companyName: 'Datadog', careerUrl: 'https://boards.greenhouse.io/datadog', atsPlatform: 'greenhouse' },
  { id: 'notion', companyName: 'Notion', careerUrl: 'https://jobs.ashbyhq.com/notion', atsPlatform: 'ashby' },
  { id: 'ramp', companyName: 'Ramp', careerUrl: 'https://jobs.ashbyhq.com/ramp', atsPlatform: 'ashby' },
  { id: 'linear', companyName: 'Linear', careerUrl: 'https://jobs.ashbyhq.com/linear', atsPlatform: 'ashby' },
  { id: 'spotify', companyName: 'Spotify', careerUrl: 'https://jobs.lever.co/spotify', atsPlatform: 'lever' },
  { id: 'netflix', companyName: 'Netflix', careerUrl: 'https://jobs.lever.co/netflix', atsPlatform: 'lever' },
  { id: 'wework', companyName: 'WeWork', careerUrl: 'https://jobs.lever.co/wework', atsPlatform: 'lever' },
  { id: 'figma', companyName: 'Figma', careerUrl: 'https://jobs.ashbyhq.com/figma', atsPlatform: 'ashby' },
  { id: 'deel', companyName: 'Deel', careerUrl: 'https://jobs.ashbyhq.com/deel', atsPlatform: 'ashby' },
  { id: 'dover', companyName: 'Dover', careerUrl: 'https://jobs.ashbyhq.com/dover', atsPlatform: 'ashby' },
  { id: 'reddit', companyName: 'Reddit', careerUrl: 'https://boards.greenhouse.io/reddit', atsPlatform: 'greenhouse' },
  { id: 'dropbox', companyName: 'Dropbox', careerUrl: 'https://boards.greenhouse.io/dropbox', atsPlatform: 'greenhouse' },
  { id: 'hashicorp', companyName: 'HashiCorp', careerUrl: 'https://boards.greenhouse.io/hashicorp', atsPlatform: 'greenhouse' },
  { id: 'canva', companyName: 'Canva', careerUrl: 'https://jobs.lifeatcanva.com', atsPlatform: 'other' },
  { id: 'personio', companyName: 'Personio', careerUrl: 'https://jobs.personio.com/search?q=', atsPlatform: 'personio' },
  { id: 'teamtailor', companyName: 'Teamtailor', careerUrl: 'https://www.teamtailor.com/jobs', atsPlatform: 'teamtailor' },
  { id: 'bamboo', companyName: 'BambooHR', careerUrl: 'https://www.bamboohr.com/careers', atsPlatform: 'bamboohr' },
  { id: 'rippling', companyName: 'Rippling', careerUrl: 'https://ats.rippling.com/rippling/jobs', atsPlatform: 'rippling' },
  { id: 'jazzhr', companyName: 'JazzHR', careerUrl: 'https://www.jazzhr.com/jobs', atsPlatform: 'jazzhr' },
  { id: 'smartrecruiters', companyName: 'SmartRecruiters', careerUrl: 'https://jobs.smartrecruiters.com/SmartRecruiters', atsPlatform: 'smartrecruiters' },
  { id: 'workday', companyName: 'Workday', careerUrl: 'https://workday.wd5.myworkdayjobs.com/Workday', atsPlatform: 'workday' },
  { id: 'recruitee', companyName: 'Recruitee', careerUrl: 'https://jobs.recruitee.com', atsPlatform: 'recruitee' },
  { id: 'comeet', companyName: 'Comeet', careerUrl: 'https://www.comeet.com/jobs', atsPlatform: 'comeet' },
];

export function seedCompanyCareerSites(): void {
  const db = getDb();
  const count = (db.prepare('SELECT count(*) AS c FROM company_career_sites').get() as any).c;
  if (count > 0) return; // already seeded
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
     VALUES (@id, @companyName, @careerUrl, @atsPlatform, 1, @now, @now)`
  );
  const now = new Date().toISOString();
  for (const c of SEED_COMPANIES) stmt.run({ ...c, now });
  console.log(`[V2] Seeded ${SEED_COMPANIES.length} company career sites for Santa Maria`);
}

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
    CREATE TABLE IF NOT EXISTS search_seen (
      user_id TEXT NOT NULL,
      query_fp TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (user_id, query_fp, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS provider_cursors (
      user_id TEXT NOT NULL,
      query_fp TEXT NOT NULL,
      provider TEXT NOT NULL,
      cursor TEXT,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, query_fp, provider)
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

export function markSeen(userId: string, queryFp: string, fingerprints: string[]): void {
  if (!userId || !queryFp || fingerprints.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO search_seen (user_id, query_fp, fingerprint, seen_at) VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const fp of fingerprints) stmt.run(userId, queryFp, fp, now);
  });
  tx();
}

export function getSeenFingerprints(userId: string, queryFp: string): Set<string> {
  if (!userId || !queryFp) return new Set();
  const db = getDb();
  const rows = db.prepare('SELECT fingerprint FROM search_seen WHERE user_id = ? AND query_fp = ?').all(userId, queryFp) as { fingerprint: string }[];
  return new Set(rows.map((r) => r.fingerprint));
}

export function getProviderCursor(userId: string, queryFp: string, provider: string): { cursor?: string; fetchedCount: number } {
  if (!userId || !queryFp) return { cursor: undefined, fetchedCount: 0 };
  const db = getDb();
  const row = db.prepare('SELECT cursor, fetched_count FROM provider_cursors WHERE user_id = ? AND query_fp = ? AND provider = ?')
    .get(userId, queryFp, provider) as { cursor: string | null; fetched_count: number } | undefined;
  return { cursor: row?.cursor ?? undefined, fetchedCount: row?.fetched_count ?? 0 };
}

export function saveProviderCursor(userId: string, queryFp: string, provider: string, cursor: string | undefined, fetchedCount: number): void {
  if (!userId || !queryFp) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO provider_cursors (user_id, query_fp, provider, cursor, fetched_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, query_fp, provider) DO UPDATE SET cursor = excluded.cursor, fetched_count = excluded.fetched_count, updated_at = excluded.updated_at`
  ).run(userId, queryFp, provider, cursor ?? null, fetchedCount, new Date().toISOString());
}
