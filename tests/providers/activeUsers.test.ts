import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-active-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, saveNewJobs, listActiveUsers, listUsers } = await import('../../server/storage/fileStorage.js');

const DAY = 24 * 60 * 60 * 1000;
const mk = (id: string) => ({
  id, title: `DevOps Engineer ${id}`, company: 'Stripe',
  url: `https://boards.greenhouse.io/stripe/${id}`, applyUrl: `https://boards.greenhouse.io/stripe/${id}`,
  atsPlatform: 'greenhouse', source: 'Greenhouse', location: 'Remote', description: 'devops', state: 'pending',
} as any);

describe('listActiveUsers — watcher refresh scope', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run('active-jobs', 'HasJobs', 'a@t.local');
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run('active-session', 'HasSession', 'b@t.local');
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run('dormant', 'Dormant', 'c@t.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('includes users with stored jobs', async () => {
    await runWithUser('active-jobs', async () => {
      saveNewJobs([mk('a')]);
    });
    const active = listActiveUsers(30);
    expect(active.map((u) => u.id)).toContain('active-jobs');
  });

  it('includes users with a recent session', () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run('tok-active', 'active-session', new Date(Date.now() - 1 * DAY).toISOString());
    const active = listActiveUsers(30);
    expect(active.map((u) => u.id)).toContain('active-session');
  });

  it('excludes dormant users (no jobs, no recent session)', () => {
    const active = listActiveUsers(30);
    expect(active.map((u) => u.id)).not.toContain('dormant');
  });

  it('excludes users with only stale sessions older than the window', () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run('tok-stale', 'dormant', new Date(Date.now() - 60 * DAY).toISOString());
    const active = listActiveUsers(30);
    expect(active.map((u) => u.id)).not.toContain('dormant');
  });

  it('listUsers (all) still returns every user — watcher callers keep a complete view', () => {
    const all = listUsers();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});