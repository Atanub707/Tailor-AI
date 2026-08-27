import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-promo-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { promoteCandidate } = await import('../../server/search/searchOrchestrator.js');

const USER = 'promo-user';
const cand = {
  fingerprint: 'fetchcat-xyz123', title: 'DevOps Engineer', company: 'Stripe',
  location: 'India', applyUrl: 'https://boards.greenhouse.io/stripe/xyz123',
  url: 'https://boards.greenhouse.io/stripe/xyz123', atsPlatform: 'greenhouse',
  source: 'fetchcat', postedDate: '2026-08-26T10:00:00Z', postedDateSemantics: 'published',
};

describe('promotion: cached candidate → durable job', () => {
  beforeAll(() => {
    ensureV2Tables();
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Promo', 'p@t.local');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('promoteCandidate creates a durable job preserving provenance', async () => {
    await runWithUser(USER, async () => {
      promoteCandidate(USER, cand as any);
      const db = getDb();
      const row = db.prepare('SELECT data FROM jobs WHERE user_id = ? AND id = ?').get(USER, 'fetchcat-xyz123') as any;
      expect(row).toBeTruthy();
      const j = JSON.parse(row.data);
      expect(j.source).toBe('fetchcat');
      expect(j.applyUrl).toBe(cand.applyUrl);
      expect(j.url).toBe(cand.applyUrl);
      expect(j.fingerprint).toBe('fetchcat-xyz123');
      expect(j.postedDate).toBe(cand.postedDate);
      expect(j.postedDateSemantics).toBe('published');
      expect(j.atsPlatform).toBe('greenhouse');
      expect(j.state).toBe('pending');
    });
  });

  it('promoting the same candidate again is idempotent (no duplicate)', async () => {
    await runWithUser(USER, async () => {
      promoteCandidate(USER, cand as any);
      const db = getDb();
      const c = (db.prepare('SELECT count(*) c FROM jobs WHERE user_id = ? AND id = ?').get(USER, 'fetchcat-xyz123') as any).c;
      expect(c).toBe(1);
    });
  });
});
