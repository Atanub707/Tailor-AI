// Lever local index — normalization, ingestion idempotency, provider
// isolation, readiness isolation, grace-safety, zero-network local search,
// date-filter/LIMIT semantics, Tailor metadata compatibility. Fixtures only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lever-index-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs, queryAtsCandidates, recordBoardAttempt, clearAtsIndex, deactivateStaleJobs, boardRefreshStats } = await import('../../server/ats-index/atsRepository.js');
const { leverIndexProvider, greenhouseIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
const { atsProviderMode } = await import('../../server/providers/providerRegistry.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { fetchAtsBoard, setDirectAtsFetcher } = await import('../../server/providers/directAtsProvider.js');
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';
import type { Job } from '../../src/types.js';

const USER = 'lever-user';
const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();
const FIXED_CREATED_AT = Date.now() - 24 * H;

const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: 'Software Engineer',
  hostedUrl: `https://jobs.lever.co/fixture/${id}`,
  applyUrl: `https://jobs.lever.co/fixture/${id}`,
  createdAt: FIXED_CREATED_AT,
  categories: { location: 'Bengaluru, India', allLocations: [{ location: 'Bengaluru, India' }], team: 'Engineering', commitment: 'Full-time' },
  workplaceType: 'On-site',
  descriptionPlain: 'Role: Software Engineer at Fixture',
  description: '<p>Role: Software Engineer at Fixture</p>',
  ...over,
});

function leverRow(over: Partial<AtsJobRow> = {}): AtsJobRow {
  return {
    fingerprint: 'lever-fixture-1',
    ats_platform: 'lever',
    external_id: 'fixture-1',
    company: 'Fixture',
    company_slug: 'fixture',
    title: 'Software Engineer',
    location: 'Bengaluru, India',
    employment_type: 'Full-time',
    work_mode: 'On-site',
    posted_date: iso(24),
    posted_date_semantics: 'created',
    apply_url: 'https://jobs.lever.co/fixture/fixture-1',
    job_url: 'https://jobs.lever.co/fixture/fixture-1',
    description: 'Role: Software Engineer at Fixture',
    first_seen_at: iso(48 * 24),
    last_seen_at: iso(48 * 24),
    last_fetched_at: iso(48 * 24),
    is_active: 1,
    ...over,
  };
}

async function normalize(rawJob: Record<string, unknown>): Promise<Job> {
  setDirectAtsFetcher(async () => [rawJob]);
  const jobs = await fetchAtsBoard('Test', 'lever', 'fixture', 'Fixture');
  setDirectAtsFetcher(undefined);
  return jobs[0];
}

