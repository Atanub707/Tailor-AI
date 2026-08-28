// Phase 2A final calibration: challenge classification, anti-burst
// (single-flight + cooldown), optional-vs-required semantics, provider
// invariant, fixture isolation, parser security. No live network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-cal-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { createPlan, resolveAdapter, buildPreview } = await import('../../server/applicationEngine/engine.js');
const { LeverInspectionAdapter, parseLeverForm, isChallengePage, InspectionFailure, LEVER_COOLDOWN_MS, resetInspectionState } = await import('../../server/applicationEngine/leverInspector.js');
const { requirementsFingerprint, INSPECTION_SUPPORT } = await import('../../server/applicationEngine/contract.js');
const { FixtureInspectionAdapter } = await import('../../server/applicationEngine/fixtureAdapter.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'eng-cal-user';

const FORM_HTML = (q: string) => `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required>
  <input type="hidden" name="accountId" value="x"><input type="hidden" name="origin" value="y">
  ${q}</form>`;
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing.</p><div class="cf-challenge"></div></body></html>';
const GENERIC_HTML = '<html><head><title>Something broke</title></head><body><p>No form here.</p></body></html>';

beforeEach(() => resetInspectionState());

const makeJob = (applyUrl: string, atsPlatform: string): Job => ({
  id: 'j-cal', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'Required: Kubernetes and AWS.', atsPlatform, jobUrl: applyUrl, applyUrl,
  url: applyUrl, source: atsPlatform === 'greenhouse' ? 'Greenhouse' : 'Lever', state: 'pending',
} as unknown as Job);

const makePackage = async (job: Job = makeJob('https://jobs.lever.co/veo/e1/apply', 'lever')) => {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
  p.contact = { city: 'Bengaluru', country: 'India' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  const cv: MasterCv = { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru', summary: 'DevOps', experiences: [], education: [], skills: [], certifications: [] };
  const fit = computeFit(p, cv, job, job.description || '');
  return buildPackage({ userId: USER, job, jd: job.description || '', profile: p, masterCv: cv, fit, tailoredVersion: {
    id: 't-cal', userId: USER, jobId: job.id, version: 1, masterCvUpdatedAt: 'cv1', profileUpdatedAt: 'p1', jdHash: 'jd1', fitEngineVersion: 3, tailorEngineVersion: 1,
    content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] }, verification: { passed: true, issues: [] }, stale: false, createdAt: new Date().toISOString(),
  } as any }, 'cv1');
};

describe('Challenge classification', () => {
  it('challenge page → PROVIDER_CHALLENGE (never FORM_CHANGED)', async () => {
    expect(isChallengePage(CHALLENGE_HTML)).toBe(true);
    expect(isChallengePage(GENERIC_HTML)).toBe(false);
    expect(isChallengePage(FORM_HTML(''))).toBe(false);
    const adapter = new LeverInspectionAdapter(1);
    vi.stubGlobal('fetch', async () => new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe('PROVIDER_CHALLENGE');
      expect(e.message).toContain('LEVER_CHALLENGE_PAGE');
    }
    vi.unstubAllGlobals();
  });

  it('generic malformed page stays FORM_CHANGED', async () => {
    const adapter = new LeverInspectionAdapter(1);
    vi.stubGlobal('fetch', async () => new Response(GENERIC_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe('FORM_CHANGED');
    }
    vi.unstubAllGlobals();
  });

  it('challenge causes exactly one GET — no retry storm', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(1);
    vi.stubGlobal('fetch', async () => { gets++; return new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }); });
    await expect(adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any)).rejects.toBeDefined();
    expect(gets).toBe(1);
    vi.unstubAllGlobals();
  });

  it('challenge never triggers fixture fallback in production', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', 'lever');
    const pkg = await makePackage(job);
    let gets = 0;
    vi.stubGlobal('fetch', async () => { gets++; return new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }); });
    try {
      await createPlan({ userId: USER, mode: 'production', pkg, job, artifactOk: true });
      expect.unreachable('fixture fallback must never happen');
    } catch (e: any) {
      expect(e.kind).toBe('PROVIDER_CHALLENGE');
    }
    expect(gets).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('Anti-burst: single-flight + cooldown', () => {
  it('two concurrent same-target inspections → ONE GET', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(60_000);
    vi.stubGlobal('fetch', async () => { gets++; await new Promise((r) => setTimeout(r, 20)); return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    const [a, b] = await Promise.all([
      adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any),
      adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any),
    ]);
    expect(a.fields.length).toBe(b.fields.length);
    expect(gets).toBe(1);
    vi.unstubAllGlobals();
  });

  it('second same-target inspection within cooldown → reuse, no second GET', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(60_000);
    vi.stubGlobal('fetch', async () => { gets++; return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    const again = await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    expect(gets).toBe(1);
    expect(again.fingerprint).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('different target → independent GET', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(60_000);
    vi.stubGlobal('fetch', async () => { gets++; return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    await adapter.inspect({ applyUrl: 'https://jobs.lever.co/spotify/y/apply' } as any);
    expect(gets).toBe(2);
    vi.unstubAllGlobals();
  });

  it('expired cooldown → GET allowed (form change still discoverable)', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(30);
    vi.stubGlobal('fetch', async () => { gets++; return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    await new Promise((r) => setTimeout(r, 60));
    await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    expect(gets).toBe(2);
    vi.unstubAllGlobals();
  });

  it('failed inspection cleans in-flight state (no stale promise)', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(1);
    vi.stubGlobal('fetch', async () => { gets++; if (gets === 1) return new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }); return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    await expect(adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any)).rejects.toMatchObject({ kind: 'PROVIDER_CHALLENGE' });
    const ok = await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    expect(ok.fields.length).toBeGreaterThan(0);
    expect(gets).toBe(2);
    vi.unstubAllGlobals();
  });

  it('challenge results are never cached as successful requirements', async () => {
    let gets = 0;
    const adapter = new LeverInspectionAdapter(60_000);
    vi.stubGlobal('fetch', async () => { gets++; if (gets === 1) return new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }); return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    await expect(adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any)).rejects.toMatchObject({ kind: 'PROVIDER_CHALLENGE' });
    const ok = await adapter.inspect({ applyUrl: 'https://jobs.lever.co/veo/x/apply' } as any);
    expect(ok.fields.length).toBeGreaterThan(0);
    expect(gets).toBe(2); // the failed attempt did not satisfy the cooldown
    vi.unstubAllGlobals();
  });
});

describe('Optional vs required unresolved semantics', () => {
  it('required unresolved increments Needs Input; optional does not', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', 'lever');
    const pkg = await makePackage(job);
    const html = FORM_HTML('<input name="cards[c1][field1]" type="text" required><input name="cards[c1][field2]" type="text">');
    const adapter = {
      provider: 'lever', detect: () => ({}), inspect: async () => ({ provider: 'lever', target: {} as any, fields: parseLeverForm(html).fields, discoveredAt: new Date().toISOString(), fingerprint: 'fp' }),
    };
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job, adapter: adapter as any, artifactOk: true });
    expect(plan.status).toBe('NEEDS_INPUT');
    const preview = buildPreview(plan, pkg);
    expect(preview.requiredUnresolvedCount).toBe(1);
    expect(preview.optionalUnresolvedCount).toBe(1);
    expect(preview.unresolved.some((u) => u.required)).toBe(true);
  });

  it('optional unresolved alone does NOT block READY_TO_SUBMIT', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', 'lever');
    const pkg = await makePackage(job);
    const html = FORM_HTML('<input name="cards[c1][field1]" type="text">');
    const adapter = {
      provider: 'lever', detect: () => ({}), inspect: async () => ({ provider: 'lever', target: {} as any, fields: parseLeverForm(html).fields, discoveredAt: new Date().toISOString(), fingerprint: 'fp' }),
    };
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job, adapter: adapter as any, artifactOk: true });
    expect(plan.status).toBe('READY_TO_SUBMIT');
    const preview = buildPreview(plan, pkg);
    expect(preview.requiredUnresolvedCount).toBe(0);
    expect(preview.optionalUnresolvedCount).toBe(1);
  });

  it('NEEDS_REVIEW + missing required inputs surfaces BOTH counts', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', 'lever');
    const pkg = await makePackage(job);
    const html = FORM_HTML('<input name="cards[c1][field1]" type="text" required><div data-qa="consent-section">consent</div>');
    const adapter = {
      provider: 'lever', detect: () => ({}), inspect: async () => ({ provider: 'lever', target: {} as any, fields: parseLeverForm(html).fields, discoveredAt: new Date().toISOString(), fingerprint: 'fp' }),
    };
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job, adapter: adapter as any, artifactOk: true });
    expect(plan.status).toBe('NEEDS_REVIEW'); // consent wins precedence
    const preview = buildPreview(plan, pkg);
    expect(preview.requiredUnresolvedCount).toBe(1); // still surfaced
    expect(preview.consent.length).toBe(1);
  });
});

