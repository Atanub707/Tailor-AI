import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-search-test-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, saveNewJobs, queryJobs } from '../../server/storage/fileStorage.js';
import { ensureV2Tables, getOrCreateSearch, linkJobsToSearch, replaceJobsForSearch, getJobIdsForSearch, canonicalQueryFp } from '../../server/storage/v2Tables.js';

const USER = 'search-test-user';
const devopsJob = { id: 'devops-1', title: 'DevOps Engineer', company: 'Stripe', url: 'https://boards.greenhouse.io/stripe/1', applyUrl: 'https://boards.greenhouse.io/stripe/1', atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending' };
const aiJob = { id: 'ai-1', title: 'AI Engineer', company: 'OpenAI', url: 'https://jobs.ashbyhq.com/openai/1', applyUrl: 'https://jobs.ashbyhq.com/openai/1', atsPlatform: 'ashby', source: 'Ashby', location: 'Remote', description: 'ai', state: 'pending' };

describe('search-context isolation', () => {
  beforeAll(() => {
    ensureV2Tables();
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'SearchTest', 'search@test.local');
  });

  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('canonicalQueryFp distinguishes contexts', () => {
    expect(canonicalQueryFp('DevOps Engineer', 'India', '24h')).not.toBe(canonicalQueryFp('AI Engineer', 'India', '24h'));
    expect(canonicalQueryFp('DevOps Engineer', 'India', '24h')).toBe(canonicalQueryFp('devops engineer', 'india', '24h'));
  });

  it('distinguishes otherwise-identical contexts by source and filters', () => {
    const glassdoor = canonicalQueryFp('DevOps Engineer', 'India', '24h', '{"sources":["Glassdoor"],"jobType":"remote"}');
    const greenhouse = canonicalQueryFp('DevOps Engineer', 'India', '24h', '{"sources":["Greenhouse"],"jobType":"remote"}');
    expect(glassdoor).not.toBe(greenhouse);
  });

  it('devops search then ai search: ai view must not show devops-only jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([{ ...devopsJob } as any, { ...aiJob } as any]);
      const devopsSearch = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '24h');
      const aiSearch = getOrCreateSearch(USER, 'AI Engineer', 'India', '7d');
      linkJobsToSearch(devopsSearch, ['devops-1']);
      linkJobsToSearch(aiSearch, ['ai-1']);
      const aiView = queryJobs({ searchId: aiSearch, jobIds: getJobIdsForSearch(USER, aiSearch) });
      expect(aiView.jobs.map((j: any) => j.title)).toContain('AI Engineer');
      expect(aiView.jobs.map((j: any) => j.title)).not.toContain('DevOps Engineer');
    });
  });

  it('same physical job can belong to two searches (one job row, two links)', async () => {
    await runWithUser(USER, async () => {
      const sharedJob = { ...devopsJob, id: 'shared-1', url: 'https://boards.greenhouse.io/stripe/shared', applyUrl: 'https://boards.greenhouse.io/stripe/shared' };
      saveNewJobs([sharedJob as any]);
      const s1 = getOrCreateSearch(USER, 'DevOps Engineer', '', 'all');
      const s2 = getOrCreateSearch(USER, 'Platform Engineer', '', 'all');
      linkJobsToSearch(s1, ['shared-1']);
      linkJobsToSearch(s2, ['shared-1']);
      expect((getDb().prepare('SELECT count(*) c FROM jobs WHERE id = ?').get('shared-1') as any).c).toBe(1);
      expect((getDb().prepare('SELECT count(*) c FROM search_jobs WHERE job_id = ?').get('shared-1') as any).c).toBe(2);
    });
  });

  it('replaces stale links when the same filtered search is rerun', () => {
    const searchId = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '24h', 'glassdoor|remote|25');
    replaceJobsForSearch(searchId, ['devops-1', 'shared-1']);
    replaceJobsForSearch(searchId, ['devops-1']);
    expect(getJobIdsForSearch(USER, searchId)).toEqual(['devops-1']);
    replaceJobsForSearch(searchId, []);
    expect(getJobIdsForSearch(USER, searchId)).toEqual([]);
  });

  it('applied job remains in Applied globally (state tab not search-scoped)', async () => {
    await runWithUser(USER, async () => {
      const db = getDb();
      const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get('ai-1') as any;
      const j = JSON.parse(row.data);
      j.state = 'applied';
      db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(j), 'ai-1');
      expect(queryJobs({ state: 'applied' }).jobs.map((x: any) => x.title)).toContain('AI Engineer');
    });
  });

  it('GET /api/jobs without searchId behaves exactly as today (all jobs)', async () => {
    await runWithUser(USER, async () => {
      const all = queryJobs({});
      expect(all.jobs.some((j: any) => j.title === 'DevOps Engineer')).toBe(true);
      expect(all.jobs.some((j: any) => j.title === 'AI Engineer')).toBe(true);
    });
  });
});