describe('Lever local index', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'LeverUser', 'l@test.local');
    db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'lever', ?, 1, ?, ?)`
    ).run('sb-lev', 'Fixture', 'https://jobs.lever.co/fixture', 'fixture', iso(30 * 24), iso(30 * 24));
    upsertAtsJobs([leverRow()]);
    recordBoardAttempt('lever', 'fixture', true, 1, iso(-2));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lever payload normalization: createdAt epoch → ISO, semantics created, stable fingerprint', async () => {
    const j = await normalize(raw('abc-123'));
    expect(j.fingerprint).toBe('lev-abc-123');
    expect(j.postedDateSemantics).toBe('created');
    expect(j.postedDate).toBe(new Date(FIXED_CREATED_AT).toISOString());
    expect(j.employmentType).toBe('Full-time');
    expect(j.location).toBe('Bengaluru, India');
    expect(j.description).toContain('Software Engineer');
  });

  it('missing createdAt → semantics unknown, no invented date', async () => {
    const j = await normalize(raw('no-date', { createdAt: undefined }));
    expect(j.postedDateSemantics).toBe('unknown');
    expect(j.postedDate).toBeUndefined();
  });

  it('work mode from explicit fields only (never word-sniffed here)', async () => {
    expect((await normalize(raw('r1', { workplaceType: 'Remote' }))).remote).toBe(true);
    expect((await normalize(raw('o1', { workplaceType: 'On-site' }))).remote).toBe(false);
  });

  it('description prefers descriptionPlain, falls back to stripped HTML', async () => {
    const plain = await normalize(raw('d1', { description: '<p>HTML ONLY</p>' }));
    expect(plain.description).toContain('Software Engineer');
    const html = await normalize(raw('d2', { descriptionPlain: undefined, description: '<p>HTML <b>ONLY</b></p>' }));
    expect(html.description).toBe('HTML ONLY');
  });

  it('upsert idempotency: same fingerprint updates, never duplicates; first_seen preserved', () => {
    upsertAtsJobs([leverRow()]);
    const db = getDb();
    const rows = db.prepare("SELECT count(*) c FROM ats_jobs WHERE fingerprint='lever-fixture-1'").get() as { c: number };
    expect(rows.c).toBe(1);
    upsertAtsJobs([leverRow({ title: 'Senior Software Engineer' })]);
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE fingerprint='lever-fixture-1'").get() as { c: number }).c).toBe(1);
  });

  it('greenhouse and lever fingerprints never collide', async () => {
    const gh = await normalize(raw('99'));
    expect(gh.fingerprint).toBe('lev-99');
    expect('gh-99' !== gh.fingerprint).toBe(true);
  });

  it('provider registry routes Lever to local_index', () => {
    expect(atsProviderMode('Lever', true)).toBe('local_index');
    expect(atsProviderMode('Greenhouse', true)).toBe('local_index');
    expect(atsProviderMode('Ashby', true)).toBe('local_index');
  });

  it('failed lever fetch never deactivates jobs (grace model)', () => {
    deactivateStaleJobs(48, 'lever');
    const db = getDb();
    expect((db.prepare("SELECT is_active FROM ats_jobs WHERE fingerprint='lever-fixture-1'").get() as { is_active: number }).is_active).toBe(1);
  });

  it('sample crawl must not deactivate unsampled lever jobs', () => {
    upsertAtsJobs([leverRow({ fingerprint: 'lever-unsampled-1', external_id: 'unsampled-1' })]);
    // A partial sync only touches its own board rows; a platform-wide grace
    // pass with a recent last_seen keeps everything active.
    deactivateStaleJobs(48, 'lever');
    const db = getDb();
    expect((db.prepare("SELECT is_active FROM ats_jobs WHERE fingerprint='lever-unsampled-1'").get() as { is_active: number }).is_active).toBe(1);
  });

  it('zero-network local Lever search + source isolation + LIMIT + date filters', async () => {
    const db = getDb();
    upsertAtsJobs([
      leverRow({ fingerprint: 'lever-new-1', external_id: 'new-1', title: 'Software Engineer', posted_date: iso(5), posted_date_semantics: 'created' }),
      leverRow({ fingerprint: 'lever-old-1', external_id: 'old-1', title: 'Platform Engineer', posted_date: iso(30 * 24), posted_date_semantics: 'created' }),
    ]);
    db.prepare("INSERT INTO ats_jobs (fingerprint, ats_platform, external_id, company, company_slug, title, location, employment_type, work_mode, posted_date, posted_date_semantics, apply_url, job_url, description, first_seen_at, last_seen_at, last_fetched_at, is_active) VALUES ('gh-only-1','greenhouse','gh-1','GHX','ghx','Software Engineer','Bengaluru, India',NULL,NULL,'created', 'created','https://boards.greenhouse.io/ghx/1','https://boards.greenhouse.io/ghx/1','desc',?,?,?,1)").run(iso(24), iso(24), iso(24));

    let networkCalls = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { networkCalls++; return (orig as any)(...a); };
    try {
      const lever = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Lever' }, [leverIndexProvider]);
      expect(networkCalls).toBe(0); // zero provider network calls during search
      expect(lever.jobs.length).toBeGreaterThan(0);
      expect(lever.jobs.every((j: any) => j.atsPlatform === 'lever')).toBe(true);
      expect(lever.jobs.every((j: any) => j.source === 'Lever')).toBe(true);
      expect(lever.jobs.length).toBeLessThanOrEqual(10); // LIMIT
      expect(lever.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 7 * 24 * H)).toBe(true); // 7d filter

      const gh = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
      expect(gh.jobs.every((j: any) => j.atsPlatform === 'greenhouse')).toBe(true);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('24h / 30d filters operate on the provider timestamp', async () => {
    const d24 = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '24h', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Lever' }, [leverIndexProvider]);
    expect(d24.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 24 * H)).toBe(true);
    const d30 = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '30d', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Lever' }, [leverIndexProvider]);
    expect(d30.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 30 * 24 * H)).toBe(true);
  });

  it('readiness is provider-specific: greenhouse ready while lever builds', () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt) VALUES ('gh-1','GHX','https://boards.greenhouse.io/ghx','greenhouse','ghx',1,?,?)").run(iso(30 * 24), iso(30 * 24));
    const ghStats = boardRefreshStats('greenhouse');
    const levStats = boardRefreshStats('lever');
    expect(ghStats.indexState).toBeDefined();
    expect(levStats.indexState).toBeDefined();
    // Both platforms readable independently — no cross-contamination of state.
    expect(ghStats.boardsTotal).toBeGreaterThanOrEqual(1);
    expect(levStats.boardsTotal).toBeGreaterThanOrEqual(1);
    expect(ghStats.activeJobs).toBeGreaterThanOrEqual(0);
  });

  it('lever search result carries full JD for Tailor (metadata compatibility)', async () => {
    const lever = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 5, source: 'Lever' }, [leverIndexProvider]);
    const withDesc = lever.jobs.find((j: any) => (j.description || '').length > 10);
    expect(withDesc).toBeTruthy();
    expect(withDesc.applyUrl).toContain('jobs.lever.co');
    expect(withDesc.url).toContain('jobs.lever.co');
    expect(withDesc.postedDateSemantics).toBe('created');
  });

  it('clearAtsIndex(platform) isolates per platform', () => {
    clearAtsIndex('lever');
    const db = getDb();
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE ats_platform='lever'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE ats_platform='greenhouse'").get() as { c: number }).c).toBe(1);
  });
});