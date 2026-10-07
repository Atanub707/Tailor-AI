// Greenhouse adapter — deterministic scripts + guardrails (source-level).
// Mirrors the Lever invariants: foreign hosts rejected, submit only through
// the exact identified control, CAPTCHA never touched, positive-only
// confirmation markers, combobox picks handled by the act primitive.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const gh = require('../../desktop/main/greenhouseAdapter.cjs') as {
  parseLeverUrl: (u: string) => { canonical: string; siteSlug: string; postingId: string; isApplyPage: boolean } | null;
  buildObserveScript: () => string;
  buildActScript: (a: unknown) => string;
  buildSubmitScript: (o?: { trustedInput?: boolean }) => string;
  buildSubmitControlCheckScript: () => string;
  buildCheckpointScript: () => string;
  buildConfirmationScript: () => string;
  buildComboboxCheckScript: (ref: string) => string;
  buildMenuCheckScript: (ref: string) => string;
  validateAgentAction: (a: unknown) => unknown;
};
const sessionSrc = read('desktop/main/browserSession.cjs');

describe('Greenhouse URL parsing', () => {
  it('accepts job-boards + boards hosts, canonical form, numeric posting id', () => {
    const a = gh.parseLeverUrl('https://job-boards.greenhouse.io/andurilindustries/jobs/5209250007?gh_jid=5209250007');
    expect(a?.canonical).toBe('https://job-boards.greenhouse.io/andurilindustries/jobs/5209250007');
    expect(a?.siteSlug).toBe('andurilindustries');
    expect(a?.postingId).toBe('5209250007');
    expect(a?.isApplyPage).toBe(true);
    const b = gh.parseLeverUrl('https://boards.greenhouse.io/acme/jobs/1234567');
    expect(b?.canonical).toBe('https://boards.greenhouse.io/acme/jobs/1234567');
    const eu = gh.parseLeverUrl('https://job-boards.eu.greenhouse.io/proton/jobs/4996808101');
    expect(eu?.canonical).toBe('https://job-boards.eu.greenhouse.io/proton/jobs/4996808101');
    expect(eu?.siteSlug).toBe('proton');
  });

  it('rejects foreign hosts, http, job pages and malformed paths', () => {
    expect(gh.parseLeverUrl('https://evil.example.com/acme/jobs/1234567')).toBeNull();
    expect(gh.parseLeverUrl('http://jobs.greenhouse.io/acme/jobs/1234567')).toBeNull();
    expect(gh.parseLeverUrl('https://job-boards.greenhouse.io/acme')).toBeNull();
    expect(gh.parseLeverUrl('https://job-boards.greenhouse.io/acme/jobs/not-a-number')).toBeNull();
    expect(gh.parseLeverUrl('https://jobs.lever.co/acme/1234567')).toBeNull();
  });
});

