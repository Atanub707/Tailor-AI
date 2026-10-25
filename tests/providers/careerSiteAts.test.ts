// Career-site ATS sources (one Apify actor, isolated per platform) —
// input mapping, per-source isolation, row normalization, caps, icons.
// Zero live calls: config mocked, fetch stubbed, boards seeded locally.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ats-'));
process.env.TAILOR_DATA_DIR = tmpDir;

vi.mock('../../server/config.js', () => ({
  loadConfig: () => ({ apify: { enabled: true, token: 'test-token', referralUrl: '' } }),
}));

const { CareerSiteAtsScraper, CAREER_ATS_SPECS } = await import('../../server/scraper/careerSiteAtsScraper.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { getDb } = await import('../../server/storage/fileStorage.js');
const { getSourceMeta } = await import('../../src/constants/sources.js');
const { LOCAL_SOURCE_LOGOS } = await import('../../src/components/SourceIcon.js');

const ACTOR = 'memo23~career-site-ats-jobs-api';

const WORKABLE_ITEM = {
  ats: 'workable',
  org: 'acme',
  company: 'Acme',
  globalId: 'workable:acme:J1',
  title: 'Senior DevOps Engineer',
  department: 'Engineering',
  employmentType: 'Full-time',
  workplaceType: 'Hybrid',
  isRemote: false,
  location: 'London',
  locations: ['London'],
  descriptionText: 'Kubernetes, Terraform, AWS. Build and operate CI/CD platforms.',
  descriptionHtml: '<p>Kubernetes, Terraform, AWS. <strong>Build</strong> and operate CI/CD platforms.</p>',
  publishedAt: '2026-10-20T10:00:00Z',
  jobUrl: 'https://apply.workable.com/acme/j/J1/',
  applyUrl: 'https://apply.workable.com/acme/j/J1/apply',
};

let lastUrl = '';
let lastBody: any = null;
let fetchCount = 0;

function installFetch(items: any[]) {
  lastUrl = '';
  lastBody = null;
  fetchCount = 0;
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    lastUrl = String(url);
    lastBody = JSON.parse(String(init?.body || '{}'));
    fetchCount++;
    return { ok: true, status: 200, json: async () => items, text: async () => '' };
  });
}

function seedBoard(platform: string, company: string, slug: string) {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(`${platform}-${slug}`, company, `https://example.test/${platform}/${slug}`, platform, now, now);
}

const baseParams = (over: Record<string, any> = {}) => ({
  keywords: 'devops engineer',
  location: '',
  maxJobsPerSource: 6,
  datePostedFilter: '7d',
  jobType: 'all',
  ...over,
});

