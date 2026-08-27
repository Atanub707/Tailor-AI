import { describe, it, expect, afterEach, vi } from 'vitest';

// Free scraper verification — fixture-based, ZERO live web calls.
// Each scraper uses global fetch; tests mock it with realistic payloads.

import { ArbeitnowScraper } from '../../server/scraper/arbeitnowScraper.js';
import { SimplyHiredScraper } from '../../server/scraper/simplyHiredScraper.js';
import { DiceScraper } from '../../server/scraper/diceScraper.js';
import { ReedScraper } from '../../server/scraper/reedScraper.js';
import { MyCareersFutureScraper } from '../../server/scraper/myCareersFutureScraper.js';
import { CutshortScraper } from '../../server/scraper/cutshortScraper.js';
import { GupyScraper } from '../../server/scraper/gupyScraper.js';
import { JobsChScraper } from '../../server/scraper/jobsChScraper.js';
import { DaijobScraper } from '../../server/scraper/daijobScraper.js';
import { MyJobMagScraper } from '../../server/scraper/myJobMagScraper.js';

function mockFetch(respond: (url: string) => { ok: boolean; status?: number; json?: () => Promise<any>; text?: () => Promise<string> }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    const r = respond(url);
    if (!r.ok) {
      return { ok: false, status: r.status || 500, json: async () => ({}), text: async () => '' } as any;
    }
    return {
      ok: true,
      status: 200,
      json: r.json || (async () => ({})),
      text: r.text || (async () => ''),
    } as any;
  });
}

const baseParams = { keywords: 'DevOps', location: '', datePostedFilter: 'all', jobType: 'all', maxJobsPerSource: 5 } as any;

afterEach(() => { vi.restoreAllMocks(); });

describe('Arbeitnow (API JSON)', () => {
  it('parses jobs, filters by keyword, respects LIMIT', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        data: [
          { slug: '1', title: 'DevOps Engineer', company_name: 'A', location: 'Berlin', url: 'https://arbeitnow.com/1', created_at: Math.floor(Date.now() / 1000) },
          { slug: '2', title: 'Data Engineer', company_name: 'B', location: 'Munich', url: 'https://arbeitnow.com/2', created_at: Math.floor(Date.now() / 1000) },
        ],
      }),
    }));
    const jobs = await new ArbeitnowScraper().scrape(baseParams);
    expect(jobs.length).toBe(1);
    expect(jobs[0].title).toBe('DevOps Engineer');
    expect(jobs[0].url).toContain('arbeitnow.com');
  });

  it('handles malformed response (no data array)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ unexpected: true }) }));
    const jobs = await new ArbeitnowScraper().scrape(baseParams);
    expect(jobs).toEqual([]);
  });

  it('handles HTTP error', async () => {
    mockFetch(() => ({ ok: false, status: 500 }));
    const jobs = await new ArbeitnowScraper().scrape(baseParams);
    expect(jobs).toEqual([]);
  });
});

describe('SimplyHired (__NEXT_DATA__)', () => {
  it('parses the NEXT_DATA JSON job list', async () => {
    const nextData = JSON.stringify({
      props: { pageProps: { jobs: [
        { jobKey: 'devops-1', title: 'DevOps Engineer', company: 'Company A', location: 'Bengaluru, IN', botUrl: '/job/devops-1', dateOnIndeed: new Date().toISOString().slice(0, 10) },
        { jobKey: 'ae-1', title: 'Account Executive', company: 'Company B', location: 'Mumbai, IN', botUrl: '/job/ae-1', dateOnIndeed: new Date().toISOString().slice(0, 10) },
      ] } },
    });
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${nextData}</script></head><body></body></html>`;
    mockFetch(() => ({ ok: true, text: async () => html }));
    const jobs = await new SimplyHiredScraper().scrape(baseParams);
    expect(jobs.some((j) => j.title.includes('DevOps'))).toBe(true);
    expect(jobs.some((j) => j.title.includes('DevOps') && j.url.includes('simplyhired.com'))).toBe(true);
  });

  it('handles empty HTML', async () => {
    mockFetch(() => ({ ok: true, text: async () => '<html><body></body></html>' }));
    const jobs = await new SimplyHiredScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});

describe('Dice (HTML + JSON-LD detail)', () => {
  it('parses listings and detail pages, filters by keyword', async () => {
    const listHtml = `<a href="/job-detail/aaaa-bbbb-cccc-1">DevOps Engineer</a>
      <span class="company-name">Company A</span>
      <a href="/job-detail/aaaa-bbbb-cccc-2">Sales Executive</a>
      <span class="company-name">Company B</span>`;
    const detailLd = JSON.stringify({
      '@type': 'JobPosting', title: 'DevOps Engineer',
      hiringOrganization: { name: 'Company A' },
      jobLocation: { address: { addressLocality: 'Bengaluru' } },
      datePosted: new Date().toISOString().slice(0, 10),
    });
    const detailHtml = `<html><head><script type="application/ld+json">${detailLd}</script></head><body></body></html>`;
    mockFetch((url) => {
      if (url.includes('/job-detail/')) return { ok: true, text: async () => detailHtml };
      return { ok: true, text: async () => listHtml };
    });
    const jobs = await new DiceScraper().scrape(baseParams);
    expect(jobs.some((j) => j.title.includes('DevOps'))).toBe(true);
  });
});

describe('Reed (API/HTML)', () => {
  it('returns jobs or [] without throwing on malformed', async () => {
    mockFetch(() => ({ ok: false, status: 403 }));
    const jobs = await new ReedScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});

describe('MyCareersFuture (API)', () => {
  it('handles empty API response gracefully', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ results: [] }) }));
    const jobs = await new MyCareersFutureScraper().scrape(baseParams);
    expect(jobs).toEqual([]);
  });
});

describe('Cutshort (API)', () => {
  it('handles error response gracefully', async () => {
    mockFetch(() => ({ ok: false, status: 500 }));
    const jobs = await new CutshortScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});

describe('Gupy (API)', () => {
  it('parses a jobs payload and respects LIMIT', async () => {
    mockFetch((url) => {
      if (url.includes('api')) {
        return { ok: true, json: async () => ({ data: Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'DevOps Engineer', company: { name: 'C' }, jobUrl: `https://gupy.io/job/${i}`, publishedDate: new Date().toISOString() })) }) };
      }
      return { ok: true, text: async () => '<html></html>' };
    });
    const jobs = await new GupyScraper().scrape(baseParams);
    expect(jobs.length).toBeLessThanOrEqual(5);
  });
});

describe('JobsCh (HTML)', () => {
  it('handles malformed HTML without throwing', async () => {
    mockFetch(() => ({ ok: true, text: async () => '<html><body><div></div></body></html>' }));
    const jobs = await new JobsChScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});

describe('Daijob (HTML)', () => {
  it('handles empty result page', async () => {
    mockFetch(() => ({ ok: true, text: async () => '<html><body>No jobs found</body></html>' }));
    const jobs = await new DaijobScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});

describe('MyJobMag (HTML)', () => {
  it('handles error page gracefully', async () => {
    mockFetch(() => ({ ok: false, status: 500 }));
    const jobs = await new MyJobMagScraper().scrape(baseParams);
    expect(Array.isArray(jobs)).toBe(true);
  });
});