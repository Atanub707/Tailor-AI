// Remote Boards source (Apify actor memo23/remote-jobs-aggregator) —
// input mapping and row normalization. Zero live calls: config mocked,
// fetch stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../server/config.js', () => ({
  loadConfig: () => ({ apify: { enabled: true, token: 'test-token', referralUrl: '' } }),
}));

const { RemoteJobsAggregatorScraper } = await import('../../server/scraper/remoteJobsAggregatorScraper.js');
const { getSourceMeta } = await import('../../src/constants/sources.js');

const REMOTE_ITEM = {
  type: 'job',
  source: 'remoteok',
  sourceJobId: '1128869',
  url: 'https://remoteok.com/remote-jobs/remote-senior-devops-engineer-stellar-ai-1128869',
  applyUrl: 'https://remoteok.com/l/1128869',
  title: 'Senior DevOps Engineer',
  companyName: 'Stellar AI',
  companyLogo: 'https://r2.remoteok.com/jobs/x.jpg',
  description: '<p>We are hiring a Senior DevOps Engineer. Kubernetes, AWS, Terraform.</p>',
  descriptionText: 'We are hiring a Senior DevOps Engineer. Kubernetes, AWS, Terraform.',
  tags: ['devops', 'aws'],
  employmentType: ['FULL_TIME'],
  applicantCountries: ['United Kingdom', 'Australia'],
  location: 'United Kingdom, Australia',
  salary: { currency: 'USD', min: 90000, max: 130000, unit: 'YEAR' },
  salaryText: null,
  postedDate: '2026-10-12T11:02:13.000Z',
  workArrangement: null,
  relocationOffered: null,
  visaSponsorship: null,
  alsoFoundOn: [{ source: 'himalayas', url: 'https://himalayas.app/x' }],
};

const RELOCATION_ITEM = {
  source: 'relomote_relocation',
  sourceJobId: 'r-77',
  url: 'https://relomote.com/jobs/77',
  applyUrl: 'https://relomote.com/jobs/77',
  title: 'DevOps Engineer (Relocation)',
  companyName: 'Berlin Cloud GmbH',
  descriptionText: 'Relocation support and visa sponsorship offered for this DevOps Engineer role.',
  employmentType: ['FULL_TIME'],
  location: 'Berlin, Germany',
  postedDate: '2026-10-13T00:00:00.000Z',
  relocationOffered: true,
  visaSponsorship: true,
};

const IRRELEVANT_ITEM = { ...REMOTE_ITEM, sourceJobId: '999', title: 'Account Executive', companyName: 'Sales Co', url: 'https://remoteok.com/remote-jobs/999' };

let lastBody: any = null;
function installFetch(items: any[]) {
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => items, text: async () => '' };
  });
}

const baseParams = (over: Record<string, any> = {}) => ({
  keywords: 'devops engineer',
  location: '',
  maxJobsPerSource: 15,
  datePostedFilter: '7d',
  jobType: 'all',
  ...over,
});

