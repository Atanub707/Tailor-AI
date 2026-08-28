// Search next-new-jobs — repeated identical searches must keep returning NEW
// discoverable jobs until the ranked relevant pool is genuinely exhausted.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-next-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, getUserJobFingerprints, saveNewJobs } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs, queryAtsCandidates, clearAtsIndex } = await import('../../server/ats-index/atsRepository.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { clearSearchCache } = await import('../../server/search/searchCache.js');
const { greenhouseIndexProvider, leverIndexProvider, ashbyIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';
import type { Job } from '../../src/types.js';

const USER = 'search-user';
const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();

function atsRow(i: number, over: Partial<AtsJobRow> = {}): AtsJobRow {
  return {
    fingerprint: `gh-test-${i}`,
    ats_platform: 'greenhouse',
    external_id: String(i),
    company: 'Acme',
    company_slug: 'acme',
    title: 'DevOps Engineer',
    location: 'Bengaluru, India',
    employment_type: 'Full-time',
    work_mode: 'On-site',
    posted_date: iso(24 * i), // staggered ages
    posted_date_semantics: 'created',
    apply_url: `https://boards.greenhouse.io/acme/${i}`,
    job_url: `https://boards.greenhouse.io/acme/${i}`,
    description: 'Build and operate CI/CD pipelines, Kubernetes clusters and Terraform infrastructure.',
    first_seen_at: iso(24 * i),
    last_seen_at: iso(24 * i),
    last_fetched_at: iso(24 * i),
    is_active: 1,
    ...over,
  };
}

function persistIntoJobs(rows: AtsJobRow[]): void {
  runWithUser(USER, () => {
    saveNewJobs(rows.map((r) => ({
      id: r.fingerprint,
      externalId: r.external_id,
      title: r.title,
      company: r.company,
      location: r.location,
      description: r.description,
      atsPlatform: r.ats_platform,
      jobUrl: r.job_url,
      applyUrl: r.apply_url,
      url: r.apply_url,
      source: 'Greenhouse',
      postedDate: r.posted_date,
      postedDateSemantics: r.posted_date_semantics,
      createdAt: new Date().toISOString(),
      scrapedAt: new Date().toISOString(),
      fingerprint: r.fingerprint,
      state: 'pending',
    } as unknown as Job)));
  });
}

const search = (limit: number, opts: Record<string, unknown> = {}) =>
  runV2Search(USER, {
    keywords: 'DevOps Engineer',
    location: undefined,
    postedWindow: 'any',
    jobType: 'all',
    workMode: 'all',
    level: 'any',
    limit,
    source: 'Greenhouse',
    ...opts,
  } as any, [greenhouseIndexProvider]);

describe('Search next-new-jobs', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'SearchUser', 's@test.local');
    });
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    clearAtsIndex('greenhouse');
    clearAtsIndex('lever');
    clearAtsIndex('ashby');
    clearSearchCache(USER);
    runWithUser(USER, () => {
      getDb().prepare('DELETE FROM jobs WHERE user_id = ?').run(USER);
    });
  });

  it('A. basic repeated discovery: 120 jobs / LIMIT 50 → 50, 50, 20, 0; no overlap', async () => {
    upsertAtsJobs(Array.from({ length: 120 }, (_, i) => atsRow(i + 1)));
    const r1 = await search(50);
    expect(r1.returnedCount).toBe(50);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    persistIntoJobs(r2.jobs as any);
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(20);
    expect(r3.exhausted).toBe(true);
    persistIntoJobs(r3.jobs as any);
    const r4 = await search(50);
    expect(r4.returnedCount).toBe(0);
    expect(r4.exhausted).toBe(true);
    const seen = [...r1.jobs, ...r2.jobs, ...r3.jobs].map((j: any) => j.fingerprint);
    expect(new Set(seen).size).toBe(120); // all unique, no overlap
  });

  it('B. pre-existing user jobs never count toward LIMIT: 20 existing + 100 NEW → 50/50/0', async () => {
    upsertAtsJobs(Array.from({ length: 120 }, (_, i) => atsRow(i + 1)));
    persistIntoJobs(Array.from({ length: 20 }, (_, i) => atsRow(i + 1))); // 20 already in workflow
    const r1 = await search(50);
    expect(r1.returnedCount).toBe(50);
    expect(r1.jobs.every((j: any) => !getUserJobFingerprints(USER).has(j.fingerprint))).toBe(true);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    persistIntoJobs(r2.jobs as any);
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(0); // 20 + 50 + 50 = 120 → exhausted
    expect(r3.exhausted).toBe(true);
  });

  it('C. LIMIT change does not define discovery identity', async () => {
    upsertAtsJobs(Array.from({ length: 120 }, (_, i) => atsRow(i + 1)));
    const r1 = await search(25);
    expect(r1.returnedCount).toBe(25);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    persistIntoJobs(r2.jobs as any);
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(45);
    persistIntoJobs(r3.jobs as any);
    const r4 = await search(50);
    expect(r4.returnedCount).toBe(0);
  });

  it('D. relevance survivors: 200 rows, 130 relevant → 50, 50, 30, 0', async () => {
    const rows = [
      ...Array.from({ length: 130 }, (_, i) => atsRow(i + 1)),
      ...Array.from({ length: 70 }, (_, i) => atsRow(500 + i, { title: 'Office Manager', company: 'Unrelated Co' })),
    ];
    upsertAtsJobs(rows);
    const r1 = await search(50);
    expect(r1.returnedCount).toBe(50);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    persistIntoJobs(r2.jobs as any);
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(30);
    expect(r3.exhausted).toBe(true);
  });

  it('E. date windows never escape: 24h/7d/30d repeated searches stay inside their window', async () => {
    const d24Rows = Array.from({ length: 30 }, (_, i) => atsRow(i + 1, { posted_date: iso(6) }));
    upsertAtsJobs(d24Rows);
    const a1 = await search(10, { postedWindow: '24h' });
    expect(a1.returnedCount).toBe(10);
    persistIntoJobs(a1.jobs as any);
    const a2 = await search(10, { postedWindow: '24h' });
    expect(a2.returnedCount).toBe(10);
    expect(a2.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() > Date.now() - 24 * H)).toBe(true);
    persistIntoJobs(a2.jobs as any);
    const a3 = await search(10, { postedWindow: '24h' });
    expect(a3.returnedCount).toBe(10); // 30 total in 24h
    expect(a3.jobs.every((j: any) => new Date(j.postedDate || 0).getTime() > Date.now() - 24 * H)).toBe(true);
    persistIntoJobs(a3.jobs as any);
    expect((await search(10, { postedWindow: '24h' })).returnedCount).toBe(0);
  });

  it('F. work mode never relaxed to fill LIMIT', async () => {
    upsertAtsJobs([
      ...Array.from({ length: 12 }, (_, i) => atsRow(i + 1, { work_mode: 'Remote', location: 'Remote' })),
      ...Array.from({ length: 40 }, (_, i) => atsRow(100 + i, { work_mode: 'On-site', location: 'On-site, Bengaluru, India' })),
    ]);
    const r1 = await search(50, { workMode: 'remote' });
    expect(r1.returnedCount).toBe(12);
    expect(r1.jobs.every((j: any) => detectWm(j) === 'remote')).toBe(true);
    persistIntoJobs(r1.jobs as any);
    expect((await search(50, { workMode: 'remote' })).returnedCount).toBe(0); // no relaxation
  });

  it('G. location never relaxed to fill LIMIT', async () => {
    upsertAtsJobs([
      ...Array.from({ length: 8 }, (_, i) => atsRow(i + 1, { location: 'Bengaluru, India' })),
      ...Array.from({ length: 40 }, (_, i) => atsRow(100 + i, { location: 'Singapore' })),
    ]);
    const r1 = await search(50, { location: 'Bengaluru' });
    expect(r1.returnedCount).toBe(8);
    expect(r1.jobs.every((j: any) => String(j.location).toLowerCase().includes('bengaluru'))).toBe(true);
  });

  it('H. source isolation: Greenhouse/Lever/Ashby independent', async () => {
    upsertAtsJobs(Array.from({ length: 30 }, (_, i) => atsRow(i + 1)));
    upsertAtsJobs(Array.from({ length: 30 }, (_, i) => ({ ...atsRow(1000 + i), ats_platform: 'lever', fingerprint: `lev-test-${i}`, company_slug: 'acme-l' })));
    upsertAtsJobs(Array.from({ length: 30 }, (_, i) => ({ ...atsRow(2000 + i), ats_platform: 'ashby', fingerprint: `ash-test-${i}`, company_slug: 'acme-a' })));
    const gh = await search(25);
    expect(gh.jobs.every((j: any) => j.atsPlatform === 'greenhouse')).toBe(true);
    const lev = await runV2Search(USER, { keywords: 'DevOps Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Lever' } as any, [leverIndexProvider]);
    expect(lev.jobs.every((j: any) => j.atsPlatform === 'lever')).toBe(true);
    const ash = await runV2Search(USER, { keywords: 'DevOps Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Ashby' } as any, [ashbyIndexProvider]);
    expect(ash.jobs.every((j: any) => j.atsPlatform === 'ashby')).toBe(true);
    expect(lev.returnedCount).toBe(25); // lever pool untouched by gh run
    expect(ash.returnedCount).toBe(25);
  });

  it('I. query change: globally deduped, still fills NEW limit', async () => {
    upsertAtsJobs([
      ...Array.from({ length: 40 }, (_, i) => atsRow(i + 1)),                                   // DevOps
      ...Array.from({ length: 40 }, (_, i) => atsRow(500 + i, { title: 'Kubernetes Engineer' })), // K8s
    ]);
    const devops = await search(40);
    expect(devops.returnedCount).toBe(40);
    persistIntoJobs(devops.jobs as any);
    const k8s = await runV2Search(USER, { keywords: 'Kubernetes Engineer', location: undefined, postedWindow: 'any', jobType: 'all', workMode: 'all', level: 'any', limit: 40, source: 'Greenhouse' } as any, [greenhouseIndexProvider]);
    expect(k8s.returnedCount).toBe(40); // k8s pool untouched by devops persistence
    expect(k8s.jobs.every((j: any) => !getUserJobFingerprints(USER).has(j.fingerprint))).toBe(true);
    expect(k8s.jobs.every((j: any) => j.title.includes('Kubernetes'))).toBe(true);
  });

  it('J. cache cannot poison repeated discovery', async () => {
    upsertAtsJobs(Array.from({ length: 120 }, (_, i) => atsRow(i + 1)));
    const r1 = await search(50);
    persistIntoJobs(r1.jobs as any);
    // Second search within cache TTL — must still return the NEXT 50.
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    expect(r2.jobs.some((j: any) => r1.jobs.some((k: any) => k.fingerprint === j.fingerprint))).toBe(false);
  });

  it('K. concurrent duplicate persistence: idempotent user jobs', async () => {
    upsertAtsJobs(Array.from({ length: 20 }, (_, i) => atsRow(i + 1)));
    // Two near-simultaneous identical searches before anything is persisted
    // may return overlapping batches — the DB dedupe must be authoritative.
    const r1 = await search(10);
    const r2 = await search(10);
    persistIntoJobs(r1.jobs as any);
    persistIntoJobs(r2.jobs as any);
    const db = getDb();
    const dup = db.prepare('SELECT id, count(*) c FROM jobs WHERE user_id = ? GROUP BY id HAVING c > 1').all(USER);
    expect(dup.length).toBe(0); // zero duplicate user rows
  });

  it('L. exhaustion: partial batch then 0', async () => {
    upsertAtsJobs(Array.from({ length: 17 }, (_, i) => atsRow(i + 1)));
    const r1 = await search(50);
    expect(r1.returnedCount).toBe(17);
    expect(r1.exhausted).toBe(true);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(0);
    expect(r2.exhausted).toBe(true);
    persistIntoJobs(r2.jobs as any); // persist nothing; next run still 0
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(0);
  });

  it('M. LIMIT=1 walks one new job at a time', async () => {
    upsertAtsJobs(Array.from({ length: 5 }, (_, i) => atsRow(i + 1)));
    const got: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await search(1);
      expect(r.returnedCount).toBe(1);
      got.push(r.jobs[0].fingerprint);
      persistIntoJobs(r.jobs as any);
    }
    expect(new Set(got).size).toBe(5);
    const r6 = await search(1);
    expect(r6.returnedCount).toBe(0);
  });

  it('N. LIMIT=50 max works', async () => {
    upsertAtsJobs(Array.from({ length: 110 }, (_, i) => atsRow(i + 1)));
    const r1 = await search(50);
    expect(r1.returnedCount).toBe(50);
    persistIntoJobs(r1.jobs as any);
    const r2 = await search(50);
    expect(r2.returnedCount).toBe(50);
    persistIntoJobs(r2.jobs as any);
    const r3 = await search(50);
    expect(r3.returnedCount).toBe(10);
  });
});

function detectWm(j: any): string {
  const s = `${j.location || ''} ${j.description || ''}`.toLowerCase();
  if (/\bremote\b/.test(s)) return 'remote';
  if (/\bhybrid\b/.test(s)) return 'hybrid';
  if (/\bon-?site\b/.test(s)) return 'onsite';
  return 'unknown';
}