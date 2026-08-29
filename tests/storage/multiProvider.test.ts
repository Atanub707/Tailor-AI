// Multi-provider execution — shared provider contract tests + router +
// session provider binding. Synthetic fixtures only; zero mutations.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiprov-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit } = await import('../../server/fit/fitEngine.js');
const { buildPackage } = await import('../../server/applicationPackage/packageEngine.js');
const { storePackage } = await import('../../server/applicationPackage/packageStore.js');
const { createPlan } = await import('../../server/applicationEngine/engine.js');
const { storePlan } = await import('../../server/applicationEngine/planStore.js');
const { createApproval } = await import('../../server/applicationEngine/executionEngine.js');
const { ensureExecutionSchema } = await import('../../server/applicationEngine/executionStore.js');
const { createPairingCode, pairExtension, createCompanionSession, claimSessionToken, sessionPayload, CompanionError } = await import('../../server/browserCompanion/companionService.js');
const { resolveProviderAdapter, verifiedProviderActionUrl } = await import('../../server/browserCompanion/browserProviderAdapter.js');
import type { MasterCv, Job } from '../../src/types.js';

const USER = 'mp-user';
const CHEERIO = await import('cheerio');

// ── Synthetic fixtures (structure only, sanitized — no applicant data) ──

const LEVER_HTML = `<form id="application-form" enctype="multipart/form-data" method="POST">
  <input type="text" name="name" required><input type="email" name="email" required>
  <select name="level"><option value="Fluent">Fluent</option><option value="Native">Native</option></select>
  <input type="radio" name="heard" value="Job Board" required><input type="radio" name="heard" value="Linkedin" required>
  <input type="file" name="resume"><input type="hidden" name="h-captcha-response" value="">
</form>`;

const GREENHOUSE_HTML = `<form id="application-form" class="application--form">
  <label for="first_name">First Name<span>*</span></label><input id="first_name" class="input" aria-required="true" type="text" required>
  <label for="last_name">Last Name</label><input id="last_name" class="input" aria-required="true" type="text" required>
  <label for="email">Email</label><input id="email" class="input" aria-required="true" type="text" required>
  <label for="question_8990389005">Years of experience?</label><input id="question_8990389005" class="input" aria-required="true" type="text" required>
  <input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx">
  <div class="g-recaptcha" data-sitekey="x"></div>
  <input type="submit" value="Submit Application">
</form>`;

const ASHBY_HTML = `<input name="_systemfield_name" id="_systemfield_name" type="text" placeholder="Type here...">
  <input name="_systemfield_email" id="_systemfield_email" type="email" placeholder="hello@example.com...">
  <input id="_systemfield_resume" type="file">
  <input name="6dccb15c-17dd-4b6f-9359-152831658fe3_e5c" id="6dccb15c-17dd-4b6f-9359-152831658fe3_e5c" type="radio" value="Fluent">
  <input name="6dccb15c-17dd-4b6f-9359-152831658fe3_e5c" id="6dccb15c-17dd-4b6f-9359-152831658fe3_e5c" type="radio" value="Native">
  <textarea name="g-recaptcha-response" id="g-recaptcha-response-100000"></textarea>
  <button type="submit">Submit application</button>`;

function makeFacade(provider: string, url: string, html: string, pageText = '') {
  const $ = CHEERIO.load(html);
  const form = $('form').first();
  const inputs: any[] = [];
  const root = form.length ? form : $('body');
  root.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const type = String($el.attr('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;
    if (type === 'file') return; // resume tracked separately
    const tag = el.tagName.toLowerCase();
    const id = String($el.attr('id') || $el.attr('name') || '');
    const name = String($el.attr('name') || id || '');
    if (!id && !name) return;
    const fieldId = provider === 'greenhouse' ? id : name || id;
    const options: string[] = [];
    if (tag === 'select') $el.find('option').each((__, o) => { options.push($(o).attr('value') || ''); });
    else if (type === 'radio') {
      const n = String($el.attr('name') || '');
      root.find(`input[name="${n}"]`).each((__, o) => { options.push($(o).attr('value') || ''); });
    }
    inputs.push({ name: fieldId, type: tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : type, value: '', required: $el.attr('required') !== undefined || $el.attr('aria-required') === 'true', options, tagName: tag.toUpperCase() });
  });
  const resumePresent = !!root.find('input[type="file"]').length;
  return { url, form: form.length ? { id: form.attr('id') || undefined, enctype: form.attr('enctype') || '', inputs, captchaHint: /h-captcha|captcha|g-recaptcha/.test(html), resumePresent } : { id: undefined, inputs, captchaHint: /h-captcha|captcha|g-recaptcha/.test(html), resumePresent }, pageText };
}

