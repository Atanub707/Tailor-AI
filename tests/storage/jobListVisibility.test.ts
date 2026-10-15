// REGRESSION: "search found jobs but they don't appear in the list."
// The list sorts by createdAt DESC; a persisted job WITHOUT createdAt sorted
// to the very last page (real bug: RemoteJobs mapper omitted it) — searches
// looked like they found nothing. saveNewJobs must fill both timestamps so
// any scraper (even one that forgets) produces a visible row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-visibility-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
import type { Job } from '../../src/types.js';

const USER = 'visibility-user';

describe('job list visibility (createdAt default)', () => {
  beforeAll(() => {
    ensureV2Tables();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'V', 'v@test.local');
    });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('a scraped job persisted WITHOUT createdAt still lands on the first page (newest sort)', () => {
    runWithUser(USER, () => {
      const job = {
        id: 'novis-1',
        title: 'DevOps Engineer',
        company: 'Board Co',
        location: 'Remote',
        source: 'Jobicy',
        description: 'x',
        url: 'https://example.com/jobicy-1',
        state: 'pending',
        // NOTE: createdAt / updatedAt deliberately missing — the real bug.
      } as unknown as Job;
      const { added } = saveNewJobs([job]);
      expect(added).toHaveLength(1);
      expect(added[0].createdAt).toBeTruthy();

      const page = queryJobs({ state: 'all', source: 'all', sortBy: 'createdAt', sortOrder: 'desc', page: 1, limit: 10 } as any);
      expect(page.jobs[0]?.id).toBe('novis-1');
      expect(page.total).toBe(1);
    });
  });
});
