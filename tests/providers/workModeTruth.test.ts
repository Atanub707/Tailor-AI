// Work-mode TRUTH — regression suite for the reported bug: "when I search
// for remote jobs I think I'm getting all the job types."
//
// Root cause found in live data: the ATS indexer classified work mode from
// ~2,000 chars of job-description text as a fallback, and weak mentions of
// "remote" (benefits/boilerplate) fabricated Remote labels — a Lever
// "CCTV/Security Technician — Washington, DC" (API says workplaceType:
// onsite) was stored as Remote. Fix: provider workplaceType/isRemote is
// authoritative; the fallback uses the LOCATION text only; description text
// counts only for STRONG remote phrases at search time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmode-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { setDirectAtsFetcher, fetchAtsBoard } = await import('../../server/providers/directAtsProvider.js');
const { syncBoard, defaultAtsIndexConfig } = await import('../../server/ats-index/atsIndexer.js');
const { ensureAtsIndexSchema, queryAtsCandidates } = await import('../../server/ats-index/atsRepository.js');
const { createAtsIndexProvider } = await import('../../server/providers/greenhouseIndexProvider.js');
const { classifyFromText, hasStrongRemoteSignal } = await import('../../server/scraper/workMode.js');

// The exact real-world regression payload: Lever says onsite, the description
// mentions "remote" in boilerplate.
const CCTV = {
  id: 'cctv-1', text: 'CCTV/Security Technician',
  hostedUrl: 'https://jobs.lever.co/acme/cctv-1', applyUrl: 'https://jobs.lever.co/acme/cctv-1',
  createdAt: Date.now(),
  categories: { location: 'Washington, DC', team: 'Field Ops', commitment: 'Full-time' },
  workplaceType: 'onsite',
  descriptionPlain: 'We are a remote-friendly company. Work with our remote teams and enjoy remote work options. Benefits include...',
};
const LEVER_REMOTE = { ...CCTV, id: 'rem-1', text: 'Platform Engineer', workplaceType: 'remote', categories: { location: 'US - Remote', team: 'Eng', commitment: 'Full-time' }, descriptionPlain: 'Role.' };
const LEVER_HYBRID = { ...CCTV, id: 'hyb-1', text: 'Hybrid Analyst', workplaceType: 'hybrid', categories: { location: 'Berlin, Germany', team: 'Eng', commitment: 'Full-time' }, descriptionPlain: 'Role.' };

const ASHBY_REMOTE = { id: 'ash-rem', title: 'Backend Engineer', isRemote: true, workplaceType: 'Remote', location: 'Europe', publishedAt: new Date().toISOString(), jobUrl: 'https://jobs.ashbyhq.com/fx/ash-rem', applyUrl: 'https://jobs.ashbyhq.com/fx/ash-rem', descriptionPlain: 'Role.' };
const ASHBY_HYBRID = { id: 'ash-hyb', title: 'Designer', isRemote: false, workplaceType: 'Hybrid', location: 'Berlin', publishedAt: new Date().toISOString(), jobUrl: 'https://jobs.ashbyhq.com/fx/ash-hyb', applyUrl: 'https://jobs.ashbyhq.com/fx/ash-hyb', descriptionPlain: 'Role.' };
const ASHBY_FLAG_ONLY = { id: 'ash-flag', title: 'SRE', isRemote: true, location: 'North America', publishedAt: new Date().toISOString(), jobUrl: 'https://jobs.ashbyhq.com/fx/ash-flag', applyUrl: 'https://jobs.ashbyhq.com/fx/ash-flag', descriptionPlain: 'Role.' };

function installFetcher() {
  setDirectAtsFetcher(async (url: string) => {
    if (url.includes('api.lever.co')) return [CCTV, LEVER_REMOTE, LEVER_HYBRID];
    return { jobs: [ASHBY_REMOTE, ASHBY_HYBRID, ASHBY_FLAG_ONLY] };
  });
}

describe('work-mode truth: provider signals win, weak text never fabricates Remote', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
    installFetcher();
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('provider mappers carry the EXPLICIT workplace type (never description text)', async () => {
    const lever = await fetchAtsBoard('t', 'lever', 'acme', 'Acme');
    const byId = new Map(lever.map((j) => [j.externalId, j]));
    expect(byId.get('cctv-1')!.workMode).toBe('On-site'); // despite "remote" in boilerplate
    expect(byId.get('cctv-1')!.remote).toBe(false);
    expect(byId.get('rem-1')!.workMode).toBe('Remote');
    expect(byId.get('hyb-1')!.workMode).toBe('Hybrid');

    const ashby = await fetchAtsBoard('t', 'ashby', 'fx', 'Fx');
    const aById = new Map(ashby.map((j) => [j.externalId, j]));
    expect(aById.get('ash-rem')!.workMode).toBe('Remote');
    expect(aById.get('ash-hyb')!.workMode).toBe('Hybrid');
    expect(aById.get('ash-flag')!.workMode).toBe('Remote'); // isRemote flag only
  });

  it('REGRESSION: syncing stores On-site for the CCTV technician (was Remote via description text)', async () => {
    const cfg = defaultAtsIndexConfig();
    const res = await syncBoard({ id: 'b1', companyName: 'Acme', careerUrl: 'https://jobs.lever.co/acme', atsPlatform: 'lever', atsCompanySlug: 'acme', failureCount: 0, nextRefreshAt: null, lastJobCount: null } as any, cfg);
    expect(res.ok).toBe(true);
    const rows = queryAtsCandidates({ platform: 'lever', activeOnly: true });
    const cctv = rows.find((r) => r.external_id === 'cctv-1')!;
    expect(cctv.work_mode).toBe('On-site');
    expect(rows.find((r) => r.external_id === 'rem-1')!.work_mode).toBe('Remote');
    expect(rows.find((r) => r.external_id === 'hyb-1')!.work_mode).toBe('Hybrid');
  });

  it('index search side carries workMode through (strict Remote search never sees the CCTV job)', async () => {
    const res = await syncBoard({ id: 'b2', companyName: 'Fx', careerUrl: 'https://jobs.ashbyhq.com/fx', atsPlatform: 'ashby', atsCompanySlug: 'fx', failureCount: 0, nextRefreshAt: null, lastJobCount: null } as any, defaultAtsIndexConfig());
    expect(res.ok).toBe(true);
    const provider = createAtsIndexProvider('ashby', 'Ashby');
    const out = await provider.search({ source: 'Ashby', keywords: 'engineer' } as any, 50);
    const sre = out.jobs.find((j) => j.title === 'SRE')!;
    expect(sre.workMode).toBe('Remote');
    expect(out.jobs.find((j) => j.title === 'Designer')!.workMode).toBe('Hybrid');
  });

  it('weak "remote" mentions are not strong signals; strong phrases are', () => {
    expect(hasStrongRemoteSignal('we are a remote-friendly company with remote teams')).toBe(false);
    expect(hasStrongRemoteSignal('enjoy remote work options')).toBe(false);
    expect(hasStrongRemoteSignal('This is a fully remote position')).toBe(true);
    expect(hasStrongRemoteSignal('100% remote role')).toBe(true);
    expect(hasStrongRemoteSignal('work from anywhere')).toBe(true);
    expect(classifyFromText('Remote - India')).toBe('Remote'); // location strings stay reliable
  });
});
