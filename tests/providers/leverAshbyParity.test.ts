// Lever + Ashby provider parity — same neutral-provider architecture and the
// same role matrix as the Greenhouse milestone. All fixtures, zero live calls.
//   * provider neutrality (noise passes through)
//   * date semantics (Lever createdAt → 'created', Ashby publishedAt → 'published')
//   * 7-query acceptance matrix for BOTH providers
//   * location / date-window / LIMIT / dedupe / cache
//   * cross-provider isolation (Greenhouse/Lever/Ashby = 3 contexts)
//   * no cross-provider fallback (results carry only the selected source)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-lv-ash-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, canonicalQueryFp } = await import('../../server/storage/v2Tables.js');
const { setDirectAtsFetcher } = await import('../../server/providers/directAtsProvider.js');
const { leverProvider } = await import('../../server/providers/leverProvider.js');
const { ashbyProvider } = await import('../../server/providers/ashbyProvider.js');
const { greenhouseProvider } = await import('../../server/providers/greenhouseProvider.js');
const { runV2Search } = await import('../../server/search/searchOrchestrator.js');
const { evaluateRelevance } = await import('../../server/search/relevance.js');
import type { JobSearchParams, JobSearchProvider } from '../../server/providers/types.js';

const USER = 'lvash-user';
const H = 3600e3;
const now = Date.now();
const iso = (hAgo: number) => new Date(now - hAgo * H).toISOString();

// ── One role spec, two provider payload shapes ──
// [id, title, location, hoursAgo]
const ROLE_SPEC: [number, string, string, number][] = [
  [1, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 20],
  [2, 'Site Reliability Engineer', 'Remote - India', 72],
  [3, 'Platform Engineer', 'Bengaluru, Karnataka, India', 120],
  [4, 'Data Engineer', 'San Francisco, CA, USA', 48],
  [5, 'Account Executive', 'Mumbai, India', 24],
  [6, 'Credit Operations Analyst', 'Bengaluru, Karnataka, India', 96],
  [7, 'Product Manager', 'Delhi, India', 48],
  [999, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 20], // dup across boards A/B
  [9, 'Senior Data Engineer', 'Bengaluru, Karnataka, India', 120],
  [10, 'DevOps Engineer', 'Bengaluru, Karnataka, India', 1080], // 45d — only "any"
  [11, 'Senior DevOps Engineer', 'Hyderabad, India', 48],
  [12, 'Machine Learning Engineer', 'Pune, India', 24],
  [13, 'Frontend Engineer', 'Bengaluru, Karnataka, India', 24],
  [14, 'Cyber Security Engineer', 'Mumbai, India', 24],
  [15, 'Software Engineer', 'Bengaluru, Karnataka, India', 24],
  [16, 'Blockchain Engineer', 'Bengaluru, Karnataka, India', 48],
  [17, 'Sales Engineer', 'Delhi, India', 24],
  [19, 'Data Entry', 'Pune, India', 24],
  [21, 'Security Engineer', 'Bengaluru, Karnataka, India', 24],
  [22, 'React Engineer', 'Bengaluru, Karnataka, India', 72],
  [23, 'ML Engineer', 'Bengaluru, Karnataka, India', 96],
  [24, 'Backend Engineer', 'Hyderabad, India', 24],
  [25, 'Data Platform Engineer', 'Pune, India', 144],
  [26, 'Kubernetes Engineer', 'Bengaluru, Karnataka, India', 144],
  [27, 'Cloud Security Engineer', 'Remote - India', 48],
  [28, 'Applied ML Engineer', 'Remote - India', 48],
  [29, 'Data Engineer', 'Chennai, India', 48],
  [30, 'QA Engineer', 'Bengaluru, Karnataka, India', 24],
  [31, 'iOS Engineer', 'Mumbai, India', 48],
  [32, 'Network Engineer', 'Delhi, India', 72],
  [33, 'Solutions Architect', 'Bengaluru, Karnataka, India', 24],
  [34, 'Technical Support Engineer', 'Pune, India', 48],
  [35, 'Engineering Manager', 'Bengaluru, Karnataka, India', 72],
  [36, 'Site Reliability Engineer', 'Bengaluru, Karnataka, India', 600], // 25d
];

