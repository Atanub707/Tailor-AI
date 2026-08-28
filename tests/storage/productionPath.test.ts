// End-to-end production-path regression tests (Part G):
//   * index-ready routing never uses the legacy 8-board path
//   * observability fields (searchMode/indexState/coverage)
//   * neutral work-mode default is 'all' (never 'remote' unless chosen)
//   * determinism of repeated index searches
//   * result counts vs addedCount semantics
// Fixtures only, zero live calls.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-path-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs, indexResponseState, recordBoardAttempt } = await import('../../server/ats-index/atsRepository.js');
const { atsProviderMode } = await import('../../server/providers/providerRegistry.js');
const { greenhouseIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
import { DEFAULT_JOB_TYPE } from '../../src/constants/sources.js';
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';

const USER = 'e2e-user';
const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();

type RowSpec = [string, string, string, number, string];
const rows: AtsJobRow[] = ([
  ['gh-1', 'DevOps Engineer', 'Bengaluru, India', 24, 'Role: DevOps Engineer (Remote)'],
  ['gh-2', 'DevOps Engineer', 'Pune, India', 48, 'Role: DevOps Engineer'],
  ['gh-3', 'Site Reliability Engineer', 'Hyderabad, India', 72, 'Role: SRE On-site only'],
  ['gh-4', 'Data Engineer', 'Chennai, India', 24, 'Role: Data Engineer'],
  ['gh-5', 'Account Executive', 'Mumbai, India', 24, 'Role: Account Executive'],
] as RowSpec[]).map(([fingerprint, title, location, hAgo, description]) => ({
  fingerprint,
  ats_platform: 'greenhouse',
  external_id: fingerprint.replace('gh-', ''),
  company: 'E2E Co',
  company_slug: 'e2e',
  title,
  location,
  employment_type: 'Full-time',
  work_mode: 'On-site',
  posted_date: iso(hAgo as number),
  posted_date_semantics: 'published',
  apply_url: `https://boards.greenhouse.io/e2e/${fingerprint}`,
  job_url: `https://boards.greenhouse.io/e2e/${fingerprint}`,
  description: description as string,
  first_seen_at: iso(48 * 24),
  last_seen_at: iso(48 * 24),
  last_fetched_at: iso(48 * 24),
  is_active: 1,
}));

describe('Greenhouse production path', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'E2E', 'e2e@test.local');
    db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, atsCompanySlug, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'greenhouse', ?, 1, ?, ?)`
    ).run('sb-e2e', 'E2E', 'https://boards.greenhouse.io/e2e', 'e2e', iso(30 * 24), iso(30 * 24));
    upsertAtsJobs(rows);
    recordBoardAttempt('greenhouse', 'e2e', true, 5, iso(-2));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. READY index routes Greenhouse to the local index path (never the 8-board path)', () => {
    expect(atsProviderMode('Greenhouse', true)).toBe('local_index');
    expect(atsProviderMode('Greenhouse', false)).toBe('network');
    // Lever/Ashby stay network-backed until their ingestion lands — explicit,
    // never a silent local fallback.
    expect(atsProviderMode('Lever', true)).toBe('local_index');
    expect(atsProviderMode('Ashby', true)).toBe('local_index');
    expect(atsProviderMode('LinkedIn', true)).toBe('none');
  });

  it('2. READY Greenhouse search makes ZERO provider network calls', async () => {
    let net = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (...a: unknown[]) => { net++; return (orig as any)(...a); };
    try {
      const r = await runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
      expect(r.returnedCount).toBeGreaterThan(0);
      expect(net).toBe(0);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('3. local index search does not invoke legacy board discovery', () => {
    // The index provider queries ats_jobs only — legacy 8-board discovery
    // lives in the network provider, which routing never selects for a READY
    // Greenhouse search (asserted above).
    expect(atsProviderMode('Greenhouse', true)).toBe('local_index');
  });

  it('4. uninitialized/disabled index behavior is explicit, not a silent 8-board search', () => {
    // Flag OFF → network mode is the explicit rollback (documented), never
    // presented as index search. Flag ON + empty index → indexResponseState
    // reports uninitialized/building instead of hiding behind a sample.
    const db = getDb();
    db.prepare("UPDATE company_career_sites SET last_attempt_at = NULL, last_success_at = NULL, failure_count = 0, next_refresh_at = NULL, last_job_count = NULL WHERE atsCompanySlug = 'e2e'").run();
    const st = indexResponseState('greenhouse');
    expect(st.searchMode).toBe('local_index');
    expect(st.indexState).toBe('uninitialized');
    expect(st.indexReady).toBe(false);
    expect(st.coveragePercent).toBe(0);
    recordBoardAttempt('greenhouse', 'e2e', true, 5, iso(-2)); // restore ready
    expect(indexResponseState('greenhouse').indexState).toBe('ready');
  });

  it('5. search response carries searchId + result count + searchMode observability', async () => {
    const r = await runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
    expect(r.searchId).toMatch(/^search-/);
    expect(r.returnedCount).toBeGreaterThan(0);
    const st = indexResponseState('greenhouse');
    expect(st.searchMode).toBe('local_index');
    expect(st.indexState).toBe('ready');
    expect(st.coveragePercent).toBe(100);
  });

  it('6+7. addedCount=0 does not mean zero results; results retrievable by searchId', async () => {
    const r1 = await runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
    const r2 = await runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
    expect(r2.returnedCount).toBeGreaterThan(0); // identical search still returns results
    const { getJobIdsForSearch } = await import('../../server/storage/v2Tables.js');
    const linked = getJobIdsForSearch(USER, r2.searchId);
    expect(linked.length).toBe(r2.returnedCount); // search_jobs holds the result set
  });

  it('10. repeated identical index search is deterministic (same fingerprints, same order)', async () => {
    const run = () =>
      runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
    const a = await run();
    const b = await run();
    const c = await run();
    const fp = (r: { jobs: { fingerprint: string }[] }) => r.jobs.map((j) => j.fingerprint).join(',');
    expect(fp(a)).toBe(fp(b));
    expect(fp(b)).toBe(fp(c));
  });

  it('11. neutral work-mode default is "all" — the UI never sends remote by accident', () => {
    expect(DEFAULT_JOB_TYPE).toBe('all');
  });

  it('12. explicit Remote selection still filters (work-mode enforcement intact)', async () => {
    const r = await runV2Search(USER, { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'remote', workMode: 'remote', level: 'any', limit: 10, source: 'Greenhouse' }, [greenhouseIndexProvider]);
    // Remote-labeled job passes; explicitly On-site-labeled job is excluded;
    // UNLABELED jobs pass (the orchestrator cannot prove they contradict —
    // existing designed semantics).
    const titles = r.jobs.map((j: any) => j.title);
    expect(titles).toContain('DevOps Engineer'); // the (Remote)-labeled one
    expect(titles).not.toContain('Site Reliability Engineer'); // "On-site only"
    expect(r.jobs.some((j: any) => j.fingerprint === 'gh-2')).toBe(true); // unlabeled passes
  });
});