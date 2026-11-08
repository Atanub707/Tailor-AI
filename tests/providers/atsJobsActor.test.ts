// Jobo ATS Jobs API source (jobo.world/ats-jobs-api) — input mapping + row
// normalization across the shared 150+ ATS schema. Zero live calls: config
// mocked, fetch stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../server/config.js', () => ({
  loadConfig: () => ({ apify: { enabled: true, token: 'test-token', referralUrl: '' } }),
}));

const { AtsJobsScraper } = await import('../../server/scraper/atsJobsScraper.js');
const { getSourceMeta } = await import('../../src/constants/sources.js');

const JOBO_ITEM = {
  id: 'f0f6a7d0-c667-48f7-95bc-a91f172e2d6d',
  title: 'Senior DevOps Engineer',
  normalized_title: 'DevOps Engineer',
  summary: 'Build and operate secure cloud platforms.',
  company: {
    id: 'comp-1',
    name: 'Acme Cloud',
    website: 'https://acme.example',
    logo_url: 'https://images.example/acme.jpg',
    industries: ['Software'],
  },
  locations: [
    { location: 'London, England', city: 'London', region: 'England', country: 'United Kingdom' },
    { location: 'Remote (UK)', city: '', region: '', country: 'United Kingdom' },
  ],
  compensation: { min: 65000, max: 85000, currency: 'GBP', period: 'yearly' },
  employment_type: 'Full-time',
  workplace_type: 'Hybrid',
  experience_level: 'Senior',
  qualifications: { must_have: { skills: [{ name: 'Kubernetes', type: 'hard' }] } },
  is_h1b_sponsor: false,
  listing_url: 'https://job-boards.greenhouse.io/acme/jobs/123',
  apply_url: 'https://job-boards.greenhouse.io/acme/jobs/123#app',
  source: 'greenhouse',
  date_posted: '2026-10-27T10:00:00Z',
  description: '<p>Kubernetes, Terraform, AWS. <strong>Build</strong> and operate CI/CD platforms.</p>',
};

let lastUrl = '';
let lastBody: any = null;
function installFetch(items: any[]) {
  lastUrl = '';
  lastBody = null;
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    lastUrl = String(url);
    lastBody = JSON.parse(String(init?.body || '{}'));
    return { ok: true, status: 200, json: async () => items, text: async () => '' };
  });
}

const baseParams = (over: Record<string, any> = {}) => ({
  keywords: 'devops engineer',
  location: 'London',
  maxJobsPerSource: 15,
  datePostedFilter: '7d',
  jobType: 'remote',
  contractType: 'F',
  experienceLevel: '4',
  ...over,
});

describe('ATS Jobs source (jobo.world/ats-jobs-api)', () => {
  beforeEach(() => installFetch([JOBO_ITEM]));
  afterEach(() => vi.unstubAllGlobals());

  it('is registered as one Apify source with its real pricing', () => {
    const meta = getSourceMeta('ATS Jobs');
    expect(meta?.apifyActorId).toBe('jobo.world~ats-jobs-api');
    expect(meta?.needsApify).toBe(true);
    expect(meta?.pricePer1K).toBe('$1.30');
  });

  it('maps every search control onto the actor input', async () => {
    await new AtsJobsScraper().scrape(baseParams() as any);
    expect(lastUrl).toContain('jobo.world~ats-jobs-api');
    expect(lastBody).toEqual({
      queries: ['devops engineer'],
      search_description: false,
      page: 1,
      page_size: 15,
      include_company_details: false,
      locations: ['London'],
      work_models: ['remote'],
      employment_types: ['full-time'],
      experience_levels: ['mid', 'senior'],
      posted_after: '7 days ago',
    });
  });

  it('normalizes the shared ATS schema into a Job', async () => {
    const jobs = await new AtsJobsScraper().scrape(baseParams() as any);
    expect(jobs).toHaveLength(1);
    const j = jobs[0] as any;
    expect(j.source).toBe('ATS Jobs');
    expect(j.atsPlatform).toBe('greenhouse');
    expect(j.title).toBe('Senior DevOps Engineer');
    expect(j.company).toBe('Acme Cloud');
    expect(j.companyId).toBe('comp-1');
    expect(j.location).toBe('London, England');
    expect(j.locations).toEqual(['London, England', 'Remote (UK)']);
    expect(j.workMode).toBe('Hybrid');
    expect(j.jobType).toBe('Full-time · Hybrid');
    expect(j.salaryMin).toBe(65000);
    expect(j.salaryMax).toBe(85000);
    expect(j.salaryText).toContain('65,000');
    expect(j.description).toContain('Kubernetes, Terraform, AWS');
    expect(j.description).not.toContain('<strong>');
    expect(j.url).toBe('https://job-boards.greenhouse.io/acme/jobs/123');
    expect(j.applyUrl).toBe('https://job-boards.greenhouse.io/acme/jobs/123#app');
    expect(j.postedDate).toBe('2026-10-27T10:00:00.000Z');
    expect(j.postedDateParsed).toBe('2026-10-27');
    expect(j.experienceLevel).toBe('Senior');
    expect(j.provider).toBe('apify');
  });

  it('drops rows without a title or a public URL', async () => {
    installFetch([{ title: '', listing_url: 'https://x/1' }, { title: 'DevOps Engineer', listing_url: '' }]);
    expect(await new AtsJobsScraper().scrape(baseParams() as any)).toEqual([]);
  });

  it('omits the location filter for remote/global searches', async () => {
    installFetch([JOBO_ITEM]);
    await new AtsJobsScraper().scrape(baseParams({ location: 'Remote' }) as any);
    expect(lastBody.locations).toBeUndefined();
  });
});
