// Greenhouse Milestone 1 — neutral provider + orchestrator pipeline.
// All fixtures, zero live calls. Covers:
//   * provider neutrality (noise jobs pass THROUGH the provider)
//   * date semantics (first_published honored, updated fallback labelled)
//   * the 7-query acceptance matrix
//   * location / date-window / LIMIT / dedupe / isolation / cache / no-score-0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-gh-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');
const { setDirectAtsFetcher } = await import('../../server/providers/directAtsProvider.js');
const { greenhouseProvider } = await import('../../server/providers/greenhouseProvider.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { evaluateRelevance } = await import('../../server/search/relevance.js');
import type { JobSearchParams } from '../../server/providers/types.js';

const USER = 'gh-user';
const H = 3600e3;
const now = Date.now();
const iso = (hAgo: number) => new Date(now - hAgo * H).toISOString();

// ── Fixtures: 5 Greenhouse boards with deliberately MIXED roles ──
const gh = (id: number, title: string, location: string, hAgo: number, updatedOnly = false) => ({
  id: String(id),
  title,
  location: { name: location },
  absolute_url: `https://boards.greenhouse.io/fixture/jobs/${id}`,
  first_published: updatedOnly ? undefined : iso(hAgo),
  updated_at: iso(Math.max(hAgo, 4)),
  company_name: 'Fixture Co',
});

const BOARDS: Record<string, any[]> = {
  'fixture-a': [
    gh(1, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 20),
    gh(2, 'Site Reliability Engineer', 'Remote - India', 72),
    gh(3, 'Platform Engineer', 'Bengaluru, Karnataka, India', 120),
    gh(4, 'Data Engineer', 'San Francisco, CA, USA', 48),
    gh(5, 'Account Executive', 'Mumbai, India', 24),
    gh(6, 'Credit Operations Analyst', 'Bengaluru, Karnataka, India', 96),
    gh(7, 'Product Manager', 'Delhi, India', 48),
    gh(999, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 20), // dup of fixture-b
    gh(9, 'Senior Data Engineer', 'Bengaluru, Karnataka, India', 120),
    gh(10, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 1080), // 45d — only "Anytime"
  ],
  'fixture-b': [
    gh(11, 'Senior DevOps Engineer', 'Hyderabad, India', 48),
    gh(12, 'Machine Learning Engineer', 'Pune, India', 24),
    gh(13, 'Frontend Engineer', 'Bengaluru, Karnataka, India', 24),
    gh(14, 'Cyber Security Engineer', 'Mumbai, India', 24),
    gh(15, 'Software Engineer', 'Bengaluru, Karnataka, India', 24),
    gh(16, 'Blockchain Engineer', 'Bengaluru, Karnataka, India', 48),
    gh(17, 'Sales Engineer', 'Delhi, India', 24),
    gh(18, 'Updated-Only DevOps Engineer', 'Remote - India', 24, true),
    gh(19, 'Data Entry', 'Pune, India', 24),
    gh(999, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 20), // dup of fixture-a
  ],
  'fixture-c': [
    gh(21, 'Security Engineer', 'Bengaluru, Karnataka, India', 24),
    gh(22, 'React Engineer', 'Bengaluru, Karnataka, India', 72),
    gh(23, 'ML Engineer', 'Bengaluru, Karnataka, India', 96),
    gh(24, 'Backend Engineer', 'Hyderabad, India', 24),
    gh(25, 'Data Platform Engineer', 'Pune, India', 144),
    gh(26, 'Kubernetes Engineer', 'Bengaluru, Karnataka, India', 144),
    gh(27, 'Cloud Security Engineer', 'Remote - India', 48),
    gh(28, 'Applied ML Engineer', 'Remote - India', 48),
    gh(29, 'Data Engineer', 'Chennai, India', 48),
    gh(36, 'Site Reliability Engineer', 'Bengaluru, Karnataka, India', 600), // 25d
  ],
  'fixture-d': [
    gh(30, 'QA Engineer', 'Bengaluru, Karnataka, India', 24),
    gh(31, 'iOS Engineer', 'Mumbai, India', 48),
    gh(32, 'Network Engineer', 'Delhi, India', 72),
  ],
  'fixture-e': [
    gh(33, 'Solutions Architect', 'Bengaluru, Karnataka, India', 24),
    gh(34, 'Technical Support Engineer', 'Pune, India', 48),
    gh(35, 'Engineering Manager', 'Bengaluru, Karnataka, India', 72),
  ],
};

let fetchCount = 0;
function installFetcher() {
  fetchCount = 0;
  setDirectAtsFetcher(async (url: string) => {
    fetchCount++;
    const m = url.match(/boards\/([^/]+)\/jobs/);
    const slug = m ? m[1] : '';
    return { jobs: BOARDS[slug] || [] };
  });
}
installFetcher();

function search(over: Partial<JobSearchParams> = {}) {
  return runV2Search(
    USER,
    { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse', ...over },
    [greenhouseProvider]
  );
}

const titles = (r: { jobs: { title: string }[] }) => r.jobs.map((j) => j.title);

afterAll(() => {
  setDirectAtsFetcher(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Greenhouse neutral provider', () => {
  beforeAll(() => {
    ensureV2Tables();
    // Re-install the fixture fetcher from a hook: vitest may re-evaluate the
    // module between collection and execution, which would drop the
    // top-level override and send real network calls (never acceptable).
    installFetcher();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'GHUser', 'gh@test.local');
    const boardInsert = db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'greenhouse', 1, ?, ?)`
    );
    for (const slug of Object.keys(BOARDS)) {
      const id = `sb-${slug}`;
      boardInsert.run(id, `Fixture ${slug}`, `https://boards.greenhouse.io/${slug}`, iso(24 * 30), iso(24 * 30));
    }
  });
  afterAll(() => {
    // NOTE: cleanup must NOT live inside a describe — describe-scoped
    // afterAll runs between describes and would kill the fixture fetcher +
    // DB for every later test in this file.
  });

  it('retrieves + normalizes mixed roles UNFILTERED (neutrality)', async () => {
    const raw = await greenhouseProvider.search({ keywords: 'DevOps Engineer', source: 'Greenhouse', limit: 10 } as any, 50);
    const t = raw.jobs.map((j) => j.title);
    // Noise passes THROUGH the provider — filtering is the orchestrator's job.
    for (const noise of ['Account Executive', 'Product Manager', 'Sales Engineer', 'Credit Operations Analyst', 'Data Entry']) {
      expect(t).toContain(noise);
    }
    // Date semantics: first_published → 'published', updated fallback → 'updated'.
    expect(raw.jobs.find((j) => j.fingerprint === 'gh-1')?.postedDateSemantics).toBe('published');
    expect(raw.jobs.find((j) => j.fingerprint === 'gh-1')?.postedDate).toBe(iso(20));
    expect(raw.jobs.find((j) => j.fingerprint === 'gh-18')?.postedDateSemantics).toBe('updated');
    expect(raw.jobs.find((j) => j.fingerprint === 'gh-18')?.postedDate).toBe(iso(24));
  });

  it('pipeline drops every score-0 candidate — never reaches output', async () => {
    for (const q of ['DevOps Engineer', 'Data Engineer', 'Software Engineer', 'Frontend Engineer', 'Cyber Security Engineer', 'Machine Learning Engineer', 'Blockchain Engineer']) {
      const r = await search({ keywords: q, limit: 50, postedWindow: 'any' });
      for (const j of r.jobs) {
        expect(evaluateRelevance(q, `${j.title} ${j.company}`).relevanceScore).toBeGreaterThan(0);
      }
    }
  });
});

