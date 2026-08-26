import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-lifecycle-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveNewJobs, getAllJobs, updateJobInStorage } = await import('../../server/storage/fileStorage.js');

const USER = 'lifecycle-user';
const job = (id: string) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
});

describe('job lifecycle fields', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Lifecycle', 'life@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('saveNewJobs stamps firstSeenAt, lastSeenAt, isActive=true', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([job('a') as any]);
      const saved = getAllJobs();
      expect(saved.length).toBe(1);
      expect(saved[0].firstSeenAt).toBeTruthy();
      expect(saved[0].lastSeenAt).toBe(saved[0].firstSeenAt);
      expect(saved[0].isActive).toBe(true);
    });
  });

  it('duplicate save does not overwrite firstSeenAt', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([job('a') as any]);
      const first = getAllJobs()[0].firstSeenAt;
      await new Promise((r) => setTimeout(r, 5));
      saveNewJobs([job('a') as any]);
      expect(getAllJobs()[0].firstSeenAt).toBe(first);
    });
  });
});