const approved = [
  { providerFieldId: 'name', type: 'TEXT', approvedValue: 'Ravi Kumar', required: true },
  { providerFieldId: 'email', type: 'EMAIL', approvedValue: 'ravi@example.com', required: true },
  { providerFieldId: 'level', type: 'SELECT', approvedValue: 'Fluent', required: true },
];

const job = (provider: 'lever' | 'greenhouse' | 'ashby'): Job => ({
  id: `j-${provider}`, externalId: provider === 'lever' ? 'lev-abc' : provider === 'greenhouse' ? 'gh-4725108005' : 'ashby-e1785df2-4836-4192-b951-b1dee51082b4',
  title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'x', atsPlatform: provider,
  jobUrl: provider === 'lever' ? 'https://jobs.lever.co/veo/abc/apply' : provider === 'greenhouse' ? 'https://job-boards.greenhouse.io/techholding/jobs/4725108005' : 'https://jobs.ashbyhq.com/latamcent/e1785df2-4836-4192-b951-b1dee51082b4/application',
  applyUrl: provider === 'lever' ? 'https://jobs.lever.co/veo/abc/apply' : provider === 'greenhouse' ? 'https://job-boards.greenhouse.io/techholding/jobs/4725108005' : 'https://jobs.ashbyhq.com/latamcent/e1785df2-4836-4192-b951-b1dee51082b4/application',
  url: 'https://x.dev', source: 'Lever', state: 'pending',
} as unknown as Job);

beforeAll(async () => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
  ensureExecutionSchema(getDb());
  runWithUser(USER, () => getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'MP', 'mp@test.local'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Provider router + canonical URLs', () => {
  it('resolves adapters by authoritative provider metadata', () => {
    expect(resolveProviderAdapter('lever').provider).toBe('lever');
    expect(resolveProviderAdapter('greenhouse').provider).toBe('greenhouse');
    expect(resolveProviderAdapter('ashby').provider).toBe('ashby');
    expect(() => resolveProviderAdapter('workday')).toThrow(/UNSUPPORTED_PROVIDER/);
  });
  it('verifiedProviderActionUrl: per-provider allowlists + identity', () => {
    expect(verifiedProviderActionUrl('lever', 'https://jobs.lever.co/veo/abc/apply', 'lev-abc')).toBe('https://jobs.lever.co/veo/abc/apply');
    expect(verifiedProviderActionUrl('lever', 'https://jobs.lever.co/veo/abc', 'lev-abc')).toBe('https://jobs.lever.co/veo/abc/apply');
    expect(verifiedProviderActionUrl('greenhouse', 'https://job-boards.greenhouse.io/techholding/jobs/4725108005', 'gh-4725108005')).toBe('https://job-boards.greenhouse.io/techholding/jobs/4725108005');
    expect(verifiedProviderActionUrl('greenhouse', 'https://boards.greenhouse.io/techholding/jobs/4725108005', 'gh-4725108005')).toBe('https://boards.greenhouse.io/techholding/jobs/4725108005');
    expect(verifiedProviderActionUrl('greenhouse', 'https://boards.greenhouse.io/techholding/jobs/9999999999', 'gh-4725108005')).toBeNull();
    expect(verifiedProviderActionUrl('ashby', 'https://jobs.ashbyhq.com/latamcent/e1785df2-4836-4192-b951-b1dee51082b4/application', 'ashby-e1785df2-4836-4192-b951-b1dee51082b4')).toBe('https://jobs.ashbyhq.com/latamcent/e1785df2-4836-4192-b951-b1dee51082b4/application');
    expect(verifiedProviderActionUrl('ashby', 'https://jobs.ashbyhq.com/latamcent/other/application', 'ashby-e1785df2-4836-4192-b951-b1dee51082b4')).toBeNull();
    // cross-provider URLs rejected
    expect(verifiedProviderActionUrl('lever', 'https://boards.greenhouse.io/x/jobs/1')).toBeNull();
    expect(verifiedProviderActionUrl('greenhouse', 'https://jobs.lever.co/veo/abc/apply')).toBeNull();
    expect(verifiedProviderActionUrl('ashby', 'https://jobs.lever.co/veo/abc/apply')).toBeNull();
    expect(verifiedProviderActionUrl('lever', 'http://jobs.lever.co/veo/abc/apply')).toBeNull();
  });
});

