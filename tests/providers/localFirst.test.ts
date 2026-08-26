import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-localfirst-'));
process.env.TAILOR_DATA_DIR = tmpDir;

// Vitest hoists static imports above the TAILOR_DATA_DIR assignment, so the
// storage module would be evaluated against the REAL data dir. Dynamic
// import after the env var is set keeps this test hermetic (Task 1 pattern).
const { getDb, runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');

const USER = 'localfirst-user';
const mk = (id: string, opts: { isActive?: boolean; state?: string } = {}) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops',
  state: opts.state || 'pending',
  isActive: opts.isActive !== false,
} as any);

describe('local-first default view', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'LocalFirst', 'lf@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('default view hides inactive jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('active'), mk('inactive', { isActive: false })]);
      const all = queryJobs({});
      const titles = all.jobs.map((j: any) => j.title);
      expect(titles).toContain('DevOps Engineer active');
      expect(titles).not.toContain('DevOps Engineer inactive');
    });
  });

  it('applied tab still shows inactive applied jobs', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('applied-inactive', { isActive: false, state: 'applied' })]);
      const applied = queryJobs({ state: 'applied' });
      expect(applied.jobs.some((j: any) => j.title === 'DevOps Engineer applied-inactive')).toBe(true);
    });
  });
});