const A: number[] = [1, 2, 3, 4, 5, 6, 7, 999, 9, 10];
const B: number[] = [11, 12, 13, 14, 15, 16, 17, 19, 999];
const C: number[] = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
const byIds = (ids: number[]) => ids.map((id) => ROLE_SPEC.find((r) => r[0] === id)!).filter(Boolean);

// Lever payload shape (postings API: createdAt is a ms epoch).
const leverPayload = ([id, title, loc, h]: [number, string, string, number]) => ({
  id: String(id),
  text: title,
  hostedUrl: `https://jobs.lever.co/fx/${id}`,
  applyUrl: `https://jobs.lever.co/fx/${id}`,
  createdAt: now - h * H,
  categories: { location: loc, allLocations: [{ location: loc }], team: 'Engineering', commitment: 'Full-time' },
  workplaceType: /remote/i.test(loc) ? 'Remote' : 'On-site',
  descriptionPlain: `Role: ${title}`,
  description: `<p>${title}</p>`,
});

// Ashby payload shape (job-board API: publishedAt ISO, applyUrl/jobUrl).
const ashbyPayload = ([id, title, loc, h]: [number, string, string, number]) => ({
  id: String(id),
  title,
  applyUrl: `https://jobs.ashbyhq.com/fx/${id}`,
  jobUrl: `https://jobs.ashbyhq.com/fx/${id}`,
  publishedAt: iso(h),
  location: loc,
  secondaryLocations: [],
  department: { name: 'Engineering' },
  employmentType: 'Full-time',
  isRemote: /remote/i.test(loc),
  descriptionHtml: `<p>${title}</p>`,
  descriptionPlain: title,
});

const LEVER_BOARDS = { 'lev-a': byIds(A).map(leverPayload), 'lev-b': byIds(B).map(leverPayload), 'lev-c': byIds(C).map(leverPayload) };
const ASHBY_BOARDS = { 'ash-a': byIds(A).map(ashbyPayload), 'ash-b': byIds(B).map(ashbyPayload), 'ash-c': byIds(C).map(ashbyPayload) };

let fetchCount = 0;
function installFetcher() {
  fetchCount = 0;
  setDirectAtsFetcher(async (url: string) => {
    fetchCount++;
    if (url.includes('api.lever.co')) {
      const m = url.match(/postings\/([^/?]+)/);
      return LEVER_BOARDS[m ? m[1] : ''] || [];
    }
    const m = url.match(/job-board\/([^/]+)/);
    return { jobs: ASHBY_BOARDS[m ? m[1] : ''] || [] };
  });
}
installFetcher();

interface ProviderCfg {
  label: string;
  platform: string;
  provider: JobSearchProvider;
  fpPrefix: string;
  boards: number; // seeded boards for this provider
  semantics: 'created' | 'published';
}

const CFGS: ProviderCfg[] = [
  { label: 'Lever', platform: 'lever', provider: leverProvider, fpPrefix: 'lev-', boards: 3, semantics: 'created' },
  { label: 'Ashby', platform: 'ashby', provider: ashbyProvider, fpPrefix: 'ash-', boards: 3, semantics: 'published' },
];

function search(cfg: ProviderCfg, over: Partial<JobSearchParams> = {}) {
  return runV2Search(
    USER,
    { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: cfg.label, ...over },
    [cfg.provider]
  );
}

const titles = (r: { jobs: { title: string }[] }) => r.jobs.map((j) => j.title);
const fps = (r: { jobs: { fingerprint: string }[] }) => r.jobs.map((j) => j.fingerprint);

const REJECTS = ['Account Executive', 'Product Manager', 'Sales Engineer', 'Data Entry', 'Credit Operations Analyst'];

