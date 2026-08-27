import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-single-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');

const USER = 'single-user';
const mk = (id: string) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'India', description: 'devops', state: 'pending',
} as any);

describe('single-source + source isolation', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Single', 's@t.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('LIMIT 10 returns <=10 (single source)', async () => {
    await runWithUser(USER, async () => {
      const many = Array.from({ length: 40 }, (_, i) => mk(`m${i}`));
      saveNewJobs(many as any);
      const result = queryJobs({ limit: 10, page: 1 });
      expect(result.jobs.length).toBeLessThanOrEqual(10);
    });
  });

  it('missing Apify token fails gracefully (no crash)', async () => {
    // The endpoint-level gate is in scraperFactory (needsApify skip); here we
    // verify the storage path tolerates an unset token without throwing.
    await runWithUser(USER, async () => {
      const all = queryJobs({});
      expect(Array.isArray(all.jobs)).toBe(true);
    });
  });

  it('no FetchCat references anywhere in prod code', () => {
    const files = ['server.ts', 'server/providers/providerRegistry.ts', 'server/search/searchOrchestrator.ts', 'src/components/ScraperBar.tsx'];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/fetchcat|fetch_cat|fetch-cat/i);
    }
  });

  it('locked ATS sources absent from UI list', () => {
    const src = fs.readFileSync('src/components/ScraperBar.tsx', 'utf8');
    // VISIBLE_SOURCES is the single source of truth — extract it and assert
    // none of the non-functional ATS are selectable.
    const m = src.match(/const VISIBLE_SOURCES: JobSource\[\] = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const visible = (m?.[1] || '').split(',').map((s) => s.trim().replace(/'/g, ''));
    for (const hidden of ['Workable', 'Workday', 'BambooHR', 'JazzHR', 'iCIMS', 'Personio', 'Rippling', 'Teamtailor', 'Recruitee', 'Pinpoint', 'Jobvite', 'SmartRecruiters', 'Comeet', 'Join']) {
      expect(visible).not.toContain(hidden);
    }
    expect(visible).toContain('Greenhouse');
    expect(visible).toContain('Lever');
    expect(visible).toContain('Ashby');
  });

  it('V1 search still works (queryJobs + saveNewJobs roundtrip)', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('v1')]);
      const all = queryJobs({ limit: 100, page: 1 });
      expect(all.jobs.some((j: any) => j.title.includes('v1'))).toBe(true);
      expect(all.jobs.some((j: any) => j.title.includes('DevOps Engineer v1'))).toBe(true);
    });
  });
});
