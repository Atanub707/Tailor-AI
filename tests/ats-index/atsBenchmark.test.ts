// ATS index benchmark — SYNTHETIC data only (no live calls). Measures the
// local-search cost at 1k / 10k / 50k indexed jobs: candidate retrieval,
// orchestrator search (date+location+relevance+rank+LIMIT), DB size, and an
// informational FTS lookup comparison. The FTS numbers are reported but FTS
// is NOT used in the search path (abbreviation/related candidates would be
// dropped — see atsRepository header).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-bench-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { upsertAtsJobs, clearAtsIndex, ensureAtsIndexSchema, queryAtsCandidates, ftsLookup, dbSizeBytes } = await import('../../server/ats-index/atsRepository.js');
const { greenhouseIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';

const USER = 'bench-user';
const H = 3600e3;
const iso = (hAgo: number) => new Date(Date.now() - hAgo * H).toISOString();

const TITLES = [
  'DevOps Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Data Engineer',
  'Senior Data Engineer', 'Software Engineer', 'Senior Software Engineer', 'Frontend Engineer',
  'Backend Engineer', 'Machine Learning Engineer', 'ML Engineer', 'Applied ML Engineer',
  'Cyber Security Engineer', 'Security Engineer', 'Cloud Security Engineer', 'Blockchain Engineer',
  'QA Engineer', 'iOS Engineer', 'Android Engineer', 'Network Engineer', 'Solutions Architect',
  'Technical Support Engineer', 'Engineering Manager', 'Product Manager', 'Account Executive',
  'Sales Engineer', 'Credit Operations Analyst', 'Data Entry', 'Kubernetes Engineer',
  'Cloud Engineer', 'Systems Engineer', 'Database Engineer', 'Automation Engineer',
  'Security Analyst', 'Data Scientist', 'Mobile Developer', 'Full Stack Engineer',
];
const LOCATIONS = [
  'Bengaluru, Karnataka, India', 'Hyderabad, India', 'Pune, India', 'Mumbai, India',
  'Delhi, India', 'Chennai, India', 'Remote - India', 'San Francisco, CA, USA',
  'New York, NY, USA', 'London, UK', 'Berlin, Germany', 'Paris, France',
  'Singapore', 'Sydney, Australia', 'Tokyo, Japan', 'Remote - Europe',
];
const COMPANIES = Array.from({ length: 200 }, (_, i) => `BenchCo ${i}`);

function syntheticRows(n: number, slugOf: (i: number) => string): AtsJobRow[] {
  const out: AtsJobRow[] = [];
  for (let i = 0; i < n; i++) {
    const hAgo = (i % 30) + 1; // spread over 30 days → 7d window ≈ 23%
    out.push({
      fingerprint: `gh-bench-${i}`,
      ats_platform: 'greenhouse',
      external_id: String(i),
      company: COMPANIES[i % COMPANIES.length],
      company_slug: slugOf(i),
      title: TITLES[i % TITLES.length],
      location: LOCATIONS[i % LOCATIONS.length],
      employment_type: 'Full-time',
      work_mode: i % 3 === 0 ? 'Remote' : 'On-site',
      posted_date: iso(hAgo * 24),
      posted_date_semantics: 'published',
      apply_url: `https://boards.greenhouse.io/bench${i % 50}/jobs/${i}`,
      job_url: `https://boards.greenhouse.io/bench${i % 50}/jobs/${i}`,
      description: `Role: ${TITLES[i % TITLES.length]} at ${COMPANIES[i % COMPANIES.length]}`,
      first_seen_at: iso(24 * 30),
      last_seen_at: iso(24 * 30),
      last_fetched_at: iso(24 * 30),
      is_active: 1,
    });
  }
  return out;
}

async function seed(n: number): Promise<void> {
  const rows = syntheticRows(n, (i) => `bench${i % 50}`);
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    upsertAtsJobs(rows.slice(i, i + CHUNK));
  }
}

describe('ATS index benchmark (synthetic data, zero live calls)', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Bench', 'bench@test.local');
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  for (const n of [1000, 10000, 50000]) {
    it(`benchmark at ${n} jobs`, async () => {
      clearAtsIndex('greenhouse');
      // The orchestrator cache is keyed by query fingerprint, not index size —
      // clear it so every size measures a cold search.
      getDb().prepare('DELETE FROM search_cache WHERE user_id = ?').run(USER);
      const sizeBefore = dbSizeBytes();
      const tSeed = Date.now();
      await seed(n);
      const seedMs = Date.now() - tSeed;
      const sizeAfter = dbSizeBytes();
      const bytesPerJob = (sizeAfter - sizeBefore) / n;

      const tRetrieval = Date.now();
      const candidates = queryAtsCandidates({
        platform: 'greenhouse',
        activeOnly: true,
        minPostedDate: iso(7 * 24),
      });
      const retrievalMs = Date.now() - tRetrieval;

      const tSearch = Date.now();
      const result = await runV2Search(
        USER,
        { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 25, source: 'Greenhouse' },
        [greenhouseIndexProvider]
      );
      const searchMs = Date.now() - tSearch;

      const tFts = Date.now();
      const ftsHits = ftsLookup('greenhouse', 'engineer OR devops OR platform');
      const ftsMs = Date.now() - tFts;

      console.log(
        `BENCH n=${n}: seed=${seedMs}ms size=${sizeAfter} bytes/job=${bytesPerJob.toFixed(0)} ` +
          `candidates(7d) = ${candidates.length} retrieval=${retrievalMs}ms ` +
          `search(LIMIT 25, India, 7d) = ${searchMs}ms returned=${result.returnedCount} ` +
          `ftsLookup=${ftsHits.length} hits in ${ftsMs}ms`
      );
      expect(result.returnedCount).toBeLessThanOrEqual(25);
      expect(result.returnedCount).toBeGreaterThan(0); // 23% of 1k+ in window, India+devops present
    });
  }
});