describe('Lever + Ashby provider parity', () => {
  beforeAll(() => {
    ensureV2Tables();
    installFetcher();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'LVAsh', 'lvash@test.local');
    const boardInsert = db.prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    );
    for (const slug of Object.keys(LEVER_BOARDS)) boardInsert.run(`sb-${slug}`, `Lev ${slug}`, `https://jobs.lever.co/${slug}`, 'lever', iso(30 * 24), iso(30 * 24));
    for (const slug of Object.keys(ASHBY_BOARDS)) boardInsert.run(`sb-${slug}`, `Ash ${slug}`, `https://jobs.ashbyhq.com/${slug}`, 'ashby', iso(30 * 24), iso(30 * 24));
  });
  afterAll(() => {
    setDirectAtsFetcher(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const cfg of CFGS) {
    describe(`${cfg.label} — neutral provider`, () => {
      it('retrieves + normalizes mixed roles UNFILTERED (neutrality)', async () => {
        const raw = await cfg.provider.search({ keywords: 'DevOps Engineer', source: cfg.label, limit: 10 } as any, 50);
        const t = raw.jobs.map((j) => j.title);
        for (const noise of REJECTS) expect(t).toContain(noise);
        // Date semantics: Lever createdAt → 'created', Ashby publishedAt → 'published'.
        const d1 = raw.jobs.find((j) => j.fingerprint === `${cfg.fpPrefix}1`);
        expect(d1?.postedDateSemantics).toBe(cfg.semantics);
        expect(d1?.postedDate).toBe(cfg.semantics === 'created' ? new Date(now - 20 * H).toISOString() : iso(20));
        expect(raw.jobs.find((j) => j.fingerprint === `${cfg.fpPrefix}999`)?.postedDateSemantics).toBe(cfg.semantics);
      });

      it('pipeline drops every score-0 candidate — never reaches output', async () => {
        for (const q of ['DevOps Engineer', 'Data Engineer', 'Software Engineer', 'Frontend Engineer', 'Cyber Security Engineer', 'Machine Learning Engineer', 'Blockchain Engineer']) {
          const r = await search(cfg, { keywords: q, limit: 50, postedWindow: 'any' });
          for (const j of r.jobs) {
            expect(evaluateRelevance(q, `${j.title} ${j.company}`).relevanceScore).toBeGreaterThan(0);
          }
        }
      });
    });

    describe(`${cfg.label} — 7-query acceptance matrix (India, 7d)`, () => {
      it('DevOps Engineer: exact + related survive, unrelated rejected', async () => {
        const t = titles(await search(cfg, { keywords: 'DevOps Engineer' }));
        for (const ok of ['DevOps Engineer', 'Senior DevOps Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Kubernetes Engineer', 'Cloud Security Engineer']) expect(t).toContain(ok);
        for (const no of [...REJECTS, 'Data Engineer', 'Senior Data Engineer', 'Machine Learning Engineer', 'Frontend Engineer', 'Backend Engineer', 'Security Engineer', 'React Engineer', 'ML Engineer', 'Applied ML Engineer', 'Blockchain Engineer', 'QA Engineer', 'iOS Engineer', 'Network Engineer', 'Solutions Architect', 'Technical Support Engineer', 'Engineering Manager']) expect(t).not.toContain(no);
      });
      it('Data Engineer: accepts data roles, rejects unrelated', async () => {
        const t = titles(await search(cfg, { keywords: 'Data Engineer' }));
        for (const ok of ['Data Engineer', 'Senior Data Engineer', 'Data Platform Engineer']) expect(t).toContain(ok);
        for (const no of ['DevOps Engineer', 'Frontend Engineer', ...REJECTS]) expect(t).not.toContain(no);
      });
      it('Software Engineer: exact survives, noise rejected', async () => {
        const t = titles(await search(cfg, { keywords: 'Software Engineer' }));
        expect(t).toContain('Software Engineer');
        for (const no of [...REJECTS, 'Frontend Engineer', 'Backend Engineer', 'Blockchain Engineer']) expect(t).not.toContain(no);
      });
      it('Frontend Engineer: accepts frontend family', async () => {
        const t = titles(await search(cfg, { keywords: 'Frontend Engineer' }));
        for (const ok of ['Frontend Engineer', 'React Engineer']) expect(t).toContain(ok);
        for (const no of ['Backend Engineer', 'Data Engineer', ...REJECTS]) expect(t).not.toContain(no);
      });
      it('Cyber Security Engineer: accepts security family', async () => {
        const t = titles(await search(cfg, { keywords: 'Cyber Security Engineer' }));
        for (const ok of ['Cyber Security Engineer', 'Security Engineer', 'Cloud Security Engineer']) expect(t).toContain(ok);
        for (const no of ['Software Engineer', 'Sales Engineer', ...REJECTS]) expect(t).not.toContain(no);
      });
      it('Machine Learning Engineer: accepts ML family', async () => {
        const t = titles(await search(cfg, { keywords: 'Machine Learning Engineer' }));
        for (const ok of ['Machine Learning Engineer', 'ML Engineer', 'Applied ML Engineer']) expect(t).toContain(ok);
        for (const no of ['Data Entry', 'Account Executive', 'Frontend Engineer', 'Software Engineer']) expect(t).not.toContain(no);
      });
      it('Blockchain Engineer (unknown role): generic matching works', async () => {
        const t = titles(await search(cfg, { keywords: 'Blockchain Engineer' }));
        expect(t).toContain('Blockchain Engineer');
        for (const no of ['Backend Engineer', 'Sales Engineer', 'Product Manager']) expect(t).not.toContain(no);
      });
    });

    describe(`${cfg.label} — constraints`, () => {
      it('location honored: India includes Chennai, excludes SF; USA the reverse', async () => {
        const fpIn = fps(await search(cfg, { keywords: 'Data Engineer' }));
        expect(fpIn).toContain(`${cfg.fpPrefix}29`);
        expect(fpIn).not.toContain(`${cfg.fpPrefix}4`);
        const fpUsa = fps(await search(cfg, { keywords: 'Data Engineer', location: 'USA' }));
        expect(fpUsa).toContain(`${cfg.fpPrefix}4`);
        expect(fpUsa).not.toContain(`${cfg.fpPrefix}29`);
      });
      it('date window honored: 24h / 7d / 30d / any', async () => {
        const r24 = await search(cfg, { keywords: 'DevOps Engineer', postedWindow: '24h', limit: 50 });
        const fp24 = fps(r24);
        expect(fp24).toContain(`${cfg.fpPrefix}1`);
        expect(fp24).not.toContain(`${cfg.fpPrefix}11`); // 48h
        expect(fp24).not.toContain(`${cfg.fpPrefix}3`); // 120h
        const fp7 = fps(await search(cfg, { keywords: 'DevOps Engineer', postedWindow: '7d', limit: 50 }));
        expect(fp7).toContain(`${cfg.fpPrefix}3`);
        expect(fp7).not.toContain(`${cfg.fpPrefix}36`); // 25d
        const fp30 = fps(await search(cfg, { keywords: 'DevOps Engineer', postedWindow: '30d', limit: 50 }));
        expect(fp30).toContain(`${cfg.fpPrefix}36`);
        expect(fp30).not.toContain(`${cfg.fpPrefix}10`); // 45d
        const fpAny = fps(await search(cfg, { keywords: 'DevOps Engineer', postedWindow: 'any', limit: 50 }));
        expect(fpAny).toContain(`${cfg.fpPrefix}10`);
      });
      it('LIMIT honored for 5/10/25/50, exact when fewer than LIMIT', async () => {
        for (const limit of [5, 10, 25, 50]) {
          const r = await search(cfg, { keywords: 'DevOps Engineer', limit });
          expect(r.returnedCount).toBeLessThanOrEqual(limit);
        }
        const r5 = await search(cfg, { keywords: 'DevOps Engineer', limit: 5, postedWindow: 'any' });
        expect(r5.returnedCount).toBe(5); // ≥9 survivors — never widened, never filled
      });
      it('duplicate physical job deduped across boards (same external id)', async () => {
        const fp = fps(await search(cfg, { keywords: 'DevOps Engineer', postedWindow: 'any', limit: 50 }));
        expect(fp.filter((f) => f === `${cfg.fpPrefix}999`).length).toBe(1);
      });
      it('repeat identical query uses cache, no provider call', async () => {
        const callsBefore = fetchCount;
        const r1 = await search(cfg, { keywords: 'DevOps Engineer', location: 'India', postedWindow: 'any', limit: 9 });
        expect(r1.returnedCount).toBe(9);
        const afterFirst = fetchCount;
        expect(afterFirst - callsBefore).toBeLessThanOrEqual(cfg.boards); // at most one board round
        const r2 = await search(cfg, { keywords: 'DevOps Engineer', location: 'India', postedWindow: 'any', limit: 9 });
        expect(r2.cacheHit).toBe(true);
        expect(fetchCount).toBe(afterFirst);
      });
    });
  }

  describe('cross-provider isolation', () => {
    it('Greenhouse/Lever/Ashby produce three different query fingerprints and search contexts', async () => {
      const f = (src: string) => canonicalQueryFp('DevOps Engineer', 'India', '7d', src);
      expect(new Set([f('Greenhouse'), f('Lever'), f('Ashby')]).size).toBe(3);
      const ids = await Promise.all(CFGS.map((cfg) => search(cfg, { keywords: 'DevOps Engineer' }).then((r) => r.searchId)));
      const ghId = await runV2Search(
        USER,
        { keywords: 'DevOps Engineer', location: 'India', postedWindow: '7d', jobType: 'all', workMode: 'all', level: 'any', limit: 10, source: 'Greenhouse' },
        [greenhouseProvider]
      ).then((r) => r.searchId);
      expect(new Set([...ids, ghId]).size).toBe(3); // source-isolated search contexts
    });
    it('no cross-provider fallback: each source returns ONLY its own fingerprints', async () => {
      for (const cfg of CFGS) {
        const fp = fps(await search(cfg, { keywords: 'DevOps Engineer', postedWindow: 'any', limit: 50 }));
        for (const f of fp) expect(f.startsWith(cfg.fpPrefix)).toBe(true);
      }
    });
    it('DevOps results never leak into Data results (both providers)', async () => {
      for (const cfg of CFGS) {
        const a = titles(await search(cfg, { keywords: 'DevOps Engineer' }));
        const b = titles(await search(cfg, { keywords: 'Data Engineer' }));
        expect(a).not.toContain('Data Engineer');
        expect(b).not.toContain('DevOps Engineer');
      }
    });
    it('greenhouse provider still yields its own fingerprints in the same suite', async () => {
      // Sanity: the shared fetcher also serves Greenhouse-shaped payloads —
      // no cross-wiring between provider implementations.
      const db = getDb();
      const ins = db.prepare(
        `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
         VALUES (?, ?, ?, 'greenhouse', 1, ?, ?)`
      );
      ins.run('sb-gh-a', 'GH A', 'https://boards.greenhouse.io/gh-a', iso(30 * 24), iso(30 * 24));
      setDirectAtsFetcher(async (url: string) => {
        fetchCount++;
        if (url.includes('api.lever.co')) {
          const m = url.match(/postings\/([^/?]+)/);
          return LEVER_BOARDS[m ? m[1] : ''] || [];
        }
        if (url.includes('api.ashbyhq.com')) {
          const m = url.match(/job-board\/([^/]+)/);
          return { jobs: ASHBY_BOARDS[m ? m[1] : ''] || [] };
        }
        // Greenhouse-shaped fixture: reuse the same role spec.
        const m = url.match(/boards\/([^/]+)\/jobs/);
        if (!m || m[1] !== 'gh-a') return { jobs: [] };
        const ghPayload = ([id, title, loc, h]: [number, string, string, number]) => ({
          id: String(id),
          title,
          location: { name: loc },
          absolute_url: `https://boards.greenhouse.io/gh-a/jobs/${id}`,
          first_published: iso(h),
          updated_at: iso(h),
          company_name: 'GH A',
        });
        return { jobs: byIds([1, 11, 5, 7]).map(ghPayload) };
      });
      const r = await search({ label: 'Greenhouse', platform: 'greenhouse', provider: greenhouseProvider, fpPrefix: 'gh-', boards: 1, semantics: 'published' }, { keywords: 'DevOps Engineer' });
      const fp = fps(r);
      expect(fp.every((f) => f.startsWith('gh-'))).toBe(true);
      expect(fp).toContain('gh-1');
    });
  });
});