// JD-on-demand resolver — cached-description short-circuit, Greenhouse
// detail fetch, sanitization, validation, persistence, failure classes.
// Fixtures only (fetch is mocked); zero live calls.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-resolver-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, saveNewJobs, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs } = await import('../../server/ats-index/atsRepository.js');
const { ensureJobDescription, sanitizeDescription, isMeaningfulDescription, JDResolutionError, MIN_JD_LENGTH } = await import('../../server/tailor/jdResolver.js');
import type { Job } from '../../src/types.js';
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';

const USER = 'jd-user';

function baseJob(over: Partial<Job> = {}): Job {
  return {
    id: 'gh-12345',
    fingerprint: 'gh-12345',
    externalId: 'gh-12345',
    title: 'DevOps Engineer',
    company: 'Acme',
    companyId: 'Acme',
    location: 'Bengaluru, India',
    description: '',
    atsPlatform: 'greenhouse',
    jobUrl: 'https://boards.greenhouse.io/acme/jobs/12345',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/12345',
    url: 'https://boards.greenhouse.io/acme/jobs/12345',
    source: 'Greenhouse',
    state: 'pending',
    ...over,
  } as unknown as Job;
}

let fetchCount = 0;
function mockFetch(status: number, body: unknown) {
  (globalThis as any).fetch = async () => {
    fetchCount++;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

describe('JD resolver', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'JDUser', 'jd@test.local');
  });
  afterEach(() => {
    (globalThis as any).fetch = undefined;
    fetchCount = 0;
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('5. existing meaningful description returned WITHOUT network', async () => {
    mockFetch(500, {});
    const j = baseJob({ description: 'Full JD: Responsibilities include building pipelines. '.repeat(4) });
    const out = await ensureJobDescription(j);
    expect(out.description).toBe(j.description);
    expect(fetchCount).toBe(0);
  });

  it('6+7. missing Greenhouse description triggers ONE detail fetch and persists the JD', async () => {
    // The user acted on this job → it exists in their durable library.
    runWithUser(USER, () => { saveNewJobs([baseJob()]); });
    mockFetch(200, {
      content: '<script>evil()</script><h3>Responsibilities</h3><ul><li>Build CI/CD pipelines</li><li>Manage Kubernetes clusters</li></ul><p>Requirements: 5+ years Linux, AWS, Terraform. This is a full-time hybrid role in Bengaluru with on-call rotation and incident response duties across multiple regions.</p>',
    });
    // The index row supplies slug + external id.
    upsertAtsJobs([{
      fingerprint: 'gh-12345', ats_platform: 'greenhouse', external_id: '12345', company: 'Acme',
      company_slug: 'acme', title: 'DevOps Engineer', location: 'Bengaluru, India',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/12345', job_url: 'https://boards.greenhouse.io/acme/jobs/12345',
      description: '', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      last_fetched_at: new Date().toISOString(), is_active: 1,
    } as AtsJobRow]);
    const out = await runWithUser(USER, () => ensureJobDescription(baseJob()));
    expect(fetchCount).toBe(1);
    expect(out.description).toContain('Build CI/CD pipelines');
    expect(out.description).toContain('Kubernetes');
    // Persisted on the user's durable job record.
    const stored = getDb().prepare('SELECT data FROM jobs WHERE id = ?').get('gh-12345') as { data: string } | undefined;
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.data).description).toContain('CI/CD');
  });

  it('8. second resolution uses the cached JD — ZERO detail requests', async () => {
    mockFetch(500, {}); // would fail if called
    const job = getDb().prepare('SELECT data FROM jobs WHERE id = ?').get('gh-12345') as { data: string };
    const cached = JSON.parse(job.data) as Job;
    const out = await runWithUser(USER, () => ensureJobDescription(cached));
    expect(out.description).toContain('CI/CD');
    expect(fetchCount).toBe(0);
  });

  it('9b. entity-encoded HTML (Greenhouse detail shape) sanitized correctly', () => {
    const clean = sanitizeDescription('&lt;h3&gt;&lt;strong&gt;About Stripe&lt;/strong&gt;&lt;/h3&gt;\n&lt;p&gt;Stripe is a financial infrastructure platform for businesses. Responsibilities include building secure pipelines across multiple regions with on-call rotation and incident response duties.&lt;/p&gt;');
    expect(clean).not.toContain('&lt;');
    expect(clean).not.toContain('<h3>');
    expect(clean).toContain('About Stripe');
    expect(clean).toContain('Responsibilities');
  });

  it('9+10. HTML sanitized: scripts stripped, meaningful structure preserved', () => {
    const clean = sanitizeDescription('<script>window.x=1</script><style>p{color:red}</style><ul><li>Responsibilities</li><li>- Build pipelines</li></ul><p>&nbsp;Requirements: AWS</p>');
    expect(clean).not.toContain('window.x');
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('&nbsp;');
    expect(clean).toContain('Build pipelines');
    expect(clean).toContain('AWS');
  });

  it('11. empty JD rejected', async () => {
    mockFetch(200, { content: '' });
    await expect(ensureJobDescription(baseJob())).rejects.toThrow(JDResolutionError);
    expect(fetchCount).toBe(1);
  });

  it('12. 404 rejected', async () => {
    mockFetch(404, {});
    await expect(ensureJobDescription(baseJob({ fingerprint: 'gh-404' }))).rejects.toThrow(JDResolutionError);
  });

  it('13. timeout rejected', async () => {
    (globalThis as any).fetch = async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    };
    await expect(ensureJobDescription(baseJob({ fingerprint: 'gh-timeout' }))).rejects.toThrow(JDResolutionError);
  });

  it('14. malformed response rejected', async () => {
    mockFetch(200, { unexpected: true });
    await expect(ensureJobDescription(baseJob({ fingerprint: 'gh-malformed' }))).rejects.toThrow(JDResolutionError);
  });

  it('non-Greenhouse job without a JD is surfaced honestly, never fabricated', async () => {
    const job = baseJob({ id: 'lev-1', fingerprint: 'lev-1', externalId: 'lev-1', source: 'Lever', atsPlatform: 'lever', url: 'https://jobs.lever.co/x/1', applyUrl: 'https://jobs.lever.co/x/1' });
    await expect(ensureJobDescription(job)).rejects.toThrow(/doesn't include a usable description/);
  });

  it('meaningful-JD threshold is conservative', () => {
    expect(isMeaningfulDescription('')).toBe(false);
    expect(isMeaningfulDescription('DevOps Engineer Acme')).toBe(false);
    expect(isMeaningfulDescription('x'.repeat(MIN_JD_LENGTH))).toBe(false); // single token, no spaces
    expect(isMeaningfulDescription(('We are hiring a DevOps Engineer. '.repeat(4)))).toBe(true);
  });

  it('Greenhouse job with missing provider identity is surfaced honestly', async () => {
    const job = baseJob({ id: 'gh-noid', fingerprint: 'gh-noid', externalId: 'gh-noid', url: 'https://example.com/odd', applyUrl: 'https://example.com/odd' });
    await expect(ensureJobDescription(job)).rejects.toThrow(JDResolutionError);
  });
});