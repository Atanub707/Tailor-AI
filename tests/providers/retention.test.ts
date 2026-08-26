import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-retention-'));
process.env.TAILOR_DATA_DIR = tmpDir;

// Vitest hoists static imports above the TAILOR_DATA_DIR assignment, so the
// storage module would be evaluated against the REAL data dir. Dynamic
// import after the env var is set keeps this test hermetic (Task 1 pattern).
const { getDb, runWithUser, saveNewJobs, getAllJobs } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables, linkJobsToSearch, getOrCreateSearch } = await import('../../server/storage/v2Tables.js');
const { runRetentionSweep } = await import('../../server/indexer/retention.js');

const USER = 'retention-user';
const OTHER = 'retention-other';
const DAY = 24 * 60 * 60 * 1000;
const mk = (id: string, opts: { ageMs?: number; state?: string; isActive?: boolean } = {}) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops',
  state: opts.state || 'pending',
  isActive: opts.isActive !== false,
  firstSeenAt: new Date(Date.now() - (opts.ageMs ?? DAY)).toISOString(),
  lastSeenAt: new Date().toISOString(),
} as any);

describe('retention sweep — Option B', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Retention', 'ret@test.local');
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(OTHER, 'Retention Other', 'ret-other@test.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('deletes pending job older than 7 days', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('old-pending', { ageMs: 8 * DAY }), mk('fresh-pending', { ageMs: DAY })]);
      const r = await runRetentionSweep();
      expect(r.deleted).toBe(1);
      const titles = getAllJobs().map((j: any) => j.title);
      expect(titles).not.toContain('DevOps Engineer old-pending');
      expect(titles).toContain('DevOps Engineer fresh-pending');
    });
  });

  it('keeps applied/tailored/ready jobs regardless of age', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([
        mk('old-applied', { ageMs: 30 * DAY, state: 'applied' }),
        mk('old-tailored', { ageMs: 30 * DAY, state: 'tailored' }),
        mk('old-ready', { ageMs: 30 * DAY, state: 'ready' }),
      ]);
      const r = await runRetentionSweep();
      expect(r.kept).toBeGreaterThanOrEqual(3);
      const titles = getAllJobs().map((j: any) => j.title);
      for (const t of ['old-applied', 'old-tailored', 'old-ready']) {
        expect(titles).toContain(`DevOps Engineer ${t}`);
      }
    });
  });

  it('deletes inactive pending jobs immediately, keeps inactive applied', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('inactive-pending', { ageMs: DAY, isActive: false }), mk('inactive-applied', { ageMs: DAY, isActive: false, state: 'applied' })]);
      const r = await runRetentionSweep();
      const titles = getAllJobs().map((j: any) => j.title);
      expect(titles).not.toContain('DevOps Engineer inactive-pending');
      expect(titles).toContain('DevOps Engineer inactive-applied');
    });
  });

  it('cleans orphaned search_jobs rows', async () => {
    await runWithUser(USER, async () => {
      saveNewJobs([mk('orphan-target', { ageMs: 8 * DAY })]);
      const searchId = getOrCreateSearch(USER, 'DevOps Engineer', '', 'all');
      linkJobsToSearch(searchId, ['orphan-target']);
      const db = getDb();
      const before = (db.prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchId) as any).c;
      expect(before).toBe(1); // precondition: the link exists
      const r = await runRetentionSweep();
      expect(r.deleted).toBe(1); // the sweep deletes the aged job…
      const orphans = (db.prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchId) as any).c;
      expect(orphans).toBe(0); // …and its now-orphaned search_jobs link
    });
  });

  it('scopes search_jobs cleanup to the deleting user', async () => {
    let searchA: string;
    let searchB: string;
    // User A: stale job + link (should be swept away)
    await runWithUser(USER, async () => {
      saveNewJobs([mk('shared-orphan', { ageMs: 8 * DAY })]);
      searchA = getOrCreateSearch(USER, 'Shared Board Engineer', '', 'all');
      linkJobsToSearch(searchA, ['shared-orphan']);
      const beforeA = (getDb().prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchA) as any).c;
      expect(beforeA).toBe(1); // precondition: A's link exists
    });
    // User B: SAME job id but fresh (kept by the sweep) + link
    await runWithUser(OTHER, async () => {
      saveNewJobs([mk('shared-orphan', { ageMs: DAY })]);
      searchB = getOrCreateSearch(OTHER, 'Shared Board Engineer', '', 'all');
      linkJobsToSearch(searchB, ['shared-orphan']);
      const beforeB = (getDb().prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchB) as any).c;
      expect(beforeB).toBe(1); // precondition: B's link exists
    });
    const r = await runRetentionSweep();
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const aLinks = (getDb().prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchA) as any).c;
    expect(aLinks).toBe(0); // A's orphaned link is removed
    const bLinks = (getDb().prepare('SELECT count(*) c FROM search_jobs WHERE search_id = ?').get(searchB) as any).c;
    expect(bLinks).toBe(1); // B's link survives (B's job is still alive)
    const bJob = (getDb().prepare('SELECT count(*) c FROM jobs WHERE id = ? AND user_id = ?').get('shared-orphan', OTHER) as any).c;
    expect(bJob).toBe(1); // B's job row is untouched
  });
});