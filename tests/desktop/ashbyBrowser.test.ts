// Ashby adapter — deterministic scripts + guardrails (source-level).
// Mirrors the Lever/Greenhouse invariants: foreign hosts rejected, submit only
// through the exact identified control, CAPTCHA never touched, positive-only
// confirmation markers, native radios clicked by option text.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const ash = require('../../desktop/main/ashbyAdapter.cjs') as {
  parseLeverUrl: (u: string) => { canonical: string; siteSlug: string; postingId: string; isApplyPage: boolean } | null;
  applySuffix: () => string;
  resumeSelector: () => string;
  buildObserveScript: () => string;
  buildActScript: (a: unknown) => string;
  buildSubmitScript: (o?: { trustedInput?: boolean }) => string;
  buildSubmitControlCheckScript: () => string;
  buildCheckpointScript: () => string;
  buildConfirmationScript: () => string;
  validateAgentAction: (a: unknown) => unknown;
};
const sessionSrc = read('desktop/main/browserSession.cjs');

describe('Ashby URL parsing', () => {
  it('accepts jobs.ashbyhq.com job + /application routes, canonical form', () => {
    const a = ash.parseLeverUrl('https://jobs.ashbyhq.com/gen-digital/0df7da23-6646-433d-8f52-bfdf9d9d3505/application');
    expect(a?.canonical).toBe('https://jobs.ashbyhq.com/gen-digital/0df7da23-6646-433d-8f52-bfdf9d9d3505');
    expect(a?.siteSlug).toBe('gen-digital');
    expect(a?.postingId).toBe('0df7da23-6646-433d-8f52-bfdf9d9d3505');
    expect(a?.isApplyPage).toBe(true);
    const b = ash.parseLeverUrl('https://jobs.ashbyhq.com/plane/674d263d-08a5-4d9e-bcc8-8cf41b6aefc0');
    expect(b?.isApplyPage).toBe(false);
    expect(b?.canonical).toBe('https://jobs.ashbyhq.com/plane/674d263d-08a5-4d9e-bcc8-8cf41b6aefc0');
  });

  it('rejects foreign hosts, http, and non-Ashby paths', () => {
    expect(ash.parseLeverUrl('https://jobs.lever.co/acme/1')).toBeNull();
    expect(ash.parseLeverUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toBeNull();
    expect(ash.parseLeverUrl('http://jobs.ashbyhq.com/acme/abc123')).toBeNull();
    expect(ash.parseLeverUrl('https://api.ashbyhq.com/posting-api/job-board/acme')).toBeNull();
    expect(ash.parseLeverUrl('https://jobs.ashbyhq.com/only-org')).toBeNull();
    expect(ash.parseLeverUrl('not a url')).toBeNull();
  });

  it('the form route is /application and the resume selector targets the system field', () => {
    expect(ash.applySuffix()).toBe('/application');
    expect(ash.resumeSelector()).toContain('_systemfield_resume');
  });
});

describe('Ashby observe + act', () => {
  it('observe is read-only, exposes systemfield ids, group legends, and the submit control', () => {
    const ob = ash.buildObserveScript();
    expect(ob).toContain('data-ta-ref');
    expect(ob).not.toContain('.click(');
    expect(ob).toContain("groupLabel: gLabel");
    expect(ob).toContain('submit application');
    expect(ob).toContain('formPresent: !!document.querySelector');
    expect(ob).toContain('jobClosed'); // removed/closed jobs fail honestly
    // File inputs sit behind custom upload buttons — never visibility-filtered.
    expect(ob.indexOf("type === 'file'")).toBeLessThan(ob.indexOf('if (!visible(el)) continue;'));
    expect(ob).toContain('recaptcha');
  });

  it('act refuses submit controls and CAPTCHA nodes; validation whitelists actions', () => {
    const act = ash.buildActScript({ action: 'click', ref: 'ta1' });
    expect(act).toContain('SUBMIT_REQUIRES_AUTHORIZED_PATH');
    expect(act).toContain('CAPTCHA_NEVER_TOUCHED');
    expect(ash.validateAgentAction({ action: 'type', ref: 'ta1', value: 'x' })).toBeTruthy();
    expect(ash.validateAgentAction({ action: 'check', ref: 'ta2', option: 'Yes' })).toBeTruthy();
    expect(ash.validateAgentAction({ action: 'upload_resume', ref: 'ta3' })).toBeTruthy();
    expect(ash.validateAgentAction({ action: 'submit', ref: 'ta1' })).toBeNull();
    expect(ash.validateAgentAction({ action: 'click', ref: '../etc' })).toBeNull();
  });

  it('text typing uses the trusted-input protocol (React state stays in sync)', () => {
    const act = ash.buildActScript({ action: 'type', ref: 'ta1', value: 'Atanu Biswas' });
    expect(act).toContain('NEEDS_TRUSTED_TYPE');
    expect(act).not.toContain('desc.set.call');
    expect(sessionSrc).toContain("code === 'NEEDS_TRUSTED_TYPE'");
  });

  it('radio check matches by OPTION TEXT (Ashby radio values are all "on")', () => {
    const act = ash.buildActScript({ action: 'check', ref: 'ta2', option: 'Yes' });
    expect(act).toContain("v !== 'on'");
    expect(act).toContain('optText');
    expect(act).toContain('g.click()');
  });

  it('native selects set the option + fire input/change (no synthetic typing)', () => {
    const act = ash.buildActScript({ action: 'type', ref: 'ta1', value: 'India' });
    expect(act).toContain('selectedIndex');
    expect(act).toContain("fire(el, ['input', 'change'])");
  });
});

describe('Ashby submission + confirmation', () => {
  it('submit uses the exact "Submit Application" control and clicks exactly once', () => {
    const sub = ash.buildSubmitScript();
    expect(sub).toContain('submit application');
    expect(sub).toContain('SUBMIT_CONTROL_DISABLED');
    expect(sub).toContain('SUBMIT_CONTROL_NOT_VISIBLE');
    expect((sub.match(/\.click\s*\(/g) || [])).toHaveLength(1);
    expect(sub).not.toMatch(/\.submit\s*\(|SubmitEvent/);
  });

  it('trusted-input mode measures the control and does not click programmatically', () => {
    const sub = ash.buildSubmitScript({ trustedInput: true });
    expect(sub).toContain('const useTrusted = true');
    expect(sub).toContain('getBoundingClientRect');
    expect(sessionSrc).toContain('Input.dispatchMouseEvent');
  });

  it('the control-check script validates but never clicks', () => {
    const check = ash.buildSubmitControlCheckScript();
    expect(check).not.toContain('.click(');
    expect(check).toContain('SUBMIT_CONTROL_DISABLED');
  });

  it('checkpoint tracks the recaptcha token + visible challenge only', () => {
    const cp = ash.buildCheckpointScript();
    expect(cp).toContain('g-recaptcha-response');
    expect(cp).toContain('captchaFieldFilled');
    expect(cp).not.toContain('.click(');
  });

  it('confirmation uses POSITIVE markers only (never formGone alone)', () => {
    const conf = ash.buildConfirmationScript();
    expect(conf).toContain('application (has been |was )?(successfully )?submitted');
    expect(conf).toContain('thank');
    expect(conf).toContain('already (applied|submitted)');
    expect(conf).toContain('gracias por');
    expect(conf).not.toContain('confirmed = formGone');
    expect(conf).toContain('const confirmed = successText');
  });
});

describe('Ashby session wiring', () => {
  it('the session selects the Ashby adapter by host and navigates to /application', () => {
    expect(sessionSrc).toContain("require('./ashbyAdapter.cjs')");
    expect(sessionSrc).toContain('ashbyhq');
    expect(sessionSrc).toContain('applySuffix');
  });

  it('resume attach uses the adapter resume selector (Ashby system field)', () => {
    expect(sessionSrc).toContain('resumeSelector');
    expect(sessionSrc).toContain('NO_RESUME_CONTROL');
  });

  it('provider gates: engine + policy + readiness + payload all accept ashby', () => {
    const engine = read('server/applicationEngine/engine.ts');
    expect(engine).toContain('AshbyInspectionAdapter');
    const policy = read('server/autoApply/submissionPolicy.ts');
    expect(policy).toContain("'lever', 'greenhouse', 'ashby'");
    const readiness = read('server/autoApply/submissionReadiness.ts');
    expect(readiness).toContain("['lever', 'greenhouse', 'ashby']");
    const handoff = read('server/autoApply/desktopHandoff.ts');
    expect(handoff).toContain("provider: 'lever' | 'greenhouse' | 'ashby'");
    expect(handoff).toContain("isAshby");
    const ui = read('src/lib/autoApply.ts');
    expect(ui).toContain('isAshbyJob');
  });
});
