// Live job-title suggestions — REAL titles from the jobs corpus (user's jobs
// + the ATS index), never a hardcoded list. Pins:
//   * a role that enters the corpus LATER is suggestible immediately
//   * only TITLES are returned (never companies/skills)
//   * prefix-quality ranking (startsWith < contains < token-prefix) with
//     frequency as the tiebreak
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-suggest-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs } = await import('../../server/ats-index/atsRepository.js');
const { suggestJobTitles } = await import('../../server/search/titleSuggest.js');

const USER = 'suggest-user';

const row = (fingerprint: string, title: string, company = 'Acme', posted: string = new Date().toISOString()) => ({
  fingerprint,
  ats_platform: 'greenhouse',
  external_id: fingerprint,
  company,
  company_slug: company.toLowerCase(),
  title,
  location: 'Remote',
  employment_type: 'Full-time',
  work_mode: 'Remote',
  posted_date: posted,
  posted_date_semantics: 'published',
  apply_url: `https://x/${fingerprint}`,
  job_url: `https://x/${fingerprint}`,
  description: `Role: ${title}`,
  first_seen_at: posted,
  last_seen_at: posted,
  last_fetched_at: posted,
  is_active: 1,
});

describe('live job-title suggestions', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'S', 's@test.local');
      upsertAtsJobs([
        row('fde-1', 'Forward Deployed Engineer'),
        row('fde-2', 'Forward Deployed Engineer', 'Beta Co'),
        row('fde-3', 'Forward Deployed Engineer', 'Gamma Co'),
        row('fde-4', 'Senior Forward Deployed Engineer'),
        row('fde-5', 'Forward Deployed Software Engineer'),
        row('dvo-1', 'DevOps Engineer'),
        row('dvo-2', 'Senior DevOps Engineer'),
        row('misc-1', 'Account Executive', 'Stripe'),
      ] as any);
      // The user's own saved job (their context).
      getDb()
        .prepare('INSERT INTO jobs (id, user_id, data) VALUES (?, ?, ?)')
        .run('own-1', USER, JSON.stringify({ id: 'own-1', title: 'Staff Forward Deployed Engineer', company: 'My Co' }));
    });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('suggests REAL titles for a partial query, prefix-ranked', () => {
    const titles = suggestJobTitles(USER, 'forward deploy');
    expect(titles[0]).toBe('Forward Deployed Engineer');
    expect(titles).toContain('Senior Forward Deployed Engineer');
    expect(titles).toContain('Forward Deployed Software Engineer');
    expect(titles).toContain('Staff Forward Deployed Engineer'); // the user's own job
    expect(titles.every((t) => typeof t === 'string')).toBe(true);
  });

  it('a NEW role enters the corpus later and is suggestible immediately', () => {
    expect(suggestJobTitles(USER, 'agentic ops')).toEqual([]);
    runWithUser(USER, () => upsertAtsJobs([row('new-1', 'Agentic Ops Engineer'), row('new-2', 'Agentic Ops Engineer', 'Other')] as any));
    expect(suggestJobTitles(USER, 'agentic ops')).toContain('Agentic Ops Engineer');
  });

  it('returns TITLES only — a company-name query yields nothing', () => {
    expect(suggestJobTitles(USER, 'stripe')).toEqual([]);
  });

  it('requires 2+ characters and respects the limit', () => {
    expect(suggestJobTitles(USER, 'f')).toEqual([]);
    expect(suggestJobTitles(USER, 'engineer', 3).length).toBeLessThanOrEqual(3);
  });
});
