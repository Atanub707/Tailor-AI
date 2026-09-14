// "N new models" badge — per-user seen-vs-new diff semantics.
// The badge must be honest: a first run baselines silently (everything is
// "new" to a brand-new user, which is meaningless noise), later arrivals
// are reported, and viewing the list clears them.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-seen-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureModelSeenSchema, unseenModelIds, markModelsSeen } = await import('../../server/storage/modelCatalogSeen.js');

const U1 = 'seen-user-1';
const U2 = 'seen-user-2';

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('model catalog seen store', () => {
  it('first run baselines silently — no "37 new models" for a new user', () => {
    const db = getDb();
    ensureModelSeenSchema(db);
    db.prepare('DELETE FROM model_catalog_seen').run();
    expect(unseenModelIds(db, U1, ['a', 'b', 'c'])).toEqual([]);
    expect(unseenModelIds(db, U1, ['a', 'b', 'c'])).toEqual([]); // idempotent
  });

  it('reports ids that appeared since the last look', () => {
    const db = getDb();
    expect(unseenModelIds(db, U1, ['a', 'b', 'c', 'd', 'e'])).toEqual(['d', 'e']);
  });

  it('acknowledging clears the diff', () => {
    const db = getDb();
    markModelsSeen(db, U1, ['d', 'e']);
    expect(unseenModelIds(db, U1, ['a', 'b', 'c', 'd', 'e'])).toEqual([]);
  });

  it('markModelsSeen is idempotent (INSERT OR IGNORE)', () => {
    const db = getDb();
    expect(markModelsSeen(db, U1, ['a'])).toBe(0); // already seen
    expect(markModelsSeen(db, U1, ['z'])).toBe(1);
    expect(markModelsSeen(db, U1, ['z'])).toBe(0);
  });

  it('users are isolated — a baseline of one user never hides another user new models', () => {
    const db = getDb();
    // U2 first run baselines with what THEY see today.
    expect(unseenModelIds(db, U2, ['a'])).toEqual([]);
    // A model U1 already acked is genuinely new to U2.
    expect(unseenModelIds(db, U2, ['a', 'b'])).toEqual(['b']);
    // And U1 is unaffected by U2's baseline.
    expect(unseenModelIds(db, U1, ['a', 'b', 'c', 'd', 'e', 'z'])).toEqual([]);
  });
});

describe('wiring checks', () => {
  it('server diffs the catalog per user and exposes the ack route', () => {
    const srv = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(srv).toContain('currentUserUnseenModelIds');
    expect(srv).toContain("app.post('/api/models/seen'");
    expect(srv).toContain('newModelIds');
  });

  it('Settings badge uses the seen diff (not the provider created window)', () => {
    const scr = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    expect(scr).toContain('newModelIds');
    expect(scr).toContain('ackCatalogSeen');
    expect(scr).toContain('/api/models/seen');
    expect(scr).not.toContain('45 * 24 * 3600 * 1000');
  });
});