describe('Greenhouse search — 7-query acceptance matrix (India, 7d)', () => {
  const rejects = ['Account Executive', 'Product Manager', 'Sales Engineer', 'Data Entry', 'Credit Operations Analyst'];

  it('DevOps Engineer: exact + related survive, unrelated rejected', async () => {
    const r = await search({ keywords: 'DevOps Engineer' });
    const t = titles(r);
    for (const ok of ['DevOps Engineer', 'Senior DevOps Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Kubernetes Engineer', 'Cloud Security Engineer']) {
      expect(t).toContain(ok);
    }
    for (const no of [...rejects, 'Data Engineer', 'Senior Data Engineer', 'Machine Learning Engineer', 'Frontend Engineer', 'Backend Engineer', 'Security Engineer', 'React Engineer', 'ML Engineer', 'Applied ML Engineer', 'Blockchain Engineer', 'QA Engineer', 'iOS Engineer', 'Network Engineer', 'Solutions Architect', 'Technical Support Engineer', 'Engineering Manager']) {
      expect(t).not.toContain(no);
    }
  });

  it('Data Engineer: accepts data roles, rejects unrelated', async () => {
    const r = await search({ keywords: 'Data Engineer' });
    const t = titles(r);
    for (const ok of ['Data Engineer', 'Senior Data Engineer', 'Data Platform Engineer']) expect(t).toContain(ok);
    for (const no of ['DevOps Engineer', 'Frontend Engineer', ...rejects]) expect(t).not.toContain(no);
  });

  it('Software Engineer: exact survives, noise rejected', async () => {
    const r = await search({ keywords: 'Software Engineer' });
    const t = titles(r);
    expect(t).toContain('Software Engineer');
    for (const no of [...rejects, 'Frontend Engineer', 'Backend Engineer', 'Blockchain Engineer']) expect(t).not.toContain(no);
  });

  it('Frontend Engineer: accepts frontend family', async () => {
    const r = await search({ keywords: 'Frontend Engineer' });
    const t = titles(r);
    for (const ok of ['Frontend Engineer', 'React Engineer']) expect(t).toContain(ok);
    for (const no of ['Backend Engineer', 'Data Engineer', ...rejects]) expect(t).not.toContain(no);
  });

  it('Cyber Security Engineer: accepts security family', async () => {
    const r = await search({ keywords: 'Cyber Security Engineer' });
    const t = titles(r);
    for (const ok of ['Cyber Security Engineer', 'Security Engineer', 'Cloud Security Engineer']) expect(t).toContain(ok);
    for (const no of ['Software Engineer', 'Sales Engineer', ...rejects]) expect(t).not.toContain(no);
  });

  it('Machine Learning Engineer: accepts ML family via abbreviation expansion', async () => {
    const r = await search({ keywords: 'Machine Learning Engineer' });
    const t = titles(r);
    for (const ok of ['Machine Learning Engineer', 'ML Engineer', 'Applied ML Engineer']) expect(t).toContain(ok);
    for (const no of ['Data Entry', 'Account Executive', 'Frontend Engineer', 'Software Engineer']) expect(t).not.toContain(no);
  });

  it('Blockchain Engineer (unknown role): generic matching works', async () => {
    const r = await search({ keywords: 'Blockchain Engineer' });
    const t = titles(r);
    expect(t).toContain('Blockchain Engineer');
    for (const no of ['Backend Engineer', 'Sales Engineer', 'Product Manager']) expect(t).not.toContain(no);
  });
});

