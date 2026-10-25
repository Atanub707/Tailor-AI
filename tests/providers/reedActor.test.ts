// Reed.co.uk source (Apify actor fetch_cat/reed-co-uk-jobs-scraper) —
// input mapping + row normalization. Zero live calls: config mocked, fetch
// stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../server/config.js', () => ({
  loadConfig: () => ({ apify: { enabled: true, token: 'test-token', referralUrl: '' } }),
}));

const { ReedScraper } = await import('../../server/scraper/reedScraper.js');
const { getSourceMeta } = await import('../../src/constants/sources.js');

const REED_ITEM = {
  title: 'Senior DevOps Engineer',
  companyName: 'Acme Talent',
  location: 'London',
  salary: '£65,000 - £85,000',
  salaryMinimum: 65000,
  salaryMaximum: 85000,
  salaryCurrency: 'GBP',
  salaryPeriod: 'per annum',
  jobType: 'Full-time, Permanent',
  contractType: 'Permanent',
  remoteWorkingOption: 'hybrid',
  postedAt: '2026-10-18T09:12:00.287',
  descriptionSnippet: 'Our client is seeking an experienced DevOps Engineer…',
  descriptionText: 'Kubernetes, Terraform, AWS. Build and operate CI/CD platforms.',
  descriptionHtml: '<p>Kubernetes, Terraform, AWS. <strong>Build</strong> and operate CI/CD platforms.</p>',
  sector: 'IT',
  employerId: 'emp-42',
  externalApplyUrl: 'https://www.reed.co.uk/jobs/apply/57002409',
  jobUrl: 'https://www.reed.co.uk/jobs/senior-devops-engineer/57002409',
  reedJobId: '57002409',
  detailStatus: 'details_ok',
};

let lastBody: any = null;
function installFetch(items: any[]) {
  lastBody = null;
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    lastBody = JSON.parse(String(init?.body || '{}'));
    return { ok: true, status: 200, json: async () => items, text: async () => '' };
  });
}

const baseParams = (over: Record<string, any> = {}) => ({
  keywords: 'devops engineer',
  location: 'London',
  maxJobsPerSource: 15,
  datePostedFilter: '7d',
  jobType: 'all',
  ...over,
});

describe('Reed source (fetch_cat/reed-co-uk-jobs-scraper)', () => {
  beforeEach(() => installFetch([REED_ITEM]));
  afterEach(() => vi.unstubAllGlobals());
  afterEach(() => { lastBody = null; });

  it('is registered as an Apify source with its real pricing', () => {
    const meta = getSourceMeta('Reed' as any);
    expect(meta?.apifyActorId).toBe('fetch_cat~reed-co-uk-jobs-scraper');
    expect(meta?.needsApify).toBe(true);
    expect(meta?.pricePer1K).toBe('$0.05');
  });

  it('input: keyword query, location + radius, date + contract mapping, details on', async () => {
    await new ReedScraper().scrape(baseParams({ contractType: 'Contract' }) as any);
    expect(lastBody.queries).toEqual(['devops engineer']);
    expect(lastBody.location).toBe('London');
    expect(lastBody.radius).toBe(10);
    expect(lastBody.datePosted).toBe('last7days');
    expect(lastBody.jobType).toBe('contract');
    expect(lastBody.includeDetails).toBe(true);
    expect(lastBody.maxItems).toBe(15);
    expect(lastBody.remoteOption).toBeUndefined();
  });

  it('input: remote search maps to remoteOption=remote and drops the location filter', async () => {
    await new ReedScraper().scrape(baseParams({ location: 'Remote', jobType: 'remote' }) as any);
    expect(lastBody.remoteOption).toBe('remote');
    expect(lastBody.location).toBeUndefined();
    expect(lastBody.radius).toBeUndefined();
  });

  it('row: structured salary, explicit work mode, apply URL, clean description', async () => {
    const jobs = await new ReedScraper().scrape(baseParams() as any);
    expect(jobs).toHaveLength(1);
    const j: any = jobs[0];
    expect(j.source).toBe('Reed');
    expect(j.id).toBe('reed-57002409');
    expect(j.provider).toBe('apify');
    expect(j.company).toBe('Acme Talent');
    expect(j.location).toBe('London');
    expect(j.salaryText).toBe('£65,000 - £85,000');
    expect(j.salaryMin).toBe(65000);
    expect(j.salaryMax).toBe(85000);
    expect(j.workMode).toBe('Hybrid');
    expect(j.jobType).toContain('Full-time');
    expect(j.jobType).toContain('Hybrid');
    expect(j.applyUrl).toBe('https://www.reed.co.uk/jobs/apply/57002409');
    expect(j.description).toContain('Kubernetes, Terraform, AWS');
    expect(j.description).not.toContain('<strong>');
    expect(new Date(j.postedDate).getTime()).toBe(new Date('2026-10-18T09:12:00.287').getTime());
  });

  it('row: remote listing is honestly Remote', async () => {
    installFetch([{ ...REED_ITEM, remoteWorkingOption: 'remote' }]);
    const jobs = await new ReedScraper().scrape(baseParams() as any);
    expect((jobs[0] as any).workMode).toBe('Remote');
    expect((jobs[0] as any).remote).toBe(true);
  });
});