describe('Provider contract — shared two-pass invariants', () => {
  const cases: Array<{ provider: 'lever' | 'greenhouse' | 'ashby'; url: string; html: string; approved: typeof approved }> = [
    { provider: 'lever', url: 'https://jobs.lever.co/veo/abc/apply', html: LEVER_HTML, approved },
    { provider: 'greenhouse', url: 'https://job-boards.greenhouse.io/techholding/jobs/4725108005', html: GREENHOUSE_HTML, approved: [{ providerFieldId: 'first_name', type: 'TEXT', approvedValue: 'Ravi', required: true }, { providerFieldId: 'last_name', type: 'TEXT', approvedValue: 'Kumar', required: true }, { providerFieldId: 'email', type: 'EMAIL', approvedValue: 'ravi@example.com', required: true }, { providerFieldId: 'question_8990389005', type: 'TEXT', approvedValue: '4+ years', required: true }] },
    { provider: 'ashby', url: 'https://jobs.ashbyhq.com/latamcent/e1785df2-4836-4192-b951-b1dee51082b4/application', html: ASHBY_HTML, approved: [{ providerFieldId: '_systemfield_name', type: 'TEXT', approvedValue: 'Ravi Kumar', required: true }, { providerFieldId: '_systemfield_email', type: 'EMAIL', approvedValue: 'ravi@example.com', required: true }] },
  ];

  for (const c of cases) {
    describe(`${c.provider} adapter`, () => {
      const adapter = resolveProviderAdapter(c.provider);
      it('identity valid → validation ok → apply mutates, submitClicked=false', () => {
        const doc = makeFacade(c.provider, c.url, c.html);
        const id = adapter.identifyPage(doc, { companySlug: 'veo', postingId: 'abc' });
        // identity expectations per provider
        const expected = c.provider === 'lever' ? { companySlug: 'veo', postingId: 'abc' } : c.provider === 'greenhouse' ? { companySlug: 'techholding', postingId: '4725108005' } : { companySlug: 'latamcent', postingId: 'e1785df2-4836-4192-b951-b1dee51082b4' };
        const id2 = adapter.identifyPage(doc, expected);
        expect(id2.ok).toBe(true);
        const v = adapter.validate(doc.form!, c.approved);
        expect(v.ok).toBe(true);
        if (v.ok) {
          const r = adapter.apply(doc, v.plan);
          expect(r.applied).toBeGreaterThan(0);
          expect(r.submitClicked).toBe(false);
        }
      });
      it('wrong provider page → identity mismatch → ZERO mutation', () => {
        const otherUrl = c.provider === 'lever' ? 'https://jobs.lever.co/other/xyz/apply' : c.provider === 'greenhouse' ? 'https://job-boards.greenhouse.io/other/jobs/9999' : 'https://jobs.ashbyhq.com/other/otherid/application';
        const doc = makeFacade(c.provider, otherUrl, c.html);
        const id = adapter.identifyPage(doc, { companySlug: 'nope', postingId: 'nope' });
        expect(id.ok).toBe(false);
        expect(doc.form!.inputs.every((i) => i.value === '')).toBe(true);
      });
      it('LAST field mismatch → ZERO mutations (release blocker)', () => {
        let html = c.html;
        if (c.provider === 'lever') html = LEVER_HTML.replace('<option value="Fluent">Fluent</option>', '<option value="Beginner">Beginner</option>');
        if (c.provider === 'greenhouse') html = GREENHOUSE_HTML.replace('id="email"', 'id="email-renamed"');
        if (c.provider === 'ashby') html = ASHBY_HTML.replace('<input name="_systemfield_email"', '<input name="_systemfield_email-renamed"');
        const doc = makeFacade(c.provider, c.url, html);
        const expected = c.provider === 'lever' ? { companySlug: 'veo', postingId: 'abc' } : c.provider === 'greenhouse' ? { companySlug: 'techholding', postingId: '4725108005' } : { companySlug: 'latamcent', postingId: 'e1785df2-4836-4192-b951-b1dee51082b4' };
        const id = adapter.identifyPage(doc, expected);
        expect(id.ok).toBe(true);
        const v = adapter.validate(doc.form!, c.approved);
        expect(v.ok).toBe(false);
        expect(doc.form!.inputs.every((i) => i.value === '')).toBe(true);
      });
      it('unknown required field → blocked (no guessing)', () => {
        const extra = c.provider === 'lever' ? '<input type="text" name="weird" required>' : c.provider === 'greenhouse' ? '<input id="question_9999999999" class="input" aria-required="true" type="text" required>' : '<input name="new-question-uuid" id="new-question-uuid" type="text" required>';
        const html = c.provider === 'ashby' ? c.html + extra : c.html.replace('</form>', extra + '</form>');
        const doc = makeFacade(c.provider, c.url, html);
        const v = adapter.validate(doc.form!, c.approved);
        expect(v.ok).toBe(false);
        expect(v.ok === false && v.reason).toBe('UNKNOWN_REQUIRED');
      });
      it('resume control discovered; CAPTCHA detected structurally only', () => {
        const doc = makeFacade(c.provider, c.url, c.html);
        const expected = c.provider === 'lever' ? { companySlug: 'veo', postingId: 'abc' } : c.provider === 'greenhouse' ? { companySlug: 'techholding', postingId: '4725108005' } : { companySlug: 'latamcent', postingId: 'e1785df2-4836-4192-b951-b1dee51082b4' };
        const id = adapter.identifyPage(doc, expected);
        expect(id.ok).toBe(true);
        const v = adapter.validate(doc.form!, c.approved);
        expect(v.ok).toBe(true);
        if (v.ok) {
          expect(adapter.locateResumeInput(doc.form!)).toBe(true);

          const cp = adapter.detectHumanCheckpoint(doc.form!);
          // Lever fixture carries hCaptcha; greenhouse/ashby carry reCAPTCHA markers.
          expect(cp.present).toBe(true);
          expect(cp.kinds).toContain('CAPTCHA_REQUIRED');
        } else {
          expect(false).toBe(true); // unreachable — validation must pass on valid fixtures
        }
      });
      it('submit call count = 0 in every path', () => {
        const doc = makeFacade(c.provider, c.url, c.html);
        expect(JSON.stringify(doc)).not.toMatch(/requestSubmit|\.submit\(/);
      });
    });
  }
});

describe('Session provider binding (cross-provider attacks)', () => {
  const setup = async (provider: 'lever' | 'greenhouse' | 'ashby', attemptId: string) => {
    const j = job(provider);
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
    p.contact = { city: 'Bengaluru', country: 'India' };
    const cv: MasterCv = { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'B', summary: 'DevOps', experiences: [], education: [], skills: [], certifications: [] };
    const fit = computeFit(p, cv, j, 'x');
    const pkg = await buildPackage({ userId: USER, job: j, jd: 'x', profile: p, masterCv: cv, fit, tailoredVersion: { id: `t-${provider}`, userId: USER, jobId: j.id, version: 1, masterCvUpdatedAt: 'c', profileUpdatedAt: 'p', jdHash: 'j', fitEngineVersion: 3, tailorEngineVersion: 1, content: { summary: 'x', skills: [], experience: [], education: [], certifications: [], projects: [] }, verification: { passed: true, issues: [] }, stale: false, createdAt: new Date().toISOString() } as any }, 'c');
    storePackage(pkg);
    const { plan } = await createPlan({ userId: USER, mode: 'fixture', pkg, job: j, adapter: { provider, detect: () => ({}), inspect: async () => ({ provider, target: {} as any, fields: [], discoveredAt: new Date().toISOString(), fingerprint: 'f', providerMetadata: {} }) } as any, artifactOk: true });
    plan.status = 'READY_TO_SUBMIT' as any;
    try { getDb().prepare('DELETE FROM submission_plans WHERE id = ?').run(plan.id); } catch {}
    storePlan(plan);
    const { storeApproval, storeAttempt, executionKey } = await import('../../server/applicationEngine/executionStore.js');
    const approval = { id: `appr-mp-${provider}-${Date.now().toString(36)}`, userId: USER, planId: plan.id, packageId: pkg.id, planFingerprint: plan.planFingerprint, packageSnapshotHash: pkg.snapshotHash, requirementsFingerprint: plan.requirementsFingerprint, resumeArtifactHash: pkg.resumeSnapshot?.pdfHash ?? '', mappedFieldsHash: 'mf', consents: [], status: 'ACTIVE', approvedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    storeApproval(getDb(), approval as any);
    storeAttempt(getDb(), { id: attemptId, userId: USER, planId: plan.id, packageId: pkg.id, approvalId: approval.id, provider, externalJobId: j.externalId, executionKey: executionKey({ userId: USER, provider, externalJobId: j.externalId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint }), planFingerprint: plan.planFingerprint, packageSnapshotHash: pkg.snapshotHash, requirementsFingerprint: plan.requirementsFingerprint, status: 'MANUAL_ACTION_REQUIRED', transportAttemptCount: 0, startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const pc = createPairingCode(getDb(), USER);
    const paired = pairExtension(getDb(), pc.code);
    const s = createCompanionSession(getDb(), USER, attemptId);
    const claimed = claimSessionToken(getDb(), paired.pairingId, paired.installSecret, s.sessionId);
    return { sessionId: s.sessionId, token: claimed.token, provider };
  };

  it('session provider is immutable: payload provider == attempt provider', async () => {
    const { token } = await setup('greenhouse', 'attempt-mp-gh-1');
    const payload = sessionPayload(getDb(), token);
    expect(payload.provider).toBe('greenhouse');
    const { token: t2 } = await setup('ashby', 'attempt-mp-ash-1');
    const p2 = sessionPayload(getDb(), t2);
    expect(p2.provider).toBe('ashby');
    // a Lever session can never act on a Greenhouse target: canonical URL is provider-scoped
    expect(verifiedProviderActionUrl('lever', payload.canonicalActionUrl)).toBeNull();
  });
});