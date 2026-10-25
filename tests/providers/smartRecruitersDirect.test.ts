// SmartRecruiters direct (free API) — keyword query, URL construction and
// detail enrichment. Zero live calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-direct-'));
process.env.TAILOR_DATA_DIR = tmpDir;

vi.mock('../../server/config.js', () => ({
  loadConfig: () => ({ apify: { enabled: false, token: '', referralUrl: '' }, scraper: {} }),
}));

const { scrapeDirectAts } = await import('../../server/providers/directAtsProvider.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { getDb } = await import('../../server/storage/fileStorage.js');

const posts = [
  { id: '111', name: 'DevOps Engineer', location: { city: 'Berlin', country: 'Germany' }, releasedDate: '2026-10-20', company: { name: 'Bosch' } },
  { id: '222', name: 'HVAC Design Engineer', location: { city: 'Stuttgart', country: 'Germany' }, releasedDate: '2026-10-21', company: { name: 'Bosch' } },
];

const urls: string[] = [];
function installFetch() {
  urls.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url));
    if (String(url).includes('/postings/111')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          jobAd: { sections: {
            companyDescription: { text: 'Bosch is a supplier.' },
            jobDescription: { text: 'Build Kubernetes platforms with Terraform and AWS.' },
            qualifications: { text: '5 years of DevOps experience.' },
          } },
          applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/111-devops-engineer?oga=true',
          postingUrl: 'https://jobs.smartrecruiters.com/BoschGroup/111-devops-engineer',
        }),
      } as any;
    }
    if (String(url).includes('/postings/222')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          jobAd: { sections: { jobDescription: { text: 'Design HVAC systems for industrial buildings.' } } },
          applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/222-hvac?oga=true',
          postingUrl: 'https://jobs.smartrecruiters.com/BoschGroup/222-hvac',
        }),
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({ totalFound: posts.length, content: posts }) } as any;
  });
}

describe('SmartRecruiters direct API', () => {
  beforeEach(() => {
    ensureV2Tables();
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, 'smartrecruiters', 1, ?, ?)`
    ).run('sr-bosch', 'Bosch Group', 'https://careers.smartrecruiters.com/BoschGroup', now, now);
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the keyword to SR, builds the public URL and enriches description from the detail endpoint', async () => {
    const jobs = await scrapeDirectAts('SmartRecruiters', 'smartrecruiters', ['devops'], 3);
    // The HVAC row carries no 'devops' evidence anywhere — it must not survive.
    expect(jobs).toHaveLength(1);
    const j: any = jobs[0];
    expect(j.atsPlatform).toBe('smartrecruiters');
    expect(urls[0]).toContain('/companies/BoschGroup/postings?limit=50&q=devops');
    expect(j.url).toBe('https://jobs.smartrecruiters.com/BoschGroup/111-devops-engineer');
    expect(j.applyUrl).toContain('?oga=true');
    expect(j.description).toContain('Kubernetes platforms with Terraform');
    expect(urls.some((u) => u.includes('/postings/111'))).toBe(true);
  });
});
