// Jobs-list cover-letter filter — presence/verification semantics used by the
// homepage badge + filter. Pure storage behavior, temp DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-cover-filter-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveNewJobs, queryJobs } = await import('../../server/storage/fileStorage.js');

const USER = 'cover-filter-user';

function job(id: string, letter?: { text: string; verified: boolean }) {
  return {
    id,
    title: `DevOps Engineer ${id}`,
    company: 'Acme',
    location: 'Remote',
    source: 'Greenhouse',
    description: 'devops',
    url: `https://example.test/${id}`,
    state: 'tailored',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(letter ? { coverLetter: { ...letter, generatedAt: new Date().toISOString() } } : {}),
  } as any;
}

const ids = (res: ReturnType<typeof queryJobs>) => res.jobs.map((j: any) => j.id).sort();

describe('jobs list — cover-letter filter', () => {
  beforeAll(async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Cover', 'c@t.local');
    await runWithUser(USER, async () => {
      saveNewJobs([
        job('none'),
        job('verified', { text: 'Dear Hiring Team, verified.', verified: true }),
        job('unverified', { text: 'Dear Hiring Team, draft.', verified: false }),
      ]);
    });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('has → every job carrying letter text (either state)', async () => {
    const res = await runWithUser(USER, async () => queryJobs({ state: 'all', limit: 50, coverLetterFilter: 'has' }));
    expect(ids(res)).toEqual(['unverified', 'verified']);
  });

  it('verified → only verified letters', async () => {
    const res = await runWithUser(USER, async () => queryJobs({ state: 'all', limit: 50, coverLetterFilter: 'verified' }));
    expect(ids(res)).toEqual(['verified']);
  });

  it('unverified → only drafts that still need review', async () => {
    const res = await runWithUser(USER, async () => queryJobs({ state: 'all', limit: 50, coverLetterFilter: 'unverified' }));
    expect(ids(res)).toEqual(['unverified']);
  });

  it('all → no cover-letter constraint', async () => {
    const res = await runWithUser(USER, async () => queryJobs({ state: 'all', limit: 50, coverLetterFilter: 'all' }));
    expect(ids(res)).toEqual(['none', 'unverified', 'verified']);
  });
});
