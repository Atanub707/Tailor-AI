import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated temp data dir — never touches the live container DB.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-search-test-'));
process.env.TAILOR_DATA_DIR = tmpDir;

import { getDb, runWithUser, createUser, saveNewJobs, queryJobs } from '../../server/storage/fileStorage.js';
import { ensureV2Tables, getOrCreateSearch, linkJobsToSearch, getJobIdsForSearch, canonicalQueryFp } from '../../server/storage/v2Tables.js';

const USER = 'search-test-user';

const devopsJob = { id: 'devops-1', title: 'DevOps Engineer', company: 'Stripe', url: 'https://boards.greenhouse.io/stripe/1', applyUrl: 'https://boards.greenhouse.io/stripe/1', atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending' };
const aiJob = { id: 'ai-1', title: 'AI Engineer', company: 'OpenAI', url: 'https://jobs.ashbyhq.com/openai/1', applyUrl: 'https://jobs.ashbyhq.com/openai/1', atsPlatform: 'ashby', source: 'Ashby', location: 'Remote', description: 'ai', state: 'pending' };

describe('search-context isolation', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'SearchTest', 'search@test.local');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('canonicalQueryFp distinguishes contexts', () => {
    expect(canonicalQueryFp('DevOps Engineer', 'India', '24h')).not.toBe(canonicalQueryFp('AI Engineer', 'India', '24h'));
    expect(canonicalQueryFp('DevOps Engineer', 'India', '24h')).toBe(canonicalQueryFp('devops engineer', 'india', '24h'));
  });

  it('devops search then ai search: ai view must not show devops-only jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([{ ...devopsJob } as any, { ...aiJob } as any]);
      const devopsSearch = getOrCreateSearch(USER, 'DevOps Engineer', 'India', '24h');
      const aiSearch = getOrCreateSearch(USER, 'AI Engineer', 'India', '7d');
      linkJobsToSearch(devopsSearch, ['devops-1']);
      linkJobsToSearch(aiSearch, ['ai-1']);

      const aiIds = getJobIdsForSearch(USER, aiSearch);
      const aiView = queryJobs({ searchId: aiSearch, jobIds: aiIds });
      const aiTitles = aiView.jobs.map((j: any) => j.title);
      expect(aiTitles).toContain('AI Engineer');
      expect(aiTitles).not.toContain('DevOps Engineer');
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
      const db = getDb();
      const rowCount = (db.prepare('SELECT count(*) c FROM jobs WHERE id = ?').get('shared-1') as any).c;
      const linkCount = (db.prepare('SELECT count(*) c FROM search_jobs WHERE job_id = ?').get('shared-1') as any).c;
      expect(rowCount).toBe(1);
      expect(linkCount).toBe(2);
    });
  });

  it('applied job remains in Applied globally (state tab not search-scoped)', async () => {
    await runWithUser(USER, async () => {
      const db = getDb();
      const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get('ai-1') as any;
      const j = JSON.parse(row.data);
      j.state = 'applied';
      db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(j), 'ai-1');
      const applied = queryJobs({ state: 'applied' });
      expect(applied.jobs.map((x: any) => x.title)).toContain('AI Engineer');
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