describe('Greenhouse search — constraints', () => {
  it('location honored: India includes Chennai, excludes SF; USA the reverse', async () => {
    const india = await search({ keywords: 'Data Engineer' });
    const fpIn = india.jobs.map((j) => j.fingerprint);
    expect(fpIn).toContain('gh-29'); // Chennai
    expect(fpIn).not.toContain('gh-4'); // San Francisco
    const usa = await search({ keywords: 'Data Engineer', location: 'USA' });
    const fpUsa = usa.jobs.map((j) => j.fingerprint);
    expect(fpUsa).toContain('gh-4');
    expect(fpUsa).not.toContain('gh-29');
  });

  it('date window honored: 24h / 7d / 30d / any', async () => {
    const r24 = await search({ keywords: 'DevOps Engineer', postedWindow: '24h', limit: 50 });
    const fp24 = r24.jobs.map((j) => j.fingerprint);
    expect(fp24).toContain('gh-1');
    expect(fp24).not.toContain('gh-11'); // 48h
    expect(fp24).not.toContain('gh-3'); // 120h

    const r7 = await search({ keywords: 'DevOps Engineer', postedWindow: '7d', limit: 50 });
    const fp7 = r7.jobs.map((j) => j.fingerprint);
    expect(fp7).toContain('gh-3');
    expect(fp7).not.toContain('gh-36'); // 25d

    const r30 = await search({ keywords: 'DevOps Engineer', postedWindow: '30d', limit: 50 });
    const fp30 = r30.jobs.map((j) => j.fingerprint);
    expect(fp30).toContain('gh-36');
    expect(fp30).not.toContain('gh-10'); // 45d

    const rAny = await search({ keywords: 'DevOps Engineer', postedWindow: 'any', limit: 50 });
    const fpAny = rAny.jobs.map((j) => j.fingerprint);
    expect(fpAny).toContain('gh-10');
  });

  it('LIMIT honored for 5/10/25/50', async () => {
    for (const limit of [5, 10, 25, 50]) {
      const r = await search({ keywords: 'DevOps Engineer', limit });
      expect(r.returnedCount).toBeLessThanOrEqual(limit);
    }
    // LIMIT 5 with ≥8 survivors → exactly 5 (no artificial widening).
    const r5 = await search({ keywords: 'DevOps Engineer', limit: 5, postedWindow: 'any' });
    expect(r5.returnedCount).toBe(5);
  });

  it('duplicate physical job deduped across boards (same external id)', async () => {
    const r = await search({ keywords: 'DevOps Engineer', postedWindow: 'any', limit: 50 });
    const fp = r.jobs.map((j) => j.fingerprint);
    expect(fp.filter((f) => f === 'gh-999').length).toBe(1);
  });

  it('search contexts isolated: DevOps and Data never contaminate each other', async () => {
    const a = await search({ keywords: 'DevOps Engineer' });
    const b = await search({ keywords: 'Data Engineer' });
    expect(a.queryFp).not.toBe(b.queryFp);
    expect(titles(a)).not.toContain('Data Engineer');
    expect(titles(b)).not.toContain('DevOps Engineer');
    // Source is part of the fingerprint — a LinkedIn DevOps search is a
    // different cache context than a Greenhouse one.
    expect(canonicalQueryFp('DevOps Engineer', 'India', '7d', 'Greenhouse')).not.toBe(
      canonicalQueryFp('DevOps Engineer', 'India', '7d', 'LinkedIn')
    );
  });

  it('cache: repeat search with enough survivors hits cache, no provider call', async () => {
    // 'any' window + LIMIT 10 has ≥10 DevOps survivors. An earlier test may
    // already have cached this exact fingerprint (fp ignores LIMIT), so r1
    // may be a hit or a miss — the invariant is: r2 never refetches.
    const callsBefore = fetchCount;
    const r1 = await search({ keywords: 'DevOps Engineer', location: 'India', postedWindow: 'any', limit: 10 });
    expect(r1.returnedCount).toBe(10);
    const afterFirst = fetchCount;
    expect(afterFirst - callsBefore).toBeLessThanOrEqual(5); // at most one board round
    const r2 = await search({ keywords: 'DevOps Engineer', location: 'India', postedWindow: 'any', limit: 10 });
    expect(r2.cacheHit).toBe(true); // cached >= limit → no provider call
    expect(r2.returnedCount).toBe(10);
    expect(fetchCount).toBe(afterFirst);
  });
});