describe('Greenhouse submit control — exact identity, exactly-once', () => {
  it('targets the form submit control with the exact label; single click call', () => {
    const sub = gh.buildSubmitScript();
    expect(sub).toContain("document.getElementById('application-form')");
    expect(sub).toContain("form.querySelector('button[type=\"submit\"]')");
    expect(sub).toContain('SUBMIT_CONTROL_DISABLED');
    expect(sub).toContain('SUBMIT_CONTROL_NOT_VISIBLE');
    expect(sub).toContain('submit application');
    expect((sub.match(/\.click\s*\(/g) || [])).toHaveLength(1);
    expect(sub).not.toMatch(/\.submit\s*\(|requestSubmit/i);
  });

  it('trusted-input mode measures the control and does not click', () => {
    const sub = gh.buildSubmitScript({ trustedInput: true });
    expect(sub).toContain('const useTrusted = true');
    expect(sub).toContain('getBoundingClientRect');
  });

  it('control-check validates without clicking', () => {
    const chk = gh.buildSubmitControlCheckScript();
    expect(chk).not.toContain('.click(');
  });
});

describe('Greenhouse guardrails', () => {
  it('act refuses submit controls and CAPTCHA nodes', () => {
    const act = gh.buildActScript({ action: 'click', ref: 'ta1' });
    expect(act).toContain('SUBMIT_REQUIRES_AUTHORIZED_PATH');
    expect(act).toContain('CAPTCHA_NEVER_TOUCHED');
  });

  it('combobox selection is type→listbox→pick (with full-list fallback)', () => {
    const act = gh.buildActScript({ action: 'type', ref: 'ta1', value: 'x' });
    expect(act).toContain('select__input');
    expect(act).toContain('[role="listbox"]');
    expect(act).toContain('OPTION_NOT_FOUND');
  });

  it('checkpoint tracks the recaptcha token + visible challenge only', () => {
    const cp = gh.buildCheckpointScript();
    expect(cp).toContain('g-recaptcha-response');
    expect(cp).toContain('captchaFieldFilled');
    expect(cp).not.toContain('.click(');
  });

  it('confirmation uses POSITIVE markers only (never formGone alone)', () => {
    const conf = gh.buildConfirmationScript();
    expect(conf).toContain('thank you for applying');
    expect(conf).toContain('already (applied|submitted)');
    expect(conf).toContain('const confirmed = successUrl || successText');
    expect(conf).not.toContain('confirmed = formGone');
    expect(conf).toContain('gracias por aplicar'); // multilingual (the Cobre confirmation was Spanish)
    expect(conf).toContain('confirmation'); // universal /confirmation route
  });

  it('observe is read-only and tags fields for the shared decision core', () => {
    const ob = gh.buildObserveScript();
    expect(ob).toContain('data-ta-ref');
    expect(ob).not.toContain('.click(');
    expect(ob).toContain("kind: 'custom-select'");
    expect(ob).toContain("kind: 'file'");
    expect(ob).toContain('byLabel'); // mirror-node dedupe (Country appears twice)
  });

  it('combobox uses the two-phase trusted-input protocol', () => {
    const act = gh.buildActScript({ action: 'type', ref: 'ta1', value: 'India' });
    expect(act).toContain('NEEDS_TRUSTED_OPEN');
    expect(act).toContain('NEEDS_TRUSTED_CLICK');
    expect(act).not.toContain('hit.click()');
    expect(sessionSrc).toContain("code === 'NEEDS_TRUSTED_OPEN'");
    expect(sessionSrc).toContain("code === 'NEEDS_TRUSTED_CLICK'");
    expect(sessionSrc).toContain('buildComboboxCheckScript');
  });

  it('menu lookup is SCOPED to the field — a stale foreign listbox never poisons other comboboxes', () => {
    const act = gh.buildActScript({ action: 'type', ref: 'ta1', value: 'x' });
    expect(act).toContain("el.getAttribute('aria-controls')");
    expect(act).not.toContain("document.querySelector('[role=\"listbox\"]')");
    // The intl-tel-input widget keeps a PERMANENT 244-option listbox in the
    // DOM — it must never be read as an open menu.
    expect(act).toContain('iti__country-list');
    const check = gh.buildMenuCheckScript('ta1');
    expect(check).toContain('aria-controls');
    expect(check).toContain('iti__country-list');
    expect(check).toContain('[data-ta-ref="ta1"]');
    expect(sessionSrc).toContain('buildMenuCheckScript');
  });

  it('observe groups radio/checkbox members under their legend; failures carry the real options', () => {
    const ob = gh.buildObserveScript();
    expect(ob).toContain('groupLabel: groupLabelFor(el)');
    expect(ob).toContain('legend');
    const act = gh.buildActScript({ action: 'type', ref: 'ta1', value: 'x' });
    expect(act).toContain('options: all.slice(0, 24)');
  });
});

describe('Redirected-host identity (boards → job-boards)', () => {
  it('identity compares the JOB (slug + posting id), not the hostname', () => {
    const session = read('desktop/main/browserSession.cjs');
    expect(session).toContain('const samePosting = !!(herr && planTarget');
    expect(session).toContain('herr.siteSlug === planTarget.siteSlug && herr.postingId === planTarget.postingId');
    // The live (redirected) canonical is adopted for later navigation checks.
    expect(session).toContain('this.canonical = herr.canonical; // adopt the REAL (redirected) host');
    // Both adapters parse both host forms to the same slug/id.
    const a = gh.parseLeverUrl('https://boards.greenhouse.io/acme/jobs/1234567');
    const b = gh.parseLeverUrl('https://job-boards.greenhouse.io/acme/jobs/1234567');
    expect(a?.siteSlug).toBe(b?.siteSlug);
    expect(a?.postingId).toBe(b?.postingId);
  });
});

describe('Session provider selection', () => {
  it('picks the adapter by URL and routes the agent path through it', () => {
    expect(sessionSrc).toContain("const greenhouseAdapter = require('./greenhouseAdapter.cjs')");
    expect(sessionSrc).toContain('get adapter()');
    expect(sessionSrc).toContain('this.adapter.buildObserveScript()');
    expect(sessionSrc).toContain('this.adapter.buildSubmitScript({ trustedInput: true })');
    expect(sessionSrc).toContain('this.adapter.parseLeverUrl');
  });

  it('resume attach accepts the Greenhouse id-based file input', () => {
    expect(sessionSrc).toContain('input[type="file"]#resume');
  });
});