describe('Provider invariant + fixture isolation', () => {
  it('Greenhouse provenance + Lever URL → Lever adapter, plan.provider=lever, REDIRECTED_SUPPORTED_TARGET', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', 'greenhouse');
    const pkg = await makePackage(job);
    let gets = 0;
    vi.stubGlobal('fetch', async () => { gets++; return new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }); });
    const { plan } = await createPlan({ userId: USER, mode: 'production', pkg, job, artifactOk: true });
    expect(plan.provider).toBe('lever');
    expect(plan.inspection?.adapter).toBe('LeverInspectionAdapter');
    const preview = buildPreview(plan, pkg);
    expect(preview.targetProvider).toBe('lever');
    expect(preview.targetClassification).toBe('REDIRECTED_SUPPORTED_TARGET');
    expect(gets).toBe(1);
    vi.unstubAllGlobals();
  });

  it('Unknown provenance + Lever URL → Lever adapter', async () => {
    const job = makeJob('https://jobs.lever.co/veo/e1/apply', undefined as any);
    const pkg = await makePackage(job);
    vi.stubGlobal('fetch', async () => new Response(FORM_HTML(''), { status: 200, headers: { 'content-type': 'text/html' } }));
    const { plan } = await createPlan({ userId: USER, mode: 'production', pkg, job, artifactOk: true });
    expect(plan.provider).toBe('lever');
    vi.unstubAllGlobals();
  });

  it('Lever provenance + unsupported URL → no Lever adapter, structured refusal', async () => {
    const job = makeJob('https://careers.company.com/x/apply', 'lever');
    const pkg = await makePackage(job);
    try {
      await createPlan({ userId: USER, mode: 'production', pkg, job, artifactOk: true });
      expect.unreachable();
    } catch (e: any) {
      expect(['UNSUPPORTED_TARGET', 'INSPECTION_NOT_IMPLEMENTED', 'INVALID_TARGET']).toContain(e.kind);
    }
  });

  it('Greenhouse/Ashby production → INSPECTION_NOT_IMPLEMENTED, never fixture', async () => {
    for (const platform of ['greenhouse', 'ashby']) {
      const job = makeJob('https://job-boards.greenhouse.io/acme/x', platform);
      const pkg = await makePackage(job);
      try {
        await createPlan({ userId: USER, mode: 'production', pkg, job, artifactOk: true });
        expect.unreachable('fixture must never run in production');
      } catch (e: any) {
        expect(e.kind).toBe('INSPECTION_NOT_IMPLEMENTED');
      }
    }
  });

  it('fixture injection impossible in production mode', () => {
    expect(() => resolveAdapter('lever', 'production', new FixtureInspectionAdapter('fixture-a-simple'))).toBeInstanceOf(Function);
    const a = resolveAdapter('lever', 'production', new FixtureInspectionAdapter('fixture-a-simple'));
    expect(a.constructor.name).toBe('LeverInspectionAdapter'); // injected fixture ignored in production
  });
});