describe('Career-site ATS sources (memo23/career-site-ats-jobs-api)', () => {
  beforeAll(() => {
    ensureV2Tables();
    seedBoard('workable', 'Acme', 'acme');
    seedBoard('workable', 'Globex', 'globex');
    seedBoard('personio', 'Initech', 'initech');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('every wave-1 source is registered with the actor, real price, and a bundled logo', () => {
    for (const spec of CAREER_ATS_SPECS) {
      const meta = getSourceMeta(spec.source as any);
      expect(meta?.apifyActorId, spec.source).toBe(ACTOR);
      expect(meta?.needsApify, spec.source).toBe(true);
      expect(meta?.pricePer1K, spec.source).toBe('$2.50');
      const logo = LOCAL_SOURCE_LOGOS[spec.source];
      expect(logo, `${spec.source} logo`).toBeTruthy();
      expect(fs.existsSync(path.join(process.cwd(), 'public', logo.replace(/^\//, ''))), `${spec.source} logo file`).toBe(true);
    }
  });

  it('input: boards are pinned to the selected platform (never other ATS), filters + caps mapped', async () => {
    installFetch([WORKABLE_ITEM]);
    await new CareerSiteAtsScraper('Workable').scrape(baseParams({
      location: 'London', jobType: 'remote', contractType: 'Contract', maxJobsPerSource: 6,
    }) as any);

    expect(lastUrl).toContain(ACTOR.replace('~', '/').split('/')[0]); // actor endpoint
    expect(lastUrl).toContain('memo23');
    // Isolation of the BOARD FEED: only workable boards become startUrls.
    expect(Array.isArray(lastBody.startUrls)).toBe(true);
    expect(lastBody.startUrls.length).toBeGreaterThan(0);
    for (const u of lastBody.startUrls) expect(u).toContain('/workable/');
    expect(lastBody.startUrls.some((u: string) => u.includes('/personio/'))).toBe(false);
    expect(lastBody.maxItemsTotal).toBe(6);
    expect(lastBody.includeDescription).toBe(true);
    expect(lastBody.keywords).toBe('devops');
    expect(lastBody.location).toBe('London');
    expect(lastBody.remoteOnly).toBeUndefined(); // local work-mode truth decides
    expect(lastBody.employmentType).toBe('contract');
    expect(typeof lastBody.postedAfter).toBe('string');
  });

  it('isolation + mapping: only rows from the selected ATS survive; Job fields normalized', async () => {
    installFetch([
      WORKABLE_ITEM,
      { ...WORKABLE_ITEM, ats: 'personio', org: 'initech', globalId: 'personio:initech:J9', title: 'DevOps Engineer' },
      { ...WORKABLE_ITEM, ats: 'bamboohr', globalId: 'bamboohr:x:J2' },
      { ...WORKABLE_ITEM, ats: 'workable', globalId: 'workable:acme:J2', title: '', jobUrl: '' },
    ]);
    const jobs = await new CareerSiteAtsScraper('Workable').scrape(baseParams() as any);
    expect(jobs).toHaveLength(1);
    const j: any = jobs[0];
    expect(j.source).toBe('Workable');
    expect(j.atsPlatform).toBe('workable');
    expect(j.id).toBe('careerats-workable:acme:J1');
    expect(j.provider).toBe('apify');
    expect(j.workMode).toBe('Hybrid');
    expect(j.remote).toBeUndefined();
    expect(j.jobType).toContain('Full-time');
    expect(j.workplaceType).toBeUndefined();
    expect(j.description).toContain('Kubernetes, Terraform, AWS');
    expect(j.description).not.toContain('<strong>');
    expect(j.applyUrl).toBe('https://apply.workable.com/acme/j/J1/apply');
    expect(new Date(j.postedDate).getTime()).toBe(new Date('2026-10-20T10:00:00Z').getTime());
  });

  it('explicit remote rows map to Remote (never text-guessed)', async () => {
    installFetch([{ ...WORKABLE_ITEM, workplaceType: 'Remote', isRemote: true, globalId: 'workable:acme:J3' }]);
    const jobs = await new CareerSiteAtsScraper('Workable').scrape(baseParams() as any);
    expect((jobs[0] as any).workMode).toBe('Remote');
    expect((jobs[0] as any).remote).toBe(true);
  });

  it('hard cap: the per-source limit is enforced after mapping', async () => {
    installFetch(Array.from({ length: 8 }, (_, i) => ({ ...WORKABLE_ITEM, globalId: `workable:acme:J${10 + i}` })));
    const jobs = await new CareerSiteAtsScraper('Workable').scrape(baseParams({ maxJobsPerSource: 3 }) as any);
    expect(jobs).toHaveLength(3);
  });

  it('no indexed boards: honest error instead of an empty search', async () => {
    lastUrl = '';
    fetchCount = 0;
    const scraper = new CareerSiteAtsScraper('JazzHR');
    const jobs = await scraper.scrape(baseParams() as any);
    expect(jobs).toEqual([]);
    expect(scraper.lastError).toMatch(/No JazzHR boards are indexed/i);
    expect(fetchCount).toBe(0);
  });

  it('relevance guard still applies (irrelevant titles never survive)', async () => {
    installFetch([
      { ...WORKABLE_ITEM, globalId: 'workable:acme:J4' },
      { ...WORKABLE_ITEM, globalId: 'workable:acme:J5', title: 'Account Executive', descriptionText: 'Sales role.' },
    ]);
    const jobs = await new CareerSiteAtsScraper('Workable').scrape(baseParams() as any);
    expect(jobs.map((j) => j.title)).toEqual(['Senior DevOps Engineer']);
  });
});