describe('Remote Boards source (memo23/remote-jobs-aggregator)', () => {
  beforeEach(() => {
    lastBody = null;
    installFetch([REMOTE_ITEM, RELOCATION_ITEM, IRRELEVANT_ITEM]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is registered as an Apify source with its real pricing', () => {
    const meta = getSourceMeta('RemoteJobs' as any);
    expect(meta?.apifyActorId).toBe('memo23~remote-jobs-aggregator');
    expect(meta?.needsApify).toBe(true);
    expect(meta?.pricePer1K).toBe('$1.99');
  });

  it('default run: all 7 remote boards, keyword + time filter, capped, clean text', async () => {
    const jobs = await new RemoteJobsAggregatorScraper().scrape(baseParams() as any);
    expect(lastBody.sources).toEqual(['remoteok', 'weworkremotely', 'remotive', 'himalayas', 'jobicy', 'arbeitnow', 'relomote']);
    expect(lastBody.searchKeyword).toBe('devops engineer');
    expect(lastBody.timeFilter).toBe('7d');
    expect(lastBody.maxItems).toBe(15);
    expect(lastBody.includeDescription).toBe(true);
    expect(lastBody.cleanHtml).toBe(true);
    expect(lastBody.dedupe).toBe(true);
    expect(lastBody.countries).toBeUndefined();
    expect(lastBody.jobTypes).toBeUndefined();
    // Relevance filter from the base class: only the sales role is dropped.
    expect(jobs.map((j) => j.title)).toEqual(['Senior DevOps Engineer', 'DevOps Engineer (Relocation)']);
  });

  it('remote search keeps the 7 boards; onsite search switches to the relocation board', async () => {
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ jobType: 'remote' }) as any);
    expect(lastBody.sources).toHaveLength(7);
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ jobType: 'onsite' }) as any);
    expect(lastBody.sources).toEqual(['relomote_relocation']);
  });

  it('country filter only for single-token locations (never cities or Remote)', async () => {
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ location: 'India' }) as any);
    expect(lastBody.countries).toEqual(['India']);
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ location: 'Remote' }) as any);
    expect(lastBody.countries).toBeUndefined();
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ location: 'Bengaluru, India' }) as any);
    expect(lastBody.countries).toBeUndefined();
  });

  it('maps employment type and caps maxItems at 200', async () => {
    await new RemoteJobsAggregatorScraper().scrape(baseParams({ contractType: 'Full-time', maxJobsPerSource: 500 }) as any);
    expect(lastBody.jobTypes).toEqual(['FULL_TIME']);
    expect(lastBody.maxItems).toBe(200);
  });

  it('row normalization: remote rows carry Remote truth, salary, ISO date, clean description', async () => {
    const jobs = await new RemoteJobsAggregatorScraper().scrape(baseParams() as any);
    const j = jobs[0];
    expect(j.id).toBe('remotejobs-1128869');
    expect(j.source).toBe('RemoteOK'); // per-row board label, not the umbrella
    expect(j.jobType).toBe('Full-time · Remote');
    expect(j.remote).toBe(true);
    expect((j as any).workMode).toBe('Remote');
    expect(j.salaryMin).toBe(90000);
    expect(j.salaryMax).toBe(130000);
    expect(j.salaryText).toBe('USD 90000-130000/year');
    expect(j.postedDate).toBe(new Date('2026-10-12T11:02:13.000Z').toISOString());
    expect(j.description).not.toContain('<p>'); // HTML stripped
    expect(j.description).toContain('Kubernetes');
    expect(j.location).toBe('United Kingdom, Australia');
    // The list sorts by createdAt DESC — without these the job is invisible.
    expect(j.createdAt).toBeTruthy();
    expect(j.updatedAt).toBeTruthy();
    expect(new Date(j.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('per-row board labels: every actor board becomes a real source; unknown boards fall back to RemoteJobs', async () => {
    installFetch([
      REMOTE_ITEM,
      { ...REMOTE_ITEM, sourceJobId: 'w1', source: 'weworkremotely', title: 'DevOps Engineer', companyName: 'WWR Co' },
      { ...REMOTE_ITEM, sourceJobId: 'h1', source: 'himalayas', title: 'DevOps Engineer', companyName: 'Himalaya Co' },
      { ...REMOTE_ITEM, sourceJobId: 'x1', source: 'some_new_board', title: 'DevOps Engineer', companyName: 'Future Co' },
    ]);
    const jobs = await new RemoteJobsAggregatorScraper().scrape(baseParams() as any);
    const byId = new Map(jobs.map((j) => [j.externalId, j.source]));
    expect(byId.get('1128869')).toBe('RemoteOK');
    expect(byId.get('w1')).toBe('WeWorkRemotely');
    expect(byId.get('h1')).toBe('Himalayas');
    expect(byId.get('x1')).toBe('RemoteJobs'); // forward-compatible fallback
  });

  it('relocation rows are honestly On-site (never labeled Remote by default)', async () => {
    installFetch([RELOCATION_ITEM]);
    const jobs = await new RemoteJobsAggregatorScraper().scrape(baseParams({ jobType: 'onsite', keywords: '' }) as any);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.remote).toBe(false);
    expect((j as any).workMode).toBe('On-site');
    expect(j.jobType).toBe('Full-time · On-site');
    expect(j.id).toBe('remotejobs-r-77');
    expect(j.source).toBe('Relomote'); // relocation rows still show the board
  });
});
