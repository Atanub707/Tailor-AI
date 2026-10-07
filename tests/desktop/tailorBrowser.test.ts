// Tailor Browser MVP — adapter, session, IPC, transport & security tests
// (Phase 42/43). Static + pure-unit: the Electron runtime is exercised live
// by `npm run desktop:smoke`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { selectBrowserTransport, tailorBrowserBridge } from '../../src/lib/browserExecutionTransport.js';

const require = createRequire(import.meta.url);
const lever = require('../../desktop/main/leverAdapter.cjs') as {
  parseLeverUrl: (u: string) => null | { siteSlug: string; postingId: string; isApplyPage: boolean; canonical: string };
  validatePlan: (p: unknown) => { ok: boolean; errors: string[]; url: unknown };
  buildIdentityScript: () => string;
  buildCheckpointScript: () => string;
  buildFillScript: (p: unknown) => string;
  buildReadBackScript: (p: unknown, w: unknown) => string;
  buildSubmitScript: (opts?: { trustedInput?: boolean }) => string;
  buildConfirmationScript: () => string;
  buildObserveScript: () => string;
  buildActScript: (a: unknown) => string;
  validateAgentAction: (a: unknown) => unknown;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const sessionSrc = read('desktop/main/browserSession.cjs');
const ipcSrc = read('desktop/main/ipc.cjs');
const mainSrc = read('desktop/main/main.cjs');
const preloadSrc = read('desktop/preload/preload.cjs');
const allDesktop = ['main.cjs', 'browserSession.cjs', 'ipc.cjs', 'leverAdapter.cjs'].map((f) => read(`desktop/main/${f}`)).join('\n') + preloadSrc;

const PLAN = {
  provider: 'lever',
  url: 'https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75/apply',
  postingId: '0606366a-67e0-4226-b5f9-ae92e3a66e75',
  fields: [{ providerFieldId: 'name', label: 'Full name', type: 'TEXT', approvedValue: 'Test User', required: true }],
};

describe('LeverAdapter — identity & plan validation', () => {
  it('parses and canonicalizes exact Lever postings', () => {
    const u = lever.parseLeverUrl(PLAN.url);
    expect(u?.canonical).toBe('https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75');
    expect(u?.isApplyPage).toBe(true);
    expect(lever.parseLeverUrl('https://evil.example.com/sfeir/x/apply')).toBeNull();
    expect(lever.parseLeverUrl('http://jobs.lever.co/sfeir/x/apply')).toBeNull();
  });

  it('post-submit routes (/thanks, /already-received) keep the posting canonical', () => {
    const thanks = lever.parseLeverUrl('https://jobs.lever.co/patchmypc/abc123/thanks');
    expect(thanks?.canonical).toBe('https://jobs.lever.co/patchmypc/abc123');
    expect(thanks?.isApplyPage).toBe(false);
    const dupe = lever.parseLeverUrl('https://jobs.lever.co/patchmypc/abc123/already-received');
    expect(dupe?.canonical).toBe('https://jobs.lever.co/patchmypc/abc123');
  });

  it('rejects plans for the wrong provider, wrong URL or wrong posting', () => {
    expect(lever.validatePlan({ ...PLAN, provider: 'greenhouse' }).ok).toBe(false);
    expect(lever.validatePlan({ ...PLAN, url: 'https://jobs.lever.co/sfeir/other-id/apply' }).errors).toContain('POSTING_MISMATCH');
    expect(lever.validatePlan({ ...PLAN, url: 'https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75' }).ok).toBe(false);
  });

  it('rejects malformed field values (renderer is untrusted)', () => {
    expect(lever.validatePlan({ ...PLAN, fields: [{ providerFieldId: 'name', approvedValue: { evil: true } }] }).errors).toContain('BAD_FIELD_VALUE');
    expect(lever.validatePlan({ ...PLAN, fields: [{ providerFieldId: '', approvedValue: 'x' }] }).errors).toContain('BAD_FIELD_ID');
    expect(lever.validatePlan(PLAN).ok).toBe(true);
  });

  it('wrong job is blocked at runtime (identity check before fill)', () => {
    expect(sessionSrc).toContain("emit('JOB_MISMATCH'");
    expect(sessionSrc).toContain('herr.canonical !== this.canonical');
  });

  it('navigation guard blocks any non-posting navigation', () => {
    expect(sessionSrc).toContain("wc.on('will-navigate'");
    expect(sessionSrc).toContain("emit(session, 'NAVIGATION_BLOCKED'");
  });
});

describe('Deterministic scripts — invariants (never submit, never bypass CAPTCHA)', () => {
  it('fill script never touches the submit control and never dispatches submit events', () => {
    const fill = lever.buildFillScript(PLAN);
    expect(fill).not.toContain('#btn-submit');
    expect(fill).not.toMatch(/\.submit\s*\(/);
    expect(fill).not.toContain('SubmitEvent');
    expect(fill).not.toMatch(/dispatchEvent\(new Event\('submit'/);
  });

  it('CAPTCHA is detected but NEVER interacted with', () => {
    const fill = lever.buildFillScript(PLAN);
    expect(fill).toContain('captchaPresent');
    expect(fill).not.toMatch(/h-captcha-response"\]\)?\s*\.value\s*=/);
    const cp = lever.buildCheckpointScript();
    expect(cp).toContain('captchaPresent');
    expect(cp).not.toMatch(/\.value\s*=/);
    expect(sessionSrc).not.toMatch(/grecaptcha|hcaptcha\.reset|\bsolve\s*\(/i); // read-only probes use 'resolve' — that's fine
  });

  it('AGENT observe is read-only, ref-tagged, and reports CAPTCHA/errors', () => {
    const ob = lever.buildObserveScript();
    expect(ob).toContain('data-ta-ref');
    expect(ob).toContain('captchaPresent');
    expect(ob).toContain('submitControl');
    expect(ob).not.toMatch(/\.click\s*\(|\.value\s*=/); // observation never mutates
  });

  it('AGENT act refuses submit controls and CAPTCHA; validation whitelists actions', () => {
    const act = lever.buildActScript({ action: 'click', ref: 'ta1' });
    expect(act).toContain('SUBMIT_REQUIRES_AUTHORIZED_PATH');
    expect(act).toContain('CAPTCHA_NEVER_TOUCHED');
    expect(lever.validateAgentAction({ action: 'type', ref: 'ta1', value: 'x' })).toBeTruthy();
    expect(lever.validateAgentAction({ action: 'check', ref: 'ta2', option: 'Days' })).toBeTruthy();
    expect(lever.validateAgentAction({ action: 'upload_resume', ref: 'ta3' })).toBeTruthy();
    expect(lever.validateAgentAction({ action: 'submit', ref: 'ta1' })).toBeNull();
    expect(lever.validateAgentAction({ action: 'click', ref: '../etc' })).toBeNull();
    expect(lever.validateAgentAction({ action: 'click', ref: 'ta1', value: 'x'.repeat(6000) })).toBeTruthy(); // value capped, not rejected
  });

  it('AGENT primitives are exposed on the bridge (only hands — no decisions)', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain("'/agent/observe'");
    expect(bridge).toContain("'/agent/act'");
  });

  it('AGENT mode is ON by default (opt-out) and the loop drives observe → decide → act', () => {
    const s = read('desktop/main/browserSession.cjs');
    expect(s).toContain("TAILOR_BROWSER_AGENT_MODE !== '0'");
    expect(s).toContain('async agentRun()');
    expect(s).toContain('async agentLoop()');
    expect(s).toContain('/api/auto-apply/agent/decide');
    expect(s).toContain("emit('HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED')");
    expect(s).toContain('async agentFinalRevalidation()');
  });

  it('QUESTIONS FIRST: chat-answerable asks hold every fill until answered', () => {
    const s = read('desktop/main/browserSession.cjs');
    const loop = s.slice(s.indexOf('async agentLoop()'), s.indexOf('async agentFinalRevalidation()'));
    expect(loop).toContain('const chatAsks = (decision.asks || []).filter((a) => a.human !== true)');
    // Fills run only when NO chat-answerable ask is pending.
    expect(loop).toContain('if (!chatAsks.length && decision.actions.length) {');
  });

  it('the ask-wait deadline is MUTABLE (const crashed the loop on the first question)', () => {
    const loop = sessionSrc.slice(sessionSrc.indexOf('async agentLoop()'), sessionSrc.indexOf('async agentFinalRevalidation()'));
    expect(loop).toContain('let deadline = Date.now()');
    expect(loop).toContain('deadline = Math.min(hardDeadline');
  });

  it('every pause path carries a waitReason (the row can say WHY it needs you)', () => {
    expect(sessionSrc).toContain("this.waitReason = 'VERIFICATION_REQUIRED'");
    expect(sessionSrc).toContain("this.waitReason = 'SUBMISSION_UNCONFIRMED'");
    expect(sessionSrc).toContain("this.waitReason = 'SUBMISSION_REJECTED'");
    // Submit-time CAPTCHA sets AND clears it (the run continues after solving).
    expect(sessionSrc).toContain("this.waitReason = 'CAPTCHA_REQUIRED'");
    expect(sessionSrc).toContain("this.waitReason = null");
  });

  it('a transient decision outage retries instead of killing the run', () => {
    const loop = sessionSrc.slice(sessionSrc.indexOf('async agentLoop()'), sessionSrc.indexOf('async agentFinalRevalidation()'));
    expect(loop).toContain('decideFailures += 1');
    expect(loop).toContain('decide unavailable');
  });

  it('OPTION_NOT_FOUND becomes a CHAT ask with the form\'s real options (choice asks)', () => {
    const loop = sessionSrc.slice(sessionSrc.indexOf('async agentLoop()'), sessionSrc.indexOf('async agentFinalRevalidation()'));
    expect(loop).toContain('CHOICE ASKS');
    expect(loop).toContain("entry.code !== 'OPTION_NOT_FOUND'");
    expect(loop).toContain('options: entry.options.slice(0, 24)');
    // The failed attempt is not hammered; a CHANGED value unlocks a retry.
    expect(loop).toContain('if (prevFail.sig === sig) continue;');
    expect(loop).toContain('this.lastFailures.delete(a.ref)');
  });

  it('the bridge passes the execution token to the session for decisions', () => {
    const b = read('desktop/main/desktopBridge.cjs');
    expect(b).toContain('statusToken: data.statusToken');
    expect(b).toContain('backendBase,');
  });

  it('read-back returns value-free statuses only', () => {
    const rb = lever.buildReadBackScript(PLAN, {});
    expect(rb).toContain("statuses.push('N')");
    expect(rb).toContain("'M'");
    expect(rb).not.toMatch(/console\.log\(.*value/);
  });

  it('submit script uses the exact Lever control and clicks exactly once', () => {
    const sub = lever.buildSubmitScript();
    expect(sub).toContain("document.getElementById('application-form')");
    expect(sub).toContain("form.querySelector('#btn-submit')");
    expect(sub).toContain('SUBMIT_CONTROL_DISABLED');
    expect(sub).toContain('SUBMIT_CONTROL_NOT_VISIBLE');
    expect((sub.match(/\.click\s*\(/g) || [])).toHaveLength(1);
    expect(sub).not.toMatch(/\.submit\s*\(|SubmitEvent/);
  });

  it('trusted-input mode measures the control and does not click programmatically', () => {
    const sub = lever.buildSubmitScript({ trustedInput: true });
    expect(sub).toContain('const useTrusted = true');
    expect(sub).toContain('getBoundingClientRect');
    expect(sessionSrc).toContain('Input.dispatchMouseEvent');
    expect(sessionSrc).toContain("this.adapter.buildSubmitScript({ trustedInput: true })");
  });

  it('location re-asserts the exact JSON shape Lever writes (selectedLocation)', () => {
    const sub = lever.buildSubmitScript();
    expect(sub).toContain("form.querySelector('#selected-location')");
    expect(sub).toContain('JSON.stringify({ name:');
  });

  it('late human CAPTCHA solves are captured (loop top + continue re-check confirmation)', () => {
    expect(sessionSrc).toContain("'AGENT_CONFIRMED'");
    const loop = sessionSrc.slice(sessionSrc.indexOf('async agentLoop()'), sessionSrc.indexOf('async agentFinalRevalidation()'));
    expect(loop.indexOf('buildConfirmationScript')).toBeGreaterThan(-1);
    const cont = sessionSrc.slice(sessionSrc.indexOf('async continueCheckpoint()'), sessionSrc.indexOf('async continueCheckpoint()') + 1500);
    expect(cont).toContain('buildConfirmationScript');
  });

  it('submit brings the view visible + window to front so the challenge can render', () => {
    const perf = sessionSrc.slice(sessionSrc.indexOf('async performSubmit()'), sessionSrc.indexOf('getState()'));
    expect(perf).toContain('setVisibleSession(this.executionId)');
    expect(lever.buildObserveScript()).toContain('visibility: String(document.visibilityState');
  });

  it('confirmation uses Lever\'s REAL success markers (never formGone alone)', () => {
    const conf = lever.buildConfirmationScript();
    expect(conf).toContain('application submitted');
    expect(conf).toContain('/thanks');
    expect(conf).toContain('already-received');
    expect(conf).toContain('confirmation-message');
    expect(sessionSrc).toContain('if (c.confirmed || c.duplicate)');
    expect(sessionSrc).not.toContain('if (c.confirmed || c.formGone)');
  });
});

describe('BrowserSessionManager — lifecycle, checkpoints, crash-safety', () => {
  it('has the full session state machine', () => {
    for (const s of ['IDLE', 'NAVIGATING', 'INSPECTING', 'FILLING', 'WAITING_FOR_USER', 'VERIFYING', 'READY_FOR_SUBMISSION', 'SUBMITTING', 'SUBMITTED', 'FAILED']) {
      expect(sessionSrc).toContain(`'${s}'`);
    }
  });

  it('resume uses the EXACT frozen artifact: hash checked before attach, file kept until dispose', () => {
    expect(sessionSrc).toContain('RESUME_HASH_MISMATCH');
    expect(sessionSrc).toContain("crypto.createHash('sha256')");
    expect(sessionSrc).toContain("dbg.sendCommand('DOM.setFileInputFiles'");
    // The artifact MUST stay on disk — Chromium reads it at SUBMIT time.
    expect(sessionSrc).toContain('this.tmpDirs.push(tmpDir)');
    expect(sessionSrc).not.toContain('rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }'); // never deleted in attachResume
    expect(sessionSrc).toContain('for (const d of this.tmpDirs || [])'); // cleaned on dispose only
    expect(sessionSrc).toContain('0o600');
  });

  it('checkpoint: pause → user solves in the real page → revalidate & resume (no bypass)', () => {
    expect(sessionSrc).toContain("emit('HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED')");
    expect(sessionSrc).toContain("emit('CHECKPOINT_CLEARED'");
    expect(sessionSrc).toContain('buildReadBackScript(this.currentPlan'); // full re-read-back after checkpoint
    expect(sessionSrc).toContain('CHECKPOINT_TIMEOUT_MS');
  });

  it('SUBMITTING / SUBMITTED_UNVERIFIED can never click again', () => {
    expect(sessionSrc).toContain('this.submitPerformed'); // exactly-once flag
    expect(sessionSrc).toContain("code: 'SUBMISSION_ALREADY_PERFORMED'");
    expect(sessionSrc).toContain("emit('SUBMISSION_UNCONFIRMED'");
    expect(sessionSrc).toContain("code: 'SUBMITTED_UNVERIFIED'");
    // the gate moved SERVER-side: single-use authorization CAS, never a local flag
    expect(sessionSrc).not.toContain('TAILOR_BROWSER_SUBMIT_ENABLED');
    expect(read('desktop/main/desktopBridge.cjs')).toContain('mark-submitting');
    expect(mainSrc).not.toContain('submitIfEnabled'); // smoke paths never submit
  });

  it('session partition is per-user and persisted', () => {
    expect(sessionSrc).toContain('persist:tailor-user-');
  });
});

describe('Desktop security (Phase 43)', () => {
  it('secure Electron defaults everywhere', () => {
    expect(mainSrc).toContain('contextIsolation: true');
    expect(mainSrc).toContain('nodeIntegration: false');
    expect(mainSrc).toContain('sandbox: true');
    expect(sessionSrc).toContain('nodeIntegration: false');
    expect(sessionSrc).toContain('contextIsolation: true');
    expect(sessionSrc).toContain('sandbox: true');
    expect(sessionSrc).toContain('webSecurity: true');
    expect(allDesktop).not.toMatch(/contextIsolation:\s*false|nodeIntegration:\s*true|sandbox:\s*false|webSecurity:\s*false/);
  });

  it('popups, downloads and permissions are denied by policy', () => {
    expect(sessionSrc).toContain('setWindowOpenHandler');
    expect(sessionSrc).toContain("action: 'deny'");
    expect(sessionSrc).toContain("on('will-download'");
    expect(sessionSrc).toContain('setPermissionRequestHandler');
  });

  it('no arbitrary code channel exists (no executeJavaScript over IPC)', () => {
    expect(ipcSrc).not.toContain('executeJavaScript');
    expect(preloadSrc).not.toContain('executeJavaScript');
    expect(ipcSrc).not.toMatch(/browser:execute|eval|new Function/);
    expect(preloadSrc).not.toMatch(/require\('fs'\)|child_process|ipcRenderer\.send\b/);
  });

  it('preload exposes exactly the narrow allowlist', () => {
    for (const k of ['createSession', 'runFill', 'resumeAfterCheckpoint', 'getState', 'show', 'hide', 'close', 'onEvent']) {
      expect(preloadSrc).toContain(k);
    }
    expect(preloadSrc).toContain("contextBridge.exposeInMainWorld('tailorBrowser'");
  });

  it('IPC validates the plan and resume bytes (untrusted renderer)', () => {
    expect(ipcSrc).toContain('lever.validatePlan(plan)');
    expect(ipcSrc).toContain('MAX_RESUME_BYTES');
    expect(ipcSrc).toContain("!== '%PDF-'");
  });

  it('never uses an iframe or a fake form anywhere in the desktop app', () => {
    expect(allDesktop).not.toMatch(/<iframe|srcdoc/i);
  });

  it('DevTools gated to development only', () => {
    expect(sessionSrc).toContain("TAILOR_BROWSER_DEVTOOLS === '1'");
  });
});

describe('Transport abstraction (Phase 30/31/32)', () => {
  it('tailor_browser wins when the exact preload bridge is present', () => {
    const bridge = { transport: 'tailor_browser', available: true, runFill: () => {} };
    expect(selectBrowserTransport(() => bridge)).toBe('tailor_browser');
    expect(tailorBrowserBridge(() => bridge)).not.toBeNull();
  });

  it('falls back to the LEGACY extension transport in normal browsers', () => {
    expect(selectBrowserTransport(() => undefined)).toBe('extension');
    expect(selectBrowserTransport(() => ({ transport: 'tailor_browser', available: true }))).toBe('extension'); // no runFill → not trusted
  });

  it('AutoApply routes desktop-first, then Chrome handoff; no tab opening remains', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    const desktopIdx = button.indexOf('if (desktopBridge) { await runDesktopFlow(); return; }');
    const handoffIdx = button.indexOf('await runChromeHandoffFlow();');
    expect(desktopIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeGreaterThan(desktopIdx);
    expect(button).not.toMatch(/window\.open\(/);
  });
});

describe('Eye / pane visibility — layout-only phase (Phase 3-17)', () => {
  const layoutSrc = read('desktop/main/layout.cjs');

  it('centralized layout: one layoutViews() used by resize + window states + IPC', () => {
    expect(mainSrc).toContain('function layoutViews()');
    expect(mainSrc).toContain("win.on('resize', layoutViews)");
    expect(mainSrc).toContain("win.on('maximize', layoutViews)");
    expect(mainSrc).toContain("win.on('enter-full-screen', layoutViews)");
    expect(mainSrc).toContain('safeLayout(');
  });

  it('Tailor shell is permanent: never removed by main, never hidden, never zeroed', () => {
    expect(mainSrc).not.toContain('removeChildView'); // only the session engine detaches views
    expect(mainSrc).not.toMatch(/tailorView\.setVisible\(false\)/);
    expect(mainSrc).toContain('Blank-screen guard');
    expect(read('desktop/main/layout.cjs')).toContain('TAILOR_BROWSER_LAYOUT_FALLBACK');
  });

  it('browser pane visibility is layout state only — hide touches no session state', () => {
    const hideStart = ipcSrc.indexOf("handle('browser:hide'");
    const hideEnd = ipcSrc.indexOf("handle('browser:setVisibility'");
    expect(hideStart).toBeGreaterThan(-1);
    const hideHandler = ipcSrc.slice(hideStart, hideEnd);
    expect(hideHandler).toContain('visible: false');
    for (const forbidden of ['close(', 'navigate', 'runFill', 'webContents']) {
      expect(hideHandler, `forbidden ${forbidden} in hide handler`).not.toContain(forbidden);
    }
    expect(ipcSrc).toContain("handle('browser:setVisibility'");
    expect(ipcSrc).toContain('paneVisible: typeof getAtsVisible');
    expect(preloadSrc).toContain('setVisibility');
  });

  it('hide/show responses carry the visibility contract to the renderer', () => {
    expect(ipcSrc).toContain('visible: true');
    expect(ipcSrc).toContain('visible: false');
    const button = read('src/components/AutoApplyButton.tsx');
    expect(button).not.toContain('Hide browser'); // embedded pane toggle retired with the legacy flow
  });
});

describe('Startup contract — real app, single instance, protocol (Phases 25-27)', () => {
  const pkg = JSON.parse(read('package.json'));
  const compose = read('docker-compose.yml');

  it('1/2. Electron entry points at the real Tailor Browser app', () => {
    expect(pkg.main).toBe('desktop/main/main.cjs');
    expect(pkg.scripts['desktop:dev']).toBe('electron .');
    expect(pkg.scripts['desktop:smoke']).toContain('electron .');
  });

  it('3/4/5. single-instance lock, focus-existing, protocol registration', () => {
    expect(mainSrc).toContain('app.requestSingleInstanceLock()');
    expect(mainSrc).toContain('TAILOR_BROWSER_DUPLICATE_LAUNCH');
    expect(mainSrc).toContain("app.on('second-instance'");
    expect(mainSrc).toContain('TAILOR_BROWSER_FOCUSED_EXISTING');
    expect(mainSrc).toContain("app.setAsDefaultProtocolClient('tailor-ai')");
    expect(mainSrc).toContain('TAILOR_BROWSER_PROTOCOL_REGISTERED');
    expect(mainSrc).toContain("intent === 'launch'");
    expect(mainSrc).toContain("intent === 'focus'");
  });

  it('25. startup proves the REAL app (READY + real UI title), not a default shell', () => {
    expect(mainSrc).toContain('TAILOR_BROWSER_READY');
    const readyAt = mainSrc.indexOf('TAILOR_BROWSER_READY');
    const ready = mainSrc.slice(readyAt - 700, readyAt + 200);
    expect(ready).toContain('document.title');
    expect(ready).toContain('TAILOR_UI_URL');
  });

  it('protocol URL carries launch/focus intent only — never execution data', () => {
    const start = mainSrc.indexOf('function handleProtocolIntent');
    const block = mainSrc.slice(start, start + 700);
    expect(block).not.toContain('runFill');
    expect(block).not.toContain('executionToken');
    expect(block).not.toContain('jobId');
  });

  it('6/7. bridge listening signal + transport flag config', () => {
    expect(mainSrc).toContain('TAILOR_DESKTOP_BRIDGE_LISTENING');
    expect(compose).toContain('AUTO_APPLY_EXECUTION_TRANSPORT=tailor_browser');
    expect(read('server/autoApply/autoApplyRouter.ts')).toContain('executionTransport');
  });
});

describe('Protocol ownership & app identity (senior bug-hunt phase)', () => {
  const pkg = JSON.parse(read('package.json'));

  it('packaged app owns the scheme; dev registration is opt-in (never steals tailor-ai://)', () => {
    expect(mainSrc).toContain('process.defaultApp');
    expect(mainSrc).toContain("process.env.TAILOR_BROWSER_DEV_PROTOCOL === '1'");
    expect(mainSrc).toContain('TAILOR_BROWSER_PROTOCOL_SKIP');
    expect(mainSrc).toContain("app.setAsDefaultProtocolClient('tailor-ai', process.execPath, [devAppPath])"); // dev opt-in only
    expect(mainSrc).toContain("app.setAsDefaultProtocolClient('tailor-ai');"); // packaged bundle
  });

  it('main entry marker + boot log + bootId exist (raw Electron detector)', () => {
    expect(mainSrc).toContain('TAILOR_MAIN_ENTRY_LOADED');
    expect(mainSrc).toContain('BOOT_ID');
    expect(mainSrc).toContain('boot.log');
    expect(mainSrc).toContain('TAILOR_BROWSER_READY');
  });

  it('cold-start intents are buffered, never dropped; activate creates the real window', () => {
    expect(mainSrc).toContain('pendingIntent');
    expect(mainSrc).toContain('TAILOR_BROWSER_INTENT_BUFFERED');
    expect(mainSrc).toContain('TAILOR_BROWSER_INTENT_APPLIED');
    expect(mainSrc).toContain("app.on('activate'");
    expect(mainSrc).toContain('ensureTailorBrowserWindow()');
  });

  it('packaged app identity: productName, appId, tailor-ai protocol in build config', () => {
    expect(pkg.build.productName).toBe('Tailor Browser');
    expect(pkg.build.appId).toBe('com.tailorai.browser');
    expect(pkg.build.protocols[0].schemes).toContain('tailor-ai');
    expect(pkg.scripts['desktop:package']).toContain('electron-builder');
  });

  it('bridge /health carries the tailor-browser identity + bootId', () => {
    const desktopBridgeSrc = read('desktop/main/desktopBridge.cjs');
    expect(desktopBridgeSrc).toContain("app: 'tailor-browser'");
    expect(desktopBridgeSrc).toContain('bootId');
  });

  it('Chrome interprets only the real identity and surfaces conflicts', () => {
    const transport = read('src/lib/browserExecutionTransport.ts');
    expect(transport).toContain('interpretHealth');
    expect(transport).toContain("d.app !== 'tailor-browser'");
    expect(read('src/components/AutoApplyButton.tsx')).toContain("Something else is using Taylor's connection");
  });

  it('AA still waits for health before any handoff (Phase 16 ordering intact)', () => {
    const health = buttonNoWs().indexOf('await desktopHealth()');
    const start = buttonNoWs().indexOf('startDesktopExecution(job.id');
    expect(health).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(health);
  });
});
function buttonNoWs(): string {
  return read('src/components/AutoApplyButton.tsx');
}

describe('Execution window — ATS only, never Tailor AI (regression)', () => {
  const pkg = JSON.parse(read('package.json'));

  it('default load is the LOCAL waiting shell; Tailor UI only behind the debug flag', () => {
    expect(mainSrc).toContain("const DEBUG_UI = process.env.TAILOR_DESKTOP_DEBUG_UI === '1'");
    expect(mainSrc).toContain('const shellTarget = DEBUG_UI ? TAILOR_UI_URL : SHELL_URL;');
    expect(mainSrc).toContain('loadURL(shellTarget)');
    expect(mainSrc).not.toContain('loadURL(TAILOR_UI_URL)');
    expect((mainSrc.match(/loadURL\(/g) || [])).toHaveLength(1); // single, gated load
  });

  it('shell page is local, branded Tailor Browser, and never references the Tailor UI', () => {
    const shell = read('desktop/renderer/shell.html');
    expect(shell).toContain('<title>Tailor Browser</title>');
    expect(shell).toContain('Waiting for Auto Apply job');
    expect(shell).not.toContain('127.0.0.1:3000');
    expect(shell).not.toContain('localhost:3000');
    expect(shell).not.toMatch(/<iframe/i);
  });

  it('shell ships with the packaged app', () => {
    expect(pkg.build.files).toContain('desktop/**/*');
  });

  it('window controls are hide/close only (no navigation capability)', () => {
    expect(ipcSrc).toContain("handle('browser:windowAction'");
    const block = ipcSrc.slice(ipcSrc.indexOf("handle('browser:windowAction'"), ipcSrc.indexOf("handle('browser:close'"));
    expect(block).toContain("action !== 'hide' && action !== 'close'");
    expect(block).not.toContain('navigate');
    expect(preloadSrc).toContain('windowAction');
  });

  it('execution overlays the FULL window (ATS-first UX); exactly ONE session visible at a time', () => {
    expect(mainSrc).toContain('manager.relayout()');
    expect(mainSrc).toContain('safeLayout({ width, height, paneVisible: false }).tailor');
    const sessionEngine = read('desktop/main/browserSession.cjs');
    expect(sessionEngine).toContain('setVisibleSession(executionId)');
    expect(sessionEngine).toContain('removeChildView(s.view)'); // detach the others
    expect(sessionEngine).toContain('addChildView(target.view)'); // attach the chosen one
  });

  it('handoff opens the exact selected job directly via the backend canonical URL', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain('/api/auto-apply/desktop-handoff/claim');
    expect(bridge).toContain('manager.createSession(');
    expect(read('desktop/main/browserSession.cjs')).toContain('await wc.loadURL(target.isApplyPage ? this.currentPlan.url');
  });
});

describe('Human-checkpoint resume + per-job browser lifecycle (this phase)', () => {
  const leverSrc = read('desktop/main/leverAdapter.cjs');
  const session = read('desktop/main/browserSession.cjs');
  const bridge = read('desktop/main/desktopBridge.cjs');
  const button = read('src/components/AutoApplyButton.tsx');

  it('checkpoint clear-detection probes BOTH token locations + explicit cleared flag', () => {
    expect(leverSrc).toContain('textarea[name="h-captcha-response"]');
    expect(leverSrc).toContain('input[name="h-captcha-response"]');
    expect(leverSrc).toContain('captchaFieldFilled');
    expect(leverSrc).toContain('cleared: captchaFieldFilled || !captchaPresent');
    // A passive (invisible) hCaptcha widget is NOT a checkpoint: pause only on
    // a visible widget/challenge so a silent widget can never dead-lock a run.
    expect(leverSrc).toContain('getBoundingClientRect');
    expect(leverSrc).toContain('iframe[title*="hCaptcha" i]');
  });

  it('post-checkpoint resume RE-FILLS wiped values, re-attaches the resume, then read-backs', () => {
    expect(session).toContain('async revalidateAfterCheckpoint()');
    expect(session).toContain('buildFillScript(this.currentPlan)');
    expect(session).toContain('reattachResumeIfNeeded');
    expect(session).toContain('buildReadBackScript(this.currentPlan');
  });

  it('the post-checkpoint path can never dead-end: bounded revalidation loop', () => {
    expect(session).toContain('this.checkpointAttempts < 25');
    expect(session).toContain("this.emit('HUMAN_ACTION_REQUIRED', 'VERIFICATION_REQUIRED')");
    expect(session).toContain('this.waitForCheckpoint(wasCorrect)');
  });

  it('manual Continue: bridge endpoint + Chrome action (guaranteed unblock)', () => {
    expect(bridge).toContain("'/auto-apply/continue'");
    expect(session).toContain('async continueCheckpoint()');
    expect(session).toContain("this.emit('CHECKPOINT_CLEARED', 'USER_CONTINUE')");
    // The row is one control: saving a chat answer nudges the agent to resume
    // immediately (idempotent; the concurrent-loop guard makes it safe).
    expect(button).toContain('continueDesktopExecution(currentExecution.executionId)');
    expect(session).toContain('if (this.loopRunning) return { ok: true, result: { ok: true, code: \'ALREADY_RUNNING\' } }');
    expect(read('desktop/main/desktopBridge.cjs')).toContain('/auto-apply/continue');
  });

  it('every job gets its OWN browser session (independent WebContentsView + adapter state)', () => {
    expect(session).toContain('makeView() {');
    expect(session).toContain('this.sessions.set(session.executionId, session)');
    expect(session).toContain("emit(session, 'SESSION_CREATED'");
    expect(session).toContain('backgroundThrottling: false'); // background jobs keep executing
  });

  it('the browser closes itself when the operation is done — never while waiting for you', () => {
    expect(session).toContain('AUTO_CLOSE_READY_MS = 10 * 60 * 1000'); // explicit-review window stays open
    expect(session).toContain('AUTO_CLOSE_FAILED_MS = 20_000');
    expect(session).toContain('scheduleAutoClose(AUTO_CLOSE_READY_MS)');
    expect(read('desktop/main/desktopBridge.cjs')).toContain("destroySession(executionId, 'APPLIED'), 3000"); // receipt persisted → grace → close
    const waitingBlocks = session.split("setState('WAITING_FOR_USER')").slice(1);
    expect(waitingBlocks.length).toBeGreaterThan(2);
    for (const b of waitingBlocks) expect(b.slice(0, 160)).not.toContain('scheduleAutoClose');
  });
});

describe('Explicit submission wiring — Chrome → bridge → desktop, exactly once', () => {
  const sessionSource = read('desktop/main/browserSession.cjs');
  const bridgeSource = read('desktop/main/desktopBridge.cjs');
  const adapterSource = read('desktop/main/leverAdapter.cjs');
  const serverS = read('server.ts');

  it('desktop submit is server-authorized; the old local env gate is gone', () => {
    expect(sessionSource).not.toContain('TAILOR_BROWSER_SUBMIT_ENABLED');
    expect(bridgeSource).toContain('/api/auto-apply/desktop-execution/mark-submitting');
    expect(bridgeSource).toContain('/api/auto-apply/desktop-execution/submitted');
    expect(sessionSource).toContain('async finalSubmitRevalidation()');
    expect(sessionSource).toContain('async performSubmit()');
  });

  it('CAPTCHA is never bypassed: revalidation blocks BEFORE any click', () => {
    const prep = sessionSource.slice(sessionSource.indexOf('async finalSubmitRevalidation()'), sessionSource.indexOf('async performSubmit()'));
    expect(prep).toContain("return { ok: false, code: 'CAPTCHA_REQUIRED' }");
    expect(prep).not.toContain('.click(');
  });

  it('the click happens exactly once, behind the submitPerformed guard', () => {
    const perf = sessionSource.slice(sessionSource.indexOf('async performSubmit()'), sessionSource.indexOf('getState()'));
    expect(perf.indexOf('this.submitPerformed = true')).toBeLessThan(perf.indexOf('buildSubmitScript()'));
    expect(perf).toContain("code: 'SUBMISSION_ALREADY_PERFORMED'");
  });

  it('the control-check script validates but never clicks', () => {
    const start = adapterSource.indexOf('function buildSubmitControlCheckScript()');
    const nextFn = adapterSource.indexOf('\nfunction ', start + 1);
    const block = adapterSource.slice(start, nextFn > start ? nextFn : adapterSource.indexOf('module.exports ='));
    expect(block).toContain("form.querySelector('#btn-submit')");
    expect(block).not.toContain('.click(');
  });

  it('server authorizes exactly once (CAS) and confirmation owns the receipt + Applied', () => {
    expect(serverS).toContain("'/api/auto-apply/desktop-execution/mark-submitting'");
    expect(serverS).toContain("'/api/auto-apply/desktop-execution/submitted'");
    const handoffSrc = read('server/autoApply/desktopHandoff.ts');
    expect(handoffSrc).toContain('submit_marked_at IS NULL');
    expect(handoffSrc).toContain('saveSubmissionReceipt(');
    expect(handoffSrc).toContain("state: 'applied'");
    expect(handoffSrc).toContain("state = 'SUBMITTED_VERIFIED'");
  });
});

describe('Nav routing + new-job visibility (bug-fix phase)', () => {
  it('every routed navigation item has a route case (no silent nav drops)', () => {
    const nav = read('src/navigation.tsx');
    const app = read('src/App.tsx');
    // only ids whose item declares a route (group headers have none)
    const ids = nav
      .split('\n')
      .filter((line) => line.includes("route: '/"))
      .map((line) => (line.match(/id: '([a-z-]+)'/) || [])[1])
      .filter(Boolean);
    expect(ids).toContain('answer-bank');
    for (const id of ids) {
      expect(app, `missing route case for nav item '${id}'`).toContain(`case '${id}':`);
    }
  });

  it('AA switches the VISIBLE session to the newly started job (no previous-job view)', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    const create = bridge.indexOf('manager.createSession({');
    const show = bridge.indexOf('manager.setVisibleSession(data.executionId);');
    expect(create).toBeGreaterThan(-1);
    expect(show).toBeGreaterThan(create); // the new job becomes visible right after creation
  });
});

describe('Stealth execution — the user is never redirected (this phase)', () => {
  it('the Tailor Browser window boots HIDDEN; only Eye/focus paths show it', () => {
    expect(mainSrc).toContain('show: false');
    expect(mainSrc).toContain('STEALTH');
    expect(mainSrc).toContain('function focusMain()'); // on-demand show for Eye/protocol
    expect(mainSrc).toContain('win.show()');
  });

  it('handoff start NEVER steals focus, but shows the right session when opened', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    const start = bridge.indexOf("path === '/auto-apply/start'");
    const end = bridge.indexOf("path === '/auto-apply/submit'");
    expect(start).toBeGreaterThan(-1);
    const block = bridge.slice(start, end);
    expect(block).not.toContain('onFocus('); // stealth: no focus steal on AA
    expect(block).toContain('manager.setVisibleSession(data.executionId)'); // Eye shows THIS job
    expect(block).toContain('bootId'); // crash-recovery binding
  });

  it('server claim supersedes executions from older app boots (no zombie BUSY)', () => {
    const serverS = read('server.ts');
    expect(serverS).toContain('supersedeOtherBootExecutions(getDb(), userId, bootId)');
    expect(read('server/autoApply/desktopHandoff.ts')).toContain("last_event = 'SUPERSEDED_NEW_APP_BOOT'");
  });
});

describe('Status telemetry — every state reaches Tailor AI (regression)', () => {
  it('non-terminal AND terminal states post with the session token; no stale single-session refs', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).not.toMatch(/\bcurrent\./); // the removed single-session variable must never reappear
    const posts = [...bridge.matchAll(/fetch\(STATUS_ENDPOINT,/g)].length;
    expect(posts).toBe(4); // terminal + non-terminal + heartbeat + SESSION_CLOSED self-heal
    expect(bridge).toContain('statusToken: entry.statusToken');
  });
});

describe('Status heartbeat — rows can never spin forever (regression)', () => {
  it('every active session state is re-posted every 5s until terminal', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain('function startHeartbeat()');
    expect(bridge).toContain('startHeartbeat();');
    expect(bridge).toContain('}, 5000);');
    expect(bridge).toContain('STATE_TO_EXECUTION');
    expect(bridge).toContain("WAITING_FOR_USER: 'WAITING_FOR_USER'");
    expect(bridge).toContain("clearInterval(heartbeat)");
  });
});

describe('Refusal reasons reach the row (regression)', () => {
  it('the bridge passes blockers/message through; the UI shows the real reason', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain('blockers: (data && data.blockers) || undefined');
    expect(bridge).toContain('message: (data && data.message) || undefined');
    const transport = read('src/lib/browserExecutionTransport.ts');
    expect(transport).toContain('blockers: Array.isArray(data?.blockers) ? data.blockers.map(String) : []');
    const button = read('src/components/AutoApplyButton.tsx');
    expect(button).toContain('aaReasonFromBlockers(started.blockers) || started.message');
    expect(button).not.toContain('reviewAvailable'); // Review IS the attention button now
    expect(button).not.toContain("setMessage('Tailor Browser could not start the run.')");
  });
});

describe('Slot exhaustion UX (the "loading forever" bug)', () => {
  it('same job can never spawn duplicate active sessions', () => {
    const serverS = read('server.ts');
    expect(serverS).toContain("error: 'ALREADY_ACTIVE'");
    expect(serverS).toContain('const existingForJob = actives.find((a) => a.jobId === jobId);');
  });

  it('queue is bounded (2 min) and ends in an explicit error with the active count', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    expect(button).toContain('Date.now() + 120_000');
    expect(button).toContain('No free Auto Apply slot');
    expect(button).toContain("retry.code === 'ALREADY_ACTIVE'");
  });
});

describe('Auto-submit (explicit opt-in) wiring', () => {
  it('a checkpoint-blocked auto attempt retries after the user resolves it', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain("['CAPTCHA_REQUIRED', 'VERIFICATION_FAILED', 'SUBMIT_NOT_AUTHORIZED'].includes(String(r.code))");
    expect(bridge).toContain('entry.autoSubmitted = false;');
  });
  it('the toggle exists and talks only to the preferences API', () => {
    const screen = read('src/components/AnswerBankScreen.tsx');
    expect(screen).toContain('Auto-submit verified applications');
    expect(screen).toContain("fetch('/api/auto-apply/preferences'");
    expect(screen).toContain("mode: next ? 'explicit_approval' : 'manual_review'");
  });
});

describe('Select-value safety (the PREPARE_FAILED bug)', () => {
  it('typed values resolve to the provider option text case-insensitively', () => {
    const builder = read('server/applicationEngine/leverPayloadBuilder.ts');
    expect(builder).toContain('function canonicalOption(');
    expect((builder.match(/canonicalOption\(/g) || []).length).toBeGreaterThanOrEqual(4); // def + 3 call sites
    expect(builder).toContain('`Value "${text}" not valid for ${f.label}. Allowed:'); // genuinely unknown values still block, with the options named
  });
  it('collected bank questions carry dropdown options for exact answering', () => {
    expect(read('server/autoApply/autoApplyService.ts')).toContain('options: u.options,');
  });
});

describe('Payload rejections + honest panel counts (the Wyetech case)', () => {
  it('a saved answer that is not a form option surfaces the allowed options', () => {
    const builder = read('server/applicationEngine/leverPayloadBuilder.ts');
    expect(builder).toContain('Allowed: ${(f.options || []).join');
    expect(builder).toContain('update it in Application Answers');
    const fill = read('server/autoApply/fillExecution.ts');
    expect(fill).toContain("blockers: ['SAVED_ANSWER_NOT_AN_OPTION']");
    expect(fill).toContain('message: msg');
  });
  it('the needs-input warning and plan status are computed AFTER bank resolution', () => {
    const svc = read('server/autoApply/autoApplyService.ts');
    expect(svc).toContain('const unresolvedAfterBank = requiredUnresolved.filter');
    expect(svc).toContain('const effectivePlanStatus = unresolvedAfterBank.length === 0');
    expect(svc).not.toContain('planStatus: plan.status,');
  });
});

describe('Transient provider resilience', () => {
  it('inspection retries once on 5xx/network before surfacing the error', () => {
    const inspector = read('server/applicationEngine/leverInspector.ts');
    expect(inspector).toContain('for (let attempt = 0; attempt < 2; attempt++)');
    expect(inspector).toContain("r.status >= 500 && attempt === 0");
  });
});