describe('Parser security', () => {
  it('template __proto__/constructor payload → no pollution, safe parse', () => {
    const tpl = JSON.stringify({ id: 'c1', __proto__: { polluted: true }, constructor: { prototype: { x: 1 } }, fields: [{ type: 'text', text: 'ok?', required: true, id: 'f0' }] }).replace(/"/g, '&quot;');
    const html = `<form id="application-form"><input type="hidden" name="cards[c1][baseTemplate]" value="${tpl}"></form>`;
    const { fields } = parseLeverForm(html);
    expect(fields.some((f) => f.label === 'ok?')).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('massive label/option text is bounded', () => {
    const big = 'x'.repeat(50_000);
    const tpl = JSON.stringify({ id: 'c1', fields: [{ type: 'text', text: big, required: false, id: 'f0', options: [{ text: big }] }] }).replace(/"/g, '&quot;');
    const html = `<form id="application-form"><input type="hidden" name="cards[c1][baseTemplate]" value="${tpl}"></form>`;
    const { fields } = parseLeverForm(html);
    expect(fields[0].label.length).toBeLessThanOrEqual(300);
    if (fields[0].options?.length) expect(fields[0].options[0].length).toBeLessThanOrEqual(200);
  });

  it('script tags / unsafe labels are inert (text only, no execution)', () => {
    const tpl = JSON.stringify({ id: 'c1', fields: [{ type: 'text', text: '<script>window.__pwned=1</script>Gender?', required: false, id: 'f0' }] }).replace(/"/g, '&quot;');
    const html = `<form id="application-form"><input type="hidden" name="cards[c1][baseTemplate]" value="${tpl}"></form>`;
    const { fields } = parseLeverForm(html);
    expect(fields[0].label).toContain('<script>'); // preserved as text — never executed by the engine
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it('malformed template JSON → rendered-markup fallback or structured failure, never crash', () => {
    const html = `<form id="application-form"><input type="hidden" name="cards[c1][baseTemplate]" value="&quot;{not json}"><input name="cards[c1][field0]" type="text"></form>`;
    const { fields } = parseLeverForm(html);
    expect(fields.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Fingerprint semantics', () => {
  it('same semantic form with different tracking metadata → same fingerprint', () => {
    const a = parseLeverForm(FORM_HTML('<input name="cards[c1][field0]" type="text" required>'));
    const b = parseLeverForm(FORM_HTML('<input name="cards[c1][field0]" type="text" required>').replace('name="origin" value="y"', 'name="origin" value="different-tracking"'));
    expect(requirementsFingerprint('lever', 'jobs.lever.co', a.fields)).toBe(requirementsFingerprint('lever', 'jobs.lever.co', b.fields));
  });

  it('template.required wins over rendered input lacking required', () => {
    const tpl = JSON.stringify({ id: 'c1', fields: [{ type: 'text', text: 'Q?', required: true, id: 'f0' }] }).replace(/"/g, '&quot;');
    const html = `<form id="application-form"><input type="hidden" name="cards[c1][baseTemplate]" value="${tpl}"><input name="cards[c1][field0]" type="text"></form>`;
    const { fields } = parseLeverForm(html);
    expect(fields.find((f) => f.label === 'Q?')?.required).toBe(true);
  });
});

describe('Lever support capability', () => {
  it('support matrix: Lever read-only, others not implemented, nothing submission-capable', () => {
    expect(INSPECTION_SUPPORT.lever).toBe('READ_ONLY_INSPECTION_SUPPORTED');
    expect(INSPECTION_SUPPORT.greenhouse).toBe('INSPECTION_NOT_IMPLEMENTED');
    expect(INSPECTION_SUPPORT.ashby).toBe('INSPECTION_NOT_IMPLEMENTED');
    expect(Object.values(INSPECTION_SUPPORT)).not.toContain('SUBMISSION_SUPPORTED');
  });
});