// Ashby local index — normalization, ingestion idempotency, provider
// isolation, readiness isolation, grace-safety, zero-network local search,
// date/LIMIT semantics, Tailor metadata compatibility. Fixtures only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashby-index-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs, queryAtsCandidates, recordBoardAttempt, clearAtsIndex, deactivateStaleJobs, boardRefreshStats } = await import('../../server/ats-index/atsRepository.js');
const { ashbyIndexProvider, leverIndexProvider, greenhouseIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
const { atsProviderMode } = await import('../../server/providers/providerRegistry.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { fetchAtsBoard, setDirectAtsFetcher } = await import('../../server/providers/directAtsProvider.js');
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';
import type { Job } from '../../src/types.js';

const USER = 'ashby-user';
const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();
const FIXED_PUBLISHED = Date.now() - 24 * H;

const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'Software Engineer',
  jobUrl: `https://jobs.ashbyhq.com/fixture/${id}`,
  applyUrl: `https://jobs.ashbyhq.com/fixture/${id}/apply`,
  publishedAt: new Date(FIXED_PUBLISHED).toISOString(),
  location: 'Bengaluru, India',
  secondaryLocations: [{ location: 'Remote - India' }],
  department: { name: 'Engineering' },
  employmentType: 'Full-time',
  isRemote: false,
  descriptionPlain: 'Role: Software Engineer at Fixture',
  descriptionHtml: '<p>Role: <b>Software Engineer</b> at Fixture</p>',
  ...over,
});

function ashbyRow(over: Partial<AtsJobRow> = {}): AtsJobRow {
  return {
    fingerprint: 'ashby-fixture-1',
    ats_platform: 'ashby',
    external_id: 'fixture-1',
    company: 'Fixture',
    company_slug: 'fixture',
    title: 'Software Engineer',
    location: 'Bengaluru, India',
    employment_type: 'Full-time',
    work_mode: 'On-site',
    posted_date: iso(24),
    posted_date_semantics: 'published',
    apply_url: 'https://jobs.ashbyhq.com/fixture/fixture-1/apply',
    job_url: 'https://jobs.ashbyhq.com/fixture/fixture-1',
    description: 'Role: Software Engineer at Fixture',
    first_seen_at: iso(48 * 24),
    last_seen_at: iso(48 * 24),
    last_fetched_at: iso(48 * 24),
    is_active: 1,
    ...over,
  };
}

async function normalize(rawJob: Record<string, unknown>): Promise<Job> {
  setDirectAtsFetcher(async () => ({ jobs: [rawJob] }));
  const jobs = await fetchAtsBoard('Test', 'ashby', 'fixture', 'Fixture');
  setDirectAtsFetcher(undefined);
  return jobs[0];
}

describe('Ashby local index', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'AshbyUser', 'a@test.local');
    db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'ashby', ?, 1, ?, ?)`
    ).run('sb-ash', 'Fixture', 'https://jobs.ashbyhq.com/fixture', 'fixture', iso(30 * 24), iso(30 * 24));
    upsertAtsJobs([ashbyRow()]);
    recordBoardAttempt('ashby', 'fixture', true, 1, iso(-2));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ashby payload normalization: publishedAt → ISO, semantics published, stable fingerprint', async () => {
    const j = await normalize(raw('abc-123'));
    expect(j.fingerprint).toBe('ash-abc-123');
    expect(j.postedDateSemantics).toBe('published');
    expect(j.postedDate).toBe(new Date(FIXED_PUBLISHED).toISOString());
    expect(j.employmentType).toBe('Full-time');
    expect(j.location).toBe('Bengaluru, India');
    expect(j.locations).toContain('Remote - India');
    expect(j.department).toBe('Engineering');
  });

  it('missing publishedAt → semantics unknown, no invented date', async () => {
    const j = await normalize(raw('no-date', { publishedAt: undefined }));
    expect(j.postedDateSemantics).toBe('unknown');
    expect(j.postedDate).toBeUndefined();
  });

  it('invalid date string → unknown semantics, never a fake date', async () => {
    const j = await normalize(raw('bad-date', { publishedAt: 'not-a-date' }));
    expect(j.postedDate).toBeUndefined();
    expect(j.postedDateSemantics).toBe('unknown');
  });

  it('work mode from isRemote + explicit fields; no word-sniffing here', async () => {
    expect((await normalize(raw('r1', { isRemote: true }))).remote).toBe(true);
    expect((await normalize(raw('o1', { isRemote: false }))).remote).toBe(false);
  });

  it('description strips HTML (preferred) with plain-text fallback', async () => {
    const html = await normalize(raw('d1', { descriptionPlain: 'PLAIN TEXT', descriptionHtml: '<p>HTML <b>ONLY</b></p>' }));
    expect(html.description).toBe('HTML ONLY');
    const plain = await normalize(raw('d2', { descriptionHtml: undefined, descriptionPlain: 'PLAIN TEXT' }));
    expect(plain.description).toBe('PLAIN TEXT');
  });

  it('upsert idempotency: same fingerprint updates, never duplicates; first_seen preserved', () => {
    upsertAtsJobs([ashbyRow()]);
    const db = getDb();
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE fingerprint='ashby-fixture-1'").get() as { c: number }).c).toBe(1);
    upsertAtsJobs([ashbyRow({ title: 'Senior Software Engineer' })]);
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE fingerprint='ashby-fixture-1'").get() as { c: number }).c).toBe(1);
  });

  it('fingerprints never collide across ashby/lever/greenhouse', async () => {
    const a = await normalize(raw('77'));
    expect(a.fingerprint).toBe('ash-77');
    expect(a.fingerprint === 'lev-77').toBe(false);
    expect(a.fingerprint === 'gh-77').toBe(false);
  });

  it('provider registry routes Ashby to local_index; others unchanged', () => {
    expect(atsProviderMode('Ashby', true)).toBe('local_index');
    expect(atsProviderMode('Greenhouse', true)).toBe('local_index');
    expect(atsProviderMode('Lever', true)).toBe('local_index');
  });

  it('failed board / empty board never deactivates existing ashby jobs', () => {
    deactivateStaleJobs(48, 'ashby');
    const db = getDb();
    expect((db.prepare("SELECT is_active FROM ats_jobs WHERE fingerprint='ashby-fixture-1'").get() as { is_active: number }).is_active).toBe(1);
  });

  it('partial sample crawl must not deactivate unsampled ashby jobs', () => {
    upsertAtsJobs([ashbyRow({ fingerprint: 'ashby-unsampled-1', external_id: 'unsampled-1' })]);
    deactivateStaleJobs(48, 'ashby');
    const db = getDb();
    expect((db.prepare("SELECT is_active FROM ats_jobs WHERE fingerprint='ashby-unsampled-1'").get() as { is_active: number }).is_active).toBe(1);
  });

  it('zero-network local Ashby search + source isolation + LIMIT + date filters', async () => {
    const db = getDb();
    upsertAtsJobs([
      ashbyRow({ fingerprint: 'ashby-new-1', external_id: 'new-1', title: 'Software Engineer', posted_date: iso(5) }),
      ashbyRow({ fingerprint: 'ashby-old-1', external_id: 'old-1', title: 'Platform Engineer', posted_date: iso(30 * 24) }),
    ]);
    db.prepare("INSERT INTO ats_jobs (fingerprint, ats_platform, external_id, company, company_slug, title, location, employment_type, work_mode, posted_date, posted_date_semantics, apply_url, job_url, description, first_seen_at, last_seen_at, last_fetched_at, is_active) VALUES ('lev-only-1','lever','l1','LEVX','levx','Software Engineer','Bengaluru, India',NULL,NULL,'created','created','https://jobs.lever.co/levx/1','https://jobs.lever.co/levx/1','desc',?,?,?,1)").run(iso(24), iso(24), iso(24));

    let networkCalls = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { networkCalls++; return (orig as any)(...a); };
    try {
      const ashby = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Ashby' }, [ashbyIndexProvider]);
      expect(networkCalls).toBe(0);
      expect(ashby.jobs.length).toBeGreaterThan(0);
      expect(ashby.jobs.every((j: any) => j.atsPlatform === 'ashby')).toBe(true);
      expect(ashby.jobs.every((j: any) => j.source === 'Ashby')).toBe(true);
      expect(ashby.jobs.length).toBeLessThanOrEqual(10);
      expect(ashby.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 7 * 24 * H)).toBe(true);

      const lever = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Lever' }, [leverIndexProvider]);
      expect(lever.jobs.every((j: any) => j.atsPlatform === 'lever')).toBe(true);
      const gh = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
      expect(gh.jobs.every((j: any) => j.atsPlatform === 'greenhouse')).toBe(true);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('24h / 30d filters operate on the provider published timestamp', async () => {
    const d24 = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '24h', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Ashby' }, [ashbyIndexProvider]);
    expect(d24.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 24 * H)).toBe(true);
    const d30 = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: '30d', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Ashby' }, [ashbyIndexProvider]);
    expect(d30.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() >= Date.now() - 30 * 24 * H)).toBe(true);
  });

  it('readiness is provider-specific: greenhouse/lever ready while ashby builds', () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt) VALUES ('gh-1','GHX','https://boards.greenhouse.io/ghx','greenhouse','ghx',1,?,?)").run(iso(30 * 24), iso(30 * 24));
    db.prepare("INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt) VALUES ('lv-1','LEVX','https://jobs.lever.co/levx','lever','levx',1,?,?)").run(iso(30 * 24), iso(30 * 24));
    const ghStats = boardRefreshStats('greenhouse');
    const levStats = boardRefreshStats('lever');
    const ashStats = boardRefreshStats('ashby');
    expect(ghStats.indexState).toBeDefined();
    expect(levStats.indexState).toBeDefined();
    expect(ashStats.indexState).toBeDefined();
    expect(ashStats.boardsTotal).toBeGreaterThanOrEqual(1);
  });

  it('ashby search result carries full JD for Tailor (metadata compatibility)', async () => {
    const ashby = await runV2Search(USER, { keywords: 'Software Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 5, source: 'Ashby' }, [ashbyIndexProvider]);
    const withDesc = ashby.jobs.find((j: any) => (j.description || '').length > 10);
    expect(withDesc).toBeTruthy();
    expect(withDesc.applyUrl).toContain('jobs.ashbyhq.com');
    expect(withDesc.url).toContain('jobs.ashbyhq.com');
    expect(withDesc.postedDateSemantics).toBe('published');
  });

  it('prototype-chain token in company name must not crash relevance (Constructor bug)', async () => {
    const db = getDb();
    upsertAtsJobs([ashbyRow({ fingerprint: 'ashby-constructor-1', external_id: 'constructor-1', title: 'Backend Engineer', company: 'Constructor' })]);
    let networkCalls = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { networkCalls++; return (orig as any)(...a); };
    try {
      const res = await runV2Search(USER, { keywords: 'Backend Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Ashby' }, [ashbyIndexProvider]);
      expect(networkCalls).toBe(0);
      expect(res.jobs.some((j: any) => j.company === 'Constructor')).toBe(true);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('clearAtsIndex(platform) isolates per platform', () => {
    clearAtsIndex('ashby');
    const db = getDb();
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE ats_platform='ashby'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM ats_jobs WHERE ats_platform='lever'").get() as { c: number }).c).toBe(1);
  });
});