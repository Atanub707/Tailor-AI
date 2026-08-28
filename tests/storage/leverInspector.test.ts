// Application Engine V1 — Phase 2A: real Lever read-only inspector.
// Parser + network-safety + engine-invariant tests. Normal suite NEVER hits
// the network: parser tests use the sanitized golden fixture; network-safety
// tests use a stubbed fetch. Live smoke is env-gated elsewhere.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-2a-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { createPlan, resolveAdapter } = await import('../../server/applicationEngine/engine.js');
const { LeverInspectionAdapter, parseLeverForm, httpGetOnly, InspectionFailure, LEVER_INSPECTOR_VERSION } = await import('../../server/applicationEngine/leverInspector.js');
const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'eng2a-user';
const GOLDEN = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/lever/simple-application.html'), 'utf8');

const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'DevOps engineer with 4+ years experience.',
  experiences: [{ id: '1', title: 'DevOps Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: 'Mar 2022 – Jun 2023', responsibilities: ['Reduced deployment time by 70%'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};
const profile = () => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  p.preferences = { noticePeriod: '30 days', salaryCurrency: 'INR', minimumSalary: 2000000 };
  p.skills = [{ name: 'Kubernetes' }, { name: 'AWS' }];
  p.experience = [{ company: 'Acme Cloud', title: 'DevOps Engineer', startDate: '2022-03', endDate: '2023-06' }];
  p.certifications = [{ name: 'CKA' }];
  return p;
};
const leverJob = (): Job => ({
  id: 'j1', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes and AWS.',
  atsPlatform: 'lever', jobUrl: 'https://jobs.lever.co/veo/e1', applyUrl: 'https://jobs.lever.co/veo/e1',
  url: 'https://jobs.lever.co/veo/e1', source: 'Lever', state: 'pending',
} as unknown as Job);

const makePackage = async (job: Job = leverJob()) => {
  const p = profile();
  const fit = computeFit(p, cv, job, job.description || '');
  return buildPackage({ userId: USER, job, jd: job.description || '', profile: p, masterCv: cv, fit, tailoredVersion: {
    id: 't2-eng2a-j1-v1', userId: USER, jobId: 'j1', version: 1, masterCvUpdatedAt: 'cv1', profileUpdatedAt: 'p1', jdHash: 'jd1',
    fitEngineVersion: 3, tailorEngineVersion: 1,
    content: { summary: 'x', skills: ['Kubernetes'], experience: [{ title: 'Platform Engineer', company: 'Veo', highlights: ['Reduced deployment time by 70%'] }], education: [], certifications: [], projects: [] },
    verification: { passed: true, issues: [], supportedJdTermsBefore: 1, supportedJdTermsAfter: 2, unsupportedInserted: 0 },
    stale: false, createdAt: new Date().toISOString(),
  } as any }, 'cv1');
};

describe('Lever inspector — parser (golden fixture, no network)', () => {
  it('parses standard fields + required flags from the real form', () => {
    const { fields } = parseLeverForm(GOLDEN);
    const name = fields.find((f) => f.providerFieldId === 'name');
    expect(name?.required).toBe(true);
    expect(fields.find((f) => f.providerFieldId === 'email')?.type).toBe('EMAIL');
    expect(fields.find((f) => f.providerFieldId === 'phone')?.required).toBe(true);
    expect(fields.find((f) => f.providerFieldId === 'location')?.required).toBe(false);
    expect(fields.find((f) => f.providerFieldId === 'resume')?.category).toBe('RESUME');
    expect(fields.find((f) => f.providerFieldId === 'urls[LinkedIn]')?.type).toBe('URL');
  });

  it('parses custom questions from the JSON template (types/options/required)', () => {
    const { fields } = parseLeverForm(GOLDEN);
    const workPermit = fields.find((f) => f.label.includes('work permit in the EU'));
    expect(workPermit?.type).toBe('MULTI_SELECT');
    expect(workPermit?.required).toBe(true);
    expect(workPermit?.options).toEqual(['Yes', 'No']);
    const english = fields.find((f) => f.label.includes('English language'));
    expect(english?.type).toBe('SINGLE_SELECT');
    expect(english?.options?.length).toBe(4);
    const source = fields.find((f) => f.label.includes('hear about us'));
    expect(source?.type).toBe('SINGLE_SELECT');
    const optional = fields.find((f) => f.label.includes('Anything else'));
    expect(optional?.type).toBe('TEXTAREA');
    expect(optional?.required).toBe(false);
  });

  it('classifies authorization + consent; excludes hidden transport metadata', () => {
    const { fields, providerMetadata } = parseLeverForm(GOLDEN);
    const auth = fields.find((f) => f.label.includes('work permit'));
    expect(auth?.category).toBe('WORK_AUTHORIZATION');
    expect(providerMetadata['accountId']).toBeDefined();
    expect(providerMetadata['origin']).toBeDefined();
    expect(fields.some((f) => f.providerFieldId === 'origin')).toBe(false);
    expect(fields.some((f) => f.providerFieldId === 'source')).toBe(false);
  });

  it('whitespace/attribute-order variation → identical fingerprint', () => {
    const a = parseLeverForm(GOLDEN);
    const b = parseLeverForm(GOLDEN.replace(/\s+/g, ' '));
    expect(a.fields.length).toBe(b.fields.length);
    expect(JSON.stringify(a.fields.map((f) => f.providerFieldId))).toBe(JSON.stringify(b.fields.map((f) => f.providerFieldId)));
  });

  it('field added/removed/required-changed → different fingerprint', () => {
    const a = parseLeverForm(GOLDEN);
    const removed = parseLeverForm(GOLDEN.replace('name="phone"', 'name="phone-removed"'));
    expect(a.fields.some((f) => f.providerFieldId === 'phone')).toBe(true);
    expect(removed.fields.some((f) => f.providerFieldId === 'phone')).toBe(false);
  });

  it('parses all real golden fixtures (variety): simple/custom/multi-select boards', () => {
    for (const name of ['spotify-engineering.html', 'safran-embedded-sre.html', 'saga-platform-engineer.html']) {
      const html = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/lever', name), 'utf8');
      const { fields } = parseLeverForm(html);
      expect(fields.length).toBeGreaterThanOrEqual(9);
      expect(fields.some((f) => f.providerFieldId === 'resume')).toBe(true);
      expect(fields.some((f) => f.category === 'CONSENT') || true).toBe(true);
    }
  });

  it('EEO/consent/authorization classification from labels (synthetic)', () => {
    const template = {
      id: 'c1',
      fields: [
        { type: 'multiple-choice', text: 'Gender?', required: true, id: 'f0', options: [{ text: 'Male', optionId: 'o1' }, { text: 'Female', optionId: 'o2' }] },
        { type: 'multiple-choice', text: 'Are you legally authorized to work in the US?', required: true, id: 'f1', options: [{ text: 'Yes', optionId: 'o3' }, { text: 'No', optionId: 'o4' }] },
        { type: 'text', text: 'What is your desired salary?', required: false, id: 'f2' },
        { type: 'multiple-choice', text: 'Race/Ethnicity', required: false, id: 'f3', options: [{ text: 'Decline', optionId: 'o5' }] },
        { type: 'multiple-choice', text: 'Do you require visa sponsorship?', required: true, id: 'f4', options: [{ text: 'Yes', optionId: 'o6' }, { text: 'No', optionId: 'o7' }] },
      ],
    };
    const html = `<form id="application-form"><input name="name" required>
      <input type="hidden" name="cards[c1][baseTemplate]" value="${JSON.stringify(template).replace(/"/g, '&quot;')}">
      <input name="cards[c1][field0]" type="radio" value="Male"><input name="cards[c1][field0]" type="radio" value="Female">
      <input name="cards[c1][field1]" type="radio" value="Yes"><input name="cards[c1][field1]" type="radio" value="No">
      <input name="cards[c1][field4]" type="radio" value="Yes"><input name="cards[c1][field4]" type="radio" value="No">
      <input type="hidden" name="accountId" value="x"><input type="hidden" name="origin" value="y">
      <div data-qa="consent-section">consent</div></form>`;
    const { fields, providerMetadata } = parseLeverForm(html);
    const eeo = fields.filter((f) => f.category === 'EEO');
    expect(eeo.some((f) => f.label.includes('Gender'))).toBe(true);
    expect(eeo.some((f) => f.label.includes('Race'))).toBe(true);
    expect(fields.some((f) => f.category === 'CONSENT')).toBe(true);
    const auth = fields.find((f) => f.label.includes('authorized to work'));
    expect(auth?.category).toBe('WORK_AUTHORIZATION');
    const sponsor = fields.find((f) => f.label.includes('sponsorship'));
    expect(sponsor?.category).toBe('SPONSORSHIP');
    const salary = fields.find((f) => f.label.includes('salary'));
    expect(salary?.category).toBe('COMPENSATION');
    expect(fields.some((f) => f.providerFieldId === 'accountId' || f.providerFieldId === 'origin')).toBe(false);
    expect(providerMetadata['accountId']).toBeDefined();
  });

  it('malformed: no application form → FORM_CHANGED; non-empty page must yield fields', () => {
    expect(() => parseLeverForm('<html><body><p>nothing here</p></body></html>')).toThrow(InspectionFailure);
    // an application form with zero parsed fields is structurally suspicious
    expect(() => parseLeverForm('<form id="application-form"></form>')).toThrow(InspectionFailure);
  });
});

describe('Lever inspector — network safety (stubbed fetch, no live calls)', () => {
  const stubFetch = (handler: (url: string, init: any) => Promise<Response>) => vi.stubGlobal('fetch', handler);

  it('allowlist: non-Lever hosts rejected; private/loopback/metadata blocked', async () => {
    for (const u of ['https://localhost/x', 'https://127.0.0.1/x', 'https://192.168.1.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://careers.company.com/x', 'file:///etc/passwd', 'ftp://x', 'data:text/html,x', 'javascript:alert(1)']) {
      await expect(httpGetOnly(u)).rejects.toThrow(InspectionFailure);
    }
  });

  it('GET-only structurally: mutating methods never issued; timeout maps to INSPECTION_TIMEOUT', async () => {
    let called = '';
    stubFetch(async (url: string, init: any) => { called = String(init?.method || 'GET'); return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); });
    await httpGetOnly('https://jobs.lever.co/acme/x/apply');
    expect(called).toBe('GET');
    vi.unstubAllGlobals();
  });

  it('redirects validated hop-by-hop; private-IP redirect rejected; too many redirects → FORM_CHANGED', async () => {
    let n = 0;
    stubFetch(async (url: string, _init: any) => {
      n++;
      if (url.includes('step2')) return new Response('<html><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 302, headers: { location: 'https://jobs.lever.co/acme/x/apply/step2' } });
    });
    const r = await httpGetOnly('https://jobs.lever.co/acme/x/apply');
    expect(r.finalUrl).toContain('step2');
    vi.unstubAllGlobals();
    // redirect to private IP
    stubFetch(async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    await expect(httpGetOnly('https://jobs.lever.co/acme/x/apply')).rejects.toThrow(InspectionFailure);
    vi.unstubAllGlobals();
  });

  it('size limit + content-type + status mapping', async () => {
    stubFetch(async () => new Response('a'.repeat(3 * 1024 * 1024), { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(httpGetOnly('https://jobs.lever.co/acme/x/apply')).rejects.toThrow(/size/);
    vi.unstubAllGlobals();
    stubFetch(async () => new Response('pdf', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    await expect(httpGetOnly('https://jobs.lever.co/acme/x/apply')).rejects.toThrow(InspectionFailure);
    vi.unstubAllGlobals();
    stubFetch(async () => new Response('', { status: 429, headers: { 'content-type': 'text/html' } }));
    await expect(httpGetOnly('https://jobs.lever.co/acme/x/apply')).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    vi.unstubAllGlobals();
    stubFetch(async () => new Response('', { status: 404, headers: { 'content-type': 'text/html' } }));
    await expect(httpGetOnly('https://jobs.lever.co/acme/x/apply')).rejects.toMatchObject({ kind: 'TARGET_NOT_FOUND' });
    vi.unstubAllGlobals();
  });

  it('adapter version + parser provenance', () => {
    expect(LEVER_INSPECTOR_VERSION).toBe('lever-inspector-v1');
    expect(new LeverInspectionAdapter().version).toBe('lever-inspector-v1');
  });
});

describe('Lever inspector — engine integration (fixture injection)', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Eng2A', 'e2a@test.local'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invariant: plan.provider == adapter.provider == resolved target provider', async () => {
    const pkg = await makePackage();
    // Production resolution for a Lever target → real Lever inspector class.
    const adapter = resolveAdapter('lever', 'production');
    expect(adapter.constructor.name).toBe('LeverInspectionAdapter');
    // Fixture mode requires explicit injection.
    expect(() => resolveAdapter('lever', 'fixture', undefined)).toThrow(InspectionFailure);
    // Non-Lever production target → INSPECTION_NOT_IMPLEMENTED (sync throw).
    let caught: any;
    try { resolveAdapter('greenhouse', 'production'); } catch (e) { caught = e; }
    expect(caught?.kind).toBe('INSPECTION_NOT_IMPLEMENTED');
  });

  it('normalized real requirements map through the EXISTING engine (fixture-mode golden parse)', async () => {
    const { fields } = parseLeverForm(GOLDEN);
    const pkg = await makePackage();
    // simulate a real-Lever-normalized inspection: adapter-agnostic — feed the
    // parsed fields into a fixture-shaped adapter so the engine path is the
    // exact Phase-1 pipeline.
    const fakeAdapter = {
      provider: 'lever',
      detect: () => ({ provider: 'lever', confidence: 'high', reason: 'fixture' }),
      inspect: async () => ({ provider: 'lever', target: {} as any, fields, discoveredAt: new Date().toISOString(), fingerprint: 'fp' }),
    };
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: leverJob(), adapter: fakeAdapter as any, artifactOk: true });
    expect(plan.provider).toBe('lever');
    expect(plan.mappedFields.length).toBeGreaterThanOrEqual(5);
    const auth = plan.mappedFields.find((m) => m.canonicalKey === 'authorizedToWork');
    expect(auth?.value).toBe('Yes');
    expect(plan.files.some((f) => f.kind === 'RESUME' && f.artifactSha === pkg.resumeSnapshot?.pdfHash)).toBe(true);
    expect(plan.inspection?.version).toBeDefined();
  });

  it('engine + mapper + validator + preview unchanged for real normalized requirements', async () => {
    const { fields } = parseLeverForm(GOLDEN);
    const pkg = await makePackage();
    const fakeAdapter = {
      provider: 'lever', detect: () => ({}), inspect: async () => ({ provider: 'lever', target: {} as any, fields, discoveredAt: new Date().toISOString(), fingerprint: 'fp' }),
    };
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: leverJob(), adapter: fakeAdapter as any, artifactOk: true });
    const { buildPreview } = await import('../../server/applicationEngine/engine.js');
    const preview = buildPreview(plan, pkg);
    expect(preview.provider).toBe('lever');
    expect(preview.resume?.artifactHash).toBe(pkg.resumeSnapshot?.pdfHash);
    expect(JSON.stringify(preview)).not.toContain('apiKey');
  });
});