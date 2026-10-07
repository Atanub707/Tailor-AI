'use strict';
// Tailor Browser — Multi-Session Execution Engine (MAIN PROCESS ONLY).
//
// One Session per job execution: own WebContentsView, own URL/attempt/state,
// own adapter lifecycle. The window shows ONE session at a time; the others
// stay alive but detached (backgroundThrottling disabled). Shared per-user
// partition so ATS logins/cookies carry across jobs.
const { WebContentsView, session: electronSession } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lever = require('./leverAdapter.cjs');
const greenhouseAdapter = require('./greenhouseAdapter.cjs');
const ashbyAdapter = require('./ashbyAdapter.cjs');

const STATES = [
  'IDLE', 'STARTING', 'NAVIGATING', 'READY', 'INSPECTING', 'FILLING', 'WAITING_FOR_USER',
  'VERIFYING', 'READY_FOR_SUBMISSION', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'CANCELLED', 'CLOSED',
];
const CHECKPOINT_POLL_MS = 2000;
const CHECKPOINT_TIMEOUT_MS = 15 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
// AGENT MODE (Phase 2): the session is driven by the decision loop
// (observe → server decide → act) instead of the per-field scripts. Default
// ON (both providers need it: Greenhouse has no scripted path); set
// TAILOR_BROWSER_AGENT_MODE=0 to fall back to the scripted Lever path.
const AGENT_MODE_ENABLED = process.env.TAILOR_BROWSER_AGENT_MODE !== '0';
const AUTO_CLOSE_FAILED_MS = 20_000;
const AUTO_CLOSE_SUBMITTED_MS = 12_000; // let the confirmation page render, then close
const AUTO_CLOSE_READY_MS = 10 * 60 * 1000; // explicit-review window stays open (10 min)

class Session {
  constructor(manager, { executionId, userId, attemptId, plan, resumeBytes, resumeSha256, resumeFilename, preAuthorizedSubmit }) {
    this.manager = manager;
    this.executionId = String(executionId);
    this.userId = String(userId || '');
    this.attemptId = String(attemptId || '');
    this.currentPlan = plan;
    this.lastResume = resumeBytes ? { bytes: resumeBytes, sha256: resumeSha256, filename: resumeFilename } : null;
    this.preAuthorizedSubmit = preAuthorizedSubmit === true;
    this.state = 'STARTING';
    this.canonical = null;
    this.checkpointTimer = null;
    this.autoCloseTimer = null;
    this.checkpointAttempts = 0;
    this.submitPerformed = false;
    this.view = null;
    this.pageUrl = '';
    this.crashed = false;
    this.agentMode = AGENT_MODE_ENABLED;
    this.statusToken = '';
    this.backendBase = '';
    this.pendingAsks = [];
    this.actFailures = new Map(); // sig -> consecutive failed attempts
    this.lastFailures = new Map(); // ref -> { code, sig, options } (choice asks)
    this.asksSig = null; // signature of the currently displayed ask set
    this.loopRunning = false;
    this.waitReason = null;
    this.tmpDirs = [];
    this.attached = false;
  }

  emit(type, detail = '') {
    this.manager.emit(this, type, detail);
  }

  setState(next) {
    if (!STATES.includes(next)) return;
    this.state = next;
    this.emit('STATE', next);
  }

  get wc() {
    return this.view ? this.view.webContents : null;
  }

  /** Provider adapter for THIS session (Lever/Greenhouse/Ashby), picked from the
   *  frozen plan URL first, then the live page URL. Same interface for all. */
  get adapter() {
    let url = '';
    try { url = String((this.currentPlan && this.currentPlan.url) || ''); } catch { /* ignore */ }
    try { const live = this.wc && this.wc.getURL(); if (live) url = String(live); } catch { /* ignore */ }
    if (/ashbyhq\.com/i.test(url)) return ashbyAdapter;
    return /greenhouse\.io/i.test(url) ? greenhouseAdapter : lever;
  }

  alive() {
    return !!this.view && !this.view.webContents.isDestroyed();
  }

  scheduleAutoClose(delayMs) {
    clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = setTimeout(() => {
      this.emit('BROWSER_CLOSED', 'operation finished');
      this.manager.destroySession(this.executionId, 'AUTO_CLOSE');
    }, delayMs);
  }

  dispose() {
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = null;
    // Resume artifacts live until the session closes (Chromium reads them at
    // submit time); clean up here.
    for (const d of this.tmpDirs || []) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    this.tmpDirs = [];
    try {
      if (this.view && !this.view.webContents.isDestroyed()) {
        try { if (this.view.webContents.debugger.isAttached()) this.view.webContents.debugger.detach(); } catch { /* ignore */ }
        this.view.webContents.close();
      }
    } catch { /* ignore */ }
    this.view = null;
    this.state = 'CLOSED';
  }

  /** Exact frozen resume bytes via CDP (real file, real change event, hash-verified). */
  async attachResume(bytes, expectedSha256, filename) {
    const wc = this.wc;
    const buf = Buffer.from(bytes);
    if (expectedSha256) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== String(expectedSha256).toLowerCase()) {
        this.emit('RESUME_ATTACHMENT_FAILED', 'hash-mismatch');
        return { ok: false, reason: 'RESUME_HASH_MISMATCH' };
      }
    }
    let tmpDir = null;
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const resumeSel = typeof this.adapter.resumeSelector === 'function'
        ? this.adapter.resumeSelector()
        : 'input[type="file"][name="resume"], input[type="file"]#resume';
      const { root } = await dbg.sendCommand('DOM.getDocument');
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: resumeSel });
      if (!nodeId) return { ok: false, reason: 'NO_RESUME_CONTROL' };
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-resume-'));
      // The file MUST stay on disk until the session closes: Chromium reads it
      // at SUBMIT time, not at attach time. Deleting it here caused every POST
      // to fail mid-upload (chrome-error page, no submission, no email).
      this.tmpDirs.push(tmpDir);
      const safeName = String(filename || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const filePath = path.join(tmpDir, safeName);
      fs.writeFileSync(filePath, buf, { mode: 0o600 });
      // React re-renders can swap the input node between the query and the
      // set — retry with a FRESH node each attempt and reset the input first
      // so a stale file list can never masquerade as 'attached'.
      const selJson = JSON.stringify(resumeSel);
      const verify = () => wc.executeJavaScript(
        `(() => { const i = document.querySelector(${selJson}); return i && i.files && i.files.length === 1 ? { name: i.files[0].name, size: i.files[0].size } : null; })()`,
        true
      );
      let attached = false;
      for (let attempt = 0; attempt < 3 && !attached; attempt++) {
        await wc.executeJavaScript(
          `(() => { const i = document.querySelector(${selJson}); if (i) { try { i.value = ''; } catch (e) {} } return true; })()`,
          true
        ).catch(() => {});
        const doc = await dbg.sendCommand('DOM.getDocument');
        const found = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: resumeSel });
        if (!found.nodeId) { await new Promise((r) => setTimeout(r, 300)); continue; }
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: found.nodeId });
        await new Promise((r) => setTimeout(r, 250));
        const check = await verify();
        if (check && check.size === buf.length) attached = true;
        else await new Promise((r) => setTimeout(r, 300));
      }
      if (!attached) {
        this.emit('RESUME_ATTACHMENT_FAILED', 'verify-failed');
        return { ok: false, reason: 'RESUME_VERIFY_FAILED' };
      }
      // NOTE: DOM.setFileInputFiles already fires native input/change events
      // (trusted) — extra SYNTHETIC events are deliberately NOT dispatched:
      // they trip the passive-listener React errors that break the form's
      // widgets on Greenhouse boards.
      this.emit('RESUME_ATTACHED', `bytes=${buf.length}`);
      return { ok: true };
    } catch (e) {
      this.emit('RESUME_ATTACHMENT_FAILED', String(e.message || e).slice(0, 80));
      return { ok: false, reason: 'RESUME_ATTACH_FAILED' };
    }
  }

  async reattachResumeIfNeeded() {
    if (!this.lastResume) return;
    try {
      const resumeSel = typeof this.adapter.resumeSelector === 'function'
        ? this.adapter.resumeSelector()
        : 'input[type="file"][name="resume"], input[type="file"]#resume';
      const has = await this.wc.executeJavaScript(
        `(() => { const i = document.querySelector(${JSON.stringify(resumeSel)}); return !!(i && i.files && i.files.length === 1); })()`,
        true
      );
      if (!has) await this.attachResume(this.lastResume.bytes, this.lastResume.sha256, this.lastResume.filename);
    } catch { /* attach failures are reported by attachResume itself */ }
  }

  finishVerification(rb) {
    const clean = rb.newRequiredCount === 0 && !/[MNBU]/.test(rb.statuses);
    if (!clean) {
      this.waitReason = 'VERIFICATION_REQUIRED';
      this.setState('WAITING_FOR_USER');
      this.emit('HUMAN_ACTION_REQUIRED', 'FILL_VERIFICATION_REQUIRED');
      return { ok: false, code: 'VERIFICATION_FAILED', statuses: rb.statuses };
    }
    this.setState('READY_FOR_SUBMISSION');
    this.emit('READY_FOR_REVIEW', `statuses=${rb.statuses}`);
    if (!this.preAuthorizedSubmit) this.scheduleAutoClose(AUTO_CLOSE_READY_MS);
    return { ok: true, statuses: rb.statuses };
  }

  async run() {
    if (this.agentMode) return this.agentRun();
    const wc = this.wc;
    try {
      const target = this.adapter.parseLeverUrl(this.currentPlan.url);
      this.canonical = target ? target.canonical : null;
      this.setState('NAVIGATING');
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('NAVIGATION_TIMEOUT')), NAV_TIMEOUT_MS);
        wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
        wc.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); reject(new Error(`NAVIGATION_FAILED:${code}:${String(desc).slice(0, 60)}`)); });
      });
      await wc.loadURL(target.isApplyPage ? this.currentPlan.url : `${this.canonical}${typeof this.adapter.applySuffix === 'function' ? this.adapter.applySuffix() : '/apply'}`);
      await loaded;
      this.emit('BROWSER_OPENED', this.canonical);

      const ident = await wc.executeJavaScript(this.adapter.buildIdentityScript(), true);
      const herr = this.adapter.parseLeverUrl(ident.href);
      if (!herr || herr.canonical !== this.canonical) {
        this.setState('FAILED');
        this.emit('JOB_MISMATCH', 'page identity differs from the frozen plan');
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: 'JOB_MISMATCH' };
      }
      this.emit('LEVER_VERIFIED', `${herr.siteSlug}/${herr.postingId}`);
      this.setState('INSPECTING');

      const fill = await wc.executeJavaScript(this.adapter.buildFillScript(this.currentPlan), true);
      if (!fill.ok) {
        this.setState('FAILED');
        this.emit('FILL_FAILED', `${fill.reason}:${(fill.failures || []).slice(0, 3).join('|')}`);
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: fill.reason, failures: fill.failures || [] };
      }
      this.emit('FORM_DISCOVERED', `fields=${this.currentPlan.fields.length}`);
      this.setState('FILLING');
      this.emit('FIELDS_FILLED', `count=${fill.filled}`);

      if (this.lastResume) {
        const r = await this.attachResume(this.lastResume.bytes, this.lastResume.sha256, this.lastResume.filename);
        if (!r.ok) this.emit('RESUME_NOT_ATTACHED', r.reason);
      } else {
        this.emit('RESUME_SKIPPED', 'no frozen artifact supplied');
      }

      this.setState('VERIFYING');
      const rb = await wc.executeJavaScript(this.adapter.buildReadBackScript(this.currentPlan, fill.wasCorrect), true);
      this.emit('FILL_VERIFICATION_COMPLETED', `statuses=${rb.statuses};newRequired=${rb.newRequiredCount}`);

      if (fill.captchaPresent) {
        this.waitReason = 'CAPTCHA_REQUIRED';
        this.setState('WAITING_FOR_USER');
        this.emit('HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
        return this.waitForCheckpoint(fill.wasCorrect);
      }
      return this.finishVerification(rb);
    } catch (e) {
      this.setState('FAILED');
      this.emit('RUN_FAILED', String(e.message || e).slice(0, 120));
      this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
      return { ok: false, code: 'RUN_FAILED' };
    }
  }

  /** WAITING_FOR_USER: watch the REAL page until the checkpoint clears. Only THIS job pauses. */
  waitForCheckpoint(wasCorrect) {
    this.checkpointStartedAt = Date.now();
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = setInterval(async () => {
      if (Date.now() - this.checkpointStartedAt > CHECKPOINT_TIMEOUT_MS) {
        clearInterval(this.checkpointTimer);
        this.checkpointTimer = null;
        this.emit('CHECKPOINT_TIMEOUT', 'cap 15m');
        return;
      }
      try {
        if (!this.alive()) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; return; }
        const cp = await this.wc.executeJavaScript(this.adapter.buildCheckpointScript(), true);
        if (cp.formGone) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; this.emit('FORM_GONE', 'page changed'); return; }
        const cleared = cp.cleared === true || !cp.captchaPresent || cp.captchaFieldFilled;
        if (cleared) {
          clearInterval(this.checkpointTimer);
          this.checkpointTimer = null;
          const result = await this.revalidateAfterCheckpoint();
          if (result && result.ok !== true && this.checkpointAttempts < 25) {
            this.checkpointAttempts += 1;
            this.waitReason = 'VERIFICATION_REQUIRED';
            this.setState('WAITING_FOR_USER');
            this.emit('HUMAN_ACTION_REQUIRED', 'VERIFICATION_REQUIRED');
            this.waitForCheckpoint(wasCorrect);
          }
        }
      } catch { /* transient during user interaction — keep polling */ }
    }, CHECKPOINT_POLL_MS);
    return { ok: true, pending: true, checkpoint: 'CAPTCHA_REQUIRED' };
  }

  /** After a human checkpoint: revalidate identity, RE-FILL wiped values, re-attach resume, read-back. */
  async revalidateAfterCheckpoint() {
    this.waitReason = null;
    const wc = this.wc;
    const ident = await wc.executeJavaScript(this.adapter.buildIdentityScript(), true);
    const herr = this.adapter.parseLeverUrl(ident.href);
    if (!herr || herr.canonical !== this.canonical) {
      this.setState('FAILED');
      this.emit('JOB_MISMATCH', 'page changed after checkpoint');
      this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
      return { ok: false, code: 'JOB_MISMATCH' };
    }
    const refill = await wc.executeJavaScript(this.adapter.buildFillScript(this.currentPlan), true);
    if (refill.ok) this.emit('FIELDS_FILLED', `count=${refill.filled};refill`);
    await this.reattachResumeIfNeeded();
    const rb = await wc.executeJavaScript(this.adapter.buildReadBackScript(this.currentPlan, (refill && refill.wasCorrect) || {}), true);
    this.emit('FILL_VERIFICATION_COMPLETED', `statuses=${rb.statuses};newRequired=${rb.newRequiredCount};revalidated`);
    return this.finishVerification(rb);
  }

  /** Manual unblock: "I completed the challenge — revalidate now." */
  async continueCheckpoint() {
    if (this.agentMode) {
      if (this.loopRunning) return { ok: true, result: { ok: true, code: 'ALREADY_RUNNING' } };
      if (this.state !== 'WAITING_FOR_USER') return { ok: false, code: 'NOT_WAITING' };
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
      this.emit('CHECKPOINT_CLEARED', 'USER_CONTINUE');
      // The user may have solved a CAPTCHA after the submit watch expired and
      // the POST already landed on Lever's success page — capture it first.
      const conf = await this.wc.executeJavaScript(this.adapter.buildConfirmationScript(), true).catch(() => null);
      if (conf && (conf.confirmed || conf.duplicate)) {
        this.setState('SUBMITTED');
        this.emit('SUBMISSION_CONFIRMED', conf.duplicate ? 'ALREADY_APPLIED' : (conf.evidence || 'SUCCESS_TEXT'));
        this.scheduleAutoClose(AUTO_CLOSE_SUBMITTED_MS);
        return { ok: true, result: { ok: true, code: 'AGENT_CONFIRMED' } };
      }
      this.setState('INSPECTING');
      const loop = await this.agentLoop();
      return { ok: true, result: loop };
    }
    if (this.state !== 'WAITING_FOR_USER' || !this.currentPlan) return { ok: false, code: 'NOT_WAITING' };
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.emit('CHECKPOINT_CLEARED', 'USER_CONTINUE');
    const result = await this.revalidateAfterCheckpoint();
    if (result && result.ok !== true && this.checkpointAttempts < 25) {
      this.checkpointAttempts += 1;
      this.waitReason = 'VERIFICATION_REQUIRED';
      this.setState('WAITING_FOR_USER');
      this.emit('HUMAN_ACTION_REQUIRED', 'VERIFICATION_REQUIRED');
      this.waitForCheckpoint({});
    }
    return { ok: true, result };
  }

  /** AGENT PRIMITIVE (read-only): compact page inventory for the decision loop. */
  async observe() {
    if (!this.alive()) return { ok: false, code: 'NO_SESSION' };
    try {
      const state = await this.wc.executeJavaScript(this.adapter.buildObserveScript(), true);
      return { ok: true, state };
    } catch (e) {
      return { ok: false, code: 'OBSERVE_FAILED', message: String(e && e.message ? e.message : e).slice(0, 160) };
    }
  }

  /** AGENT PRIMITIVE (mutating): ONE validated action. Resume upload uses CDP. */
  /** Browser-level trusted click in CSS pixels. Electron's sendInputEvent
   *  mis-scales coordinates on HiDPI (dpr≠1) views — the debugger Input
   *  domain hits exactly where the page measured. */
  async trustedClick(x, y) {
    const wc = this.wc;
    const dbg = wc.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached */ }
    const cx = Math.round(x);
    const cy = Math.round(y);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await new Promise((res) => setTimeout(res, 60));
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
  }

  /** Trusted keyboard typing: select-all (replace prior search text) then
   *  Input.insertText — real keyboard input, safe for react-select. */
  async trustedType(text) {
    const wc = this.wc;
    const dbg = wc.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached */ }
    const value = String(text || '').slice(0, 200);
    if (!value) return;
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await dbg.sendCommand('Input.insertText', { text: value });
  }

  /** Clear a combobox's search text (select-all + delete) so the FULL option
   *  list can be read — a typed filter that matches nothing must not hide the
   *  choices the user needs to pick from. */
  async trustedClear() {
    const dbg = this.wc.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached */ }
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  }

  /** Focus a tagged element via the DOM domain — no coordinates, immune to
   *  layout shifts (the page settles late and moves fields between measure
   *  and click). */
  async trustedFocus(ref) {
    const dbg = this.wc.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached */ }
    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-ta-ref="${String(ref)}"]` });
    if (!nodeId) return false;
    await dbg.sendCommand('DOM.focus', { nodeId });
    return true;
  }

  /** Trusted key press (no coordinates). */
  async trustedKey(key, code, keyCode) {
    const dbg = this.wc.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { /* already attached */ }
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async act(action) {
    if (!this.alive()) return { ok: false, code: 'NO_SESSION' };
    const safe = this.adapter.validateAgentAction(action);
    if (!safe) return { ok: false, code: 'BAD_ACTION' };
    if (safe.action === 'upload_resume') {
      if (!this.lastResume) return { ok: false, code: 'NO_RESUME_ARTIFACT' };
      const r = await this.attachResume(this.lastResume.bytes, this.lastResume.sha256, this.lastResume.filename);
      return r.ok ? { ok: true, uploaded: true } : { ok: false, code: r.reason || 'UPLOAD_FAILED' };
    }
    try {
      let r = await this.wc.executeJavaScript(this.adapter.buildActScript(safe), true);
      // Combobox phase 1: synthetic events cannot open react-select menus in
      // this environment (passive-listener handler failures) — open with a
      // REAL mouse click on the measured control. (Trusted ArrowDown is
      // ignored by this widget: verified via CDP that aria-expanded stays
      // false, so the click is the opener; ArrowDown remains a fallback.)
      if (r && r.ok !== true && r.code === 'NEEDS_TRUSTED_OPEN') {
        let opened = false;
        const menuOpen = () => this.wc.executeJavaScript(
          typeof this.adapter.buildMenuCheckScript === 'function'
            ? this.adapter.buildMenuCheckScript(safe.ref)
            : `(() => !!document.querySelector('[role="listbox"]'))()`,
          true
        ).catch(() => false);
        // EXACTLY ONE trusted click: a second click TOGGLES the menu closed.
        // The fresh measurement comes from the page right before the click.
        let point = r.rect && r.rect.w > 0 ? { x: r.rect.x, y: r.rect.y } : null;
        if (typeof this.adapter.buildControlRectScript === 'function') {
          const fresh = await this.wc.executeJavaScript(this.adapter.buildControlRectScript(safe.ref), true).catch(() => null);
          if (fresh && Number.isFinite(fresh.x) && Number.isFinite(fresh.y)) point = fresh;
        }
        if (point) {
          try {
            await this.trustedClick(point.x, point.y);
          } catch { /* fall through to the keyboard opener */ }
          await new Promise((res) => setTimeout(res, 500));
          opened = !!(await menuOpen());
        }
        if (!opened) {
          // Keyboard opener fallback (other react-select builds honor it).
          const ok = await this.trustedFocus(safe.ref).catch(() => false);
          if (ok) {
            await new Promise((res) => setTimeout(res, 80));
            await this.trustedKey('ArrowDown', 'ArrowDown', 40);
            await new Promise((res) => setTimeout(res, 320));
          }
          opened = !!(await menuOpen());
        }
        // Filter with trusted typing so the option list is deterministic.
        if (opened && safe.action === 'type' && safe.value) {
          await this.trustedType(safe.value);
          await new Promise((res) => setTimeout(res, 400));
        }
        r = await this.wc.executeJavaScript(this.adapter.buildActScript(safe), true);
      }
      // A typed filter that matches NOTHING ("No options") hides the real
      // choice list. Clear it and read the FULL menu — the user's pick (or a
      // choice ask carrying the real options) needs the full list.
      if (r && r.ok !== true && r.code === 'OPTION_NOT_FOUND') {
        let emptyFilter = false;
        try {
          const d = JSON.parse(r.message || '{}');
          emptyFilter = d.menu === true && (!Array.isArray(d.options) || d.options.length === 0);
        } catch { /* no diag */ }
        if (emptyFilter) {
          try { await this.trustedClear(); } catch { /* best-effort */ }
          await new Promise((res) => setTimeout(res, 450));
          r = await this.wc.executeJavaScript(this.adapter.buildActScript(safe), true);
        }
      }
      // Trusted typing: click the field, Input.insertText, read back. No
      // synthetic events (they break the form's React widgets on this page).
      if (r && r.ok !== true && r.code === 'NEEDS_TRUSTED_TYPE' && safe.action === 'type') {
        const want = String(safe.value == null ? '' : safe.value);
        const readBack = () => this.wc.executeJavaScript(
          `(() => { const el = document.querySelector('[data-ta-ref="${safe.ref}"]'); return el ? String(el.value || '') : ''; })()`, true
        ).catch(() => '');
        for (let attempt = 0; attempt < 3; attempt++) {
          const ok = await this.trustedFocus(safe.ref).catch(() => false);
          if (!ok) { await new Promise((res) => setTimeout(res, 250)); continue; }
          await new Promise((res) => setTimeout(res, 80));
          await this.trustedType(want);
          await new Promise((res) => setTimeout(res, 150));
          const got = String(await readBack()).trim();
          if (got === want.trim()) return { ok: true, value: got.slice(0, 120) };
        }
        return { ok: false, code: 'TYPE_VERIFY_FAILED' };
      }
      // Combobox phase 2: the option is clicked with REAL input at the rect
      // the act script measured (keyboard navigation is unreliable in this
      // widget — keep it only as fallback). Verify through .select__single-value.
      if (r && r.ok !== true && r.code === 'NEEDS_TRUSTED_CLICK' && typeof this.adapter.buildComboboxCheckScript === 'function') {
        const want = String(safe.value == null ? '' : safe.value);
        const readPick = async () => {
          const check = await this.wc.executeJavaScript(this.adapter.buildComboboxCheckScript(safe.ref), true).catch(() => null);
          return check && String(check.value || '').trim();
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          if (r.rect && r.rect.w > 0) {
            try {
              await this.trustedClick(r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2);
            } catch { /* fall through to the keyboard path */ }
            await new Promise((res) => setTimeout(res, 320));
            const picked = await readPick();
            if (picked) return { ok: true, value: String(picked).slice(0, 120) };
          }
          // Re-measure: the menu may have re-rendered (or reopened) after the click.
          r = await this.wc.executeJavaScript(this.adapter.buildActScript(safe), true).catch(() => r);
          if (!r || r.code !== 'NEEDS_TRUSTED_CLICK' || !r.rect) break;
        }
        // Fallback: keyboard selection (focus + filter + arrows + Enter).
        const index = Number.isFinite(r.index) && r.index >= 0 ? r.index : 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          const ok = await this.trustedFocus(safe.ref).catch(() => false);
          if (ok) {
            await new Promise((res) => setTimeout(res, 80));
            await this.trustedType(want); // trusted filter (replaces any prior text)
            await new Promise((res) => setTimeout(res, 350));
            for (let i = 0; i <= index; i++) {
              await this.trustedKey('ArrowDown', 'ArrowDown', 40);
              await new Promise((res) => setTimeout(res, 60));
            }
            await this.trustedKey('Enter', 'Enter', 13);
            await new Promise((res) => setTimeout(res, 250));
          }
          const picked = await readPick();
          if (picked) return { ok: true, value: String(picked).slice(0, 120) };
        }
        return { ok: false, code: 'OPTION_NOT_SELECTED' };
      }
      return r;
    } catch (e) {
      return { ok: false, code: 'ACT_FAILED', message: String(e && e.message ? e.message : e).slice(0, 160) };
    }
  }

  /** FINAL submit revalidation: identity → CAPTCHA cleared → refill → clean read-back → control. */
  async finalSubmitRevalidation() {
    if (this.agentMode) return this.agentFinalRevalidation();
    const wc = this.wc;
    const ident = await wc.executeJavaScript(this.adapter.buildIdentityScript(), true);
    const herr = this.adapter.parseLeverUrl(ident.href);
    if (!herr || herr.canonical !== this.canonical) {
      this.emit('SUBMISSION_BLOCKED', 'JOB_MISMATCH');
      return { ok: false, code: 'JOB_MISMATCH' };
    }
    const cp = await wc.executeJavaScript(this.adapter.buildCheckpointScript(), true);
    const cleared = cp.cleared === true || cp.captchaPresent === false;
    if (!cleared) {
      this.emit('SUBMISSION_BLOCKED', 'CAPTCHA_REQUIRED');
      return { ok: false, code: 'CAPTCHA_REQUIRED' };
    }
    const refill = await wc.executeJavaScript(this.adapter.buildFillScript(this.currentPlan), true);
    if (refill.ok) this.emit('FIELDS_FILLED', `count=${refill.filled};presubmit`);
    await this.reattachResumeIfNeeded();
    const rb = await wc.executeJavaScript(this.adapter.buildReadBackScript(this.currentPlan, (refill && refill.wasCorrect) || {}), true);
    if (rb.newRequiredCount > 0 || /[MNBU]/.test(rb.statuses)) {
      this.emit('SUBMISSION_BLOCKED', `VERIFICATION:${rb.statuses}`);
      return { ok: false, code: 'VERIFICATION_FAILED', statuses: rb.statuses };
    }
    const control = await wc.executeJavaScript(this.adapter.buildSubmitControlCheckScript(), true);
    if (!control.ok) {
      this.emit('SUBMISSION_BLOCKED', control.code);
      return { ok: false, code: control.code };
    }
    return { ok: true, control: control.control };
  }

  // ── AGENT MODE (Phase 2): the ONE decision layer drives every action ──────

  /** Ask the server's decision facade what to do next (observe → decide). */
  async decideRemote(state) {
    try {
      if (!this.backendBase || !this.statusToken) return null;
      const res = await fetch(`${this.backendBase}/api/auto-apply/agent/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusToken: this.statusToken, state }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.decision) return null;
      return data.decision;
    } catch {
      return null;
    }
  }

  /** Navigate + identity, then hand over to the loop. */
  async agentRun() {
    const wc = this.wc;
    this.actFailures = new Map();
    this.lastFailures = new Map();
    try {
      const target = this.adapter.parseLeverUrl(this.currentPlan.url);
      this.canonical = target ? target.canonical : null;
      this.setState('NAVIGATING');
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('NAVIGATION_TIMEOUT')), NAV_TIMEOUT_MS);
        wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
        wc.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); reject(new Error(`NAVIGATION_FAILED:${code}:${String(desc).slice(0, 60)}`)); });
      });
      await wc.loadURL(target.isApplyPage ? this.currentPlan.url : `${this.canonical}${typeof this.adapter.applySuffix === 'function' ? this.adapter.applySuffix() : '/apply'}`);
      await loaded;
      this.emit('BROWSER_OPENED', this.canonical);
      const ident = await wc.executeJavaScript(this.adapter.buildIdentityScript(), true);
      const herr = this.adapter.parseLeverUrl(ident.href);
      if (!herr || herr.canonical !== this.canonical) {
        this.setState('FAILED');
        this.emit('JOB_MISMATCH', 'page identity differs from the frozen plan');
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: 'JOB_MISMATCH' };
      }
      this.emit('LEVER_VERIFIED', `${herr.siteSlug}/${herr.postingId}`);
      this.setState('INSPECTING');
      return await this.agentLoop();
    } catch (e) {
      this.setState('FAILED');
      this.emit('RUN_FAILED', String((e && e.message) || e).slice(0, 120));
      this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
      return { ok: false, code: 'RUN_FAILED' };
    }
  }

  /** observe → decide → act until clean, asking/pausing on the human edges. */
  async agentLoop() {
    const wc = this.wc;
    if (this.loopRunning) return { ok: true, statuses: 'ALREADY_RUNNING' };
    this.loopRunning = true;
    try {
    let deadline = Date.now() + 10 * 60 * 1000;
    const hardDeadline = Date.now() + 60 * 60 * 1000; // answers can take a while
    let captchaNotified = false;
    let questionsNotified = false;
    let decideFailures = 0;
    let fillsEmitted = 0;
    for (let cycle = 0; cycle < 80 && Date.now() < deadline; cycle++) {
      if (!this.alive()) return { ok: false, code: 'SESSION_GONE' };
      let cur = '';
      try { cur = String(wc.getURL() || ''); } catch { /* ignore */ }
      if (cur.startsWith('chrome-error://')) {
        this.setState('FAILED');
        this.emit('RUN_FAILED', 'PAGE_ERROR');
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: 'PAGE_ERROR' };
      }

      // A late human CAPTCHA solve can POST at any moment; if the page already
      // reached Lever's REAL success surface, capture it immediately instead of
      // looping forever on a form that no longer exists.
      const conf = await wc.executeJavaScript(this.adapter.buildConfirmationScript(), true).catch(() => null);
      if (conf && (conf.confirmed || conf.duplicate)) {
        this.setState('SUBMITTED');
        this.emit('SUBMISSION_CONFIRMED', conf.duplicate ? 'ALREADY_APPLIED' : (conf.evidence || 'SUCCESS_TEXT'));
        this.scheduleAutoClose(AUTO_CLOSE_SUBMITTED_MS);
        return { ok: true, statuses: 'AGENT_CONFIRMED' };
      }

      // Human CAPTCHA checkpoint — never touched; watch until it clears.
      const cp = await wc.executeJavaScript(this.adapter.buildCheckpointScript(), true).catch(() => null);
      if (cp && cp.captchaPresent) {
        if (!captchaNotified) {
          captchaNotified = true;
          this.waitReason = 'CAPTCHA_REQUIRED';
          this.setState('WAITING_FOR_USER');
          this.emit('HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (captchaNotified) {
        captchaNotified = false;
        this.waitReason = null;
        this.setState('INSPECTING');
        this.emit('CHECKPOINT_CLEARED', 'AGENT_AUTO_RESUME');
      }

      const obs = await this.observe();
      if (!obs.ok) {
        this.setState('FAILED');
        this.emit('RUN_FAILED', `observe:${obs.code || 'FAILED'}`);
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return obs;
      }
      const decision = await this.decideRemote(obs.state);
      if (!decision) {
        // A transient server hiccup (deploy, restart, overloaded GPU) must
        // never kill a live run — retry with backoff before giving up.
        decideFailures += 1;
        if (decideFailures < 8) {
          this.emit('SUBMISSION_BLOCKED', `decide unavailable (${decideFailures}/8) — retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          cycle = Math.max(-1, cycle - 1);
          continue;
        }
        this.setState('FAILED');
        this.emit('RUN_FAILED', 'DECISION_UNAVAILABLE');
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: 'DECISION_UNAVAILABLE' };
      }
      decideFailures = 0;
      this.emit('FORM_DISCOVERED', `agent cycle=${cycle} actions=${decision.actions.length} asks=${decision.asks.length}`);

      // QUESTIONS FIRST (user requirement): when the form has questions the
      // chat can answer, ASK before touching any input — the user's answers
      // drive the fills. Only browser-only asks (consent/EEO/CAPTCHA) do not
      // hold the fills. Filling first guessed values and produced re-asks.
      const chatAsks = (decision.asks || []).filter((a) => a.human !== true);
      let actedThisCycle = false;
      if (!chatAsks.length && decision.actions.length) {
        // Human-only asks (consent) do not hold fills, but the visible state
        // must STAY on 'Action needed' while they are pending — flipping to
        // FILLING every cycle made the button thrash (real progress looked
        // like an infinite loop).
        if (!decision.asks.length) this.setState('FILLING');
        let applied = 0;
        for (const a of decision.actions) {
          const sig = `${a.action}\u0001${a.ref}\u0001${String(a.value == null ? (a.option || '') : a.value)}`;
          // A stored OPTION_NOT_FOUND failure means the user is being asked to
          // pick from the form's real options — don't hammer it. A CHANGED
          // value (their new answer) unlocks a fresh attempt.
          const prevFail = this.lastFailures.get(a.ref);
          if (prevFail) {
            if (prevFail.sig === sig) continue;
            this.lastFailures.delete(a.ref);
          }
          const r = await this.act(a);
          if (!r || r.ok !== true) {
            this.actFailures.set(sig, (this.actFailures.get(sig) || 0) + 1);
            if (r && r.code === 'OPTION_NOT_FOUND') {
              let opts = [];
              try {
                const d = JSON.parse(r.message || '{}');
                opts = Array.isArray(d.options) ? d.options.slice(0, 24).map(String).filter(Boolean) : [];
              } catch { /* no diag */ }
              if (opts.length) this.lastFailures.set(a.ref, { code: 'OPTION_NOT_FOUND', sig, options: opts });
            }
            this.emit('SUBMISSION_BLOCKED', `act:${a.action}:${(r && r.code) || 'FAILED'}${r && r.message ? ':' + String(r.message).slice(0, 80) : ''}`);
            continue; // keep filling the OTHER fields — this one retries/escalates
          }
          this.actFailures.delete(sig);
          this.lastFailures.delete(a.ref);
          applied += 1;
        }
        if (applied > 0) {
          fillsEmitted += applied;
          actedThisCycle = true;
          this.emit('FIELDS_FILLED', `count=${fillsEmitted};agent`);
        }
      }

      // Escalation: an action the form keeps rejecting (3+ failures) becomes a
      // BROWSER ask instead of an endless retry. Merged with the composer's
      // asks into ONE live list — a chat ask must never be hidden behind it.
      const stuck = [];
      for (const [sig, n] of this.actFailures) {
        if (n < 3) continue;
        const ref = sig.split('\u0001')[1];
        const f = (obs.state.fields || []).find((x) => x.ref === ref);
        if (!f) continue;
        const hasValue = String(f.value || '').trim() !== '' || (f.options || []).some((o) => o.checked);
        if (!hasValue) stuck.push(f);
      }

      // CHOICE ASKS: a value the form's option list rejected (remote city
      // lists, Yes/No picks) becomes a CHAT ask WITH the real options — the
      // user picks one chip and the loop fills it on the next cycle.
      const choiceAsks = [];
      for (const [ref, entry] of this.lastFailures) {
        if (entry.code !== 'OPTION_NOT_FOUND' || !entry.options.length) continue;
        const f = (obs.state.fields || []).find((x) => x.ref === ref);
        if (!f) continue;
        const hasValue = String(f.value || '').trim() !== '' || f.checked === true || (f.options || []).some((o) => o.checked);
        if (hasValue) { this.lastFailures.delete(ref); continue; }
        choiceAsks.push({
          label: String(f.label || '').slice(0, 500),
          reason: "the form's list does not include your saved answer — pick one of its options",
          options: entry.options.slice(0, 24).map((o) => String(o).slice(0, 240)),
          human: false,
        });
      }

      const askList = [
        ...choiceAsks,
        ...(decision.asks || []).map((a) => ({
          label: String(a.label || '').slice(0, 500),
          reason: String(a.reason || '').slice(0, 240),
          options: Array.isArray(a.options) ? a.options.slice(0, 24).map((o) => String(o).slice(0, 240)) : [],
          human: a.human === true,
        })),
        ...stuck.map((f) => ({
          label: String(f.label || '').slice(0, 500),
          reason: 'the form did not accept the automatic value — pick it once in the Tailor Browser window; the rest of the form keeps filling and the run continues by itself',
          options: (f.options || []).map((o) => String(o.option || '')).filter(Boolean).slice(0, 24),
          // Human-in-browser by design: typeahead/widget failures are fixed in
          // the real window — a chat answer cannot operate the widget, and a
          // chat ask here would HALT every other fill under the questions gate.
          human: true,
        })),
      ].filter((a, i, arr) => a.label && arr.findIndex((b) => b.label === a.label) === i);

      if (askList.length) {
        // Notify ONCE per DISTINCT set, then KEEP WATCHING — the user resolves
        // in the visible browser (or the chat in the full UI) and the loop
        // resumes by itself. Refresh pendingAsks whenever the set CHANGES so
        // the chat never shows a stale question list.
        const askSig = askList.map((a) => a.label).join('|');
        if (!questionsNotified || this.asksSig !== askSig) {
          questionsNotified = true;
          this.asksSig = askSig;
          this.waitReason = 'QUESTIONS_REQUIRED';
          this.pendingAsks = askList;
          this.setState('WAITING_FOR_USER');
          this.emit('HUMAN_ACTION_REQUIRED', `QUESTIONS_REQUIRED:${String(askList[0].label || '').slice(0, 80)}`);
        }
        // Waiting on the human must not consume the loop budget: the run can
        // sit here for as long as the user needs (bounded to 1 hour total)
        // and resumes the instant the answers resolve.
        cycle = Math.max(-1, cycle - 1);
        deadline = Math.min(hardDeadline, Date.now() + 10 * 60 * 1000);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      this.asksSig = null;
      if (questionsNotified) {
        questionsNotified = false;
        this.waitReason = null;
        this.pendingAsks = [];
        this.setState('INSPECTING');
        this.emit('CHECKPOINT_CLEARED', 'AGENT_USER_RESOLVED');
      }

      if (actedThisCycle) continue; // re-observe after acting

      if (decision.submit) {
        this.setState('READY_FOR_SUBMISSION');
        this.emit('READY_FOR_REVIEW', 'agent:form-clean');
        return { ok: true, statuses: 'AGENT_CLEAN' };
      }

      // Nothing to do and not submittable (e.g., disabled control) — wait briefly.
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.waitReason = 'SUBMISSION_UNCONFIRMED';
    this.setState('WAITING_FOR_USER');
    this.emit('SUBMISSION_UNCONFIRMED', 'agent loop exhausted — user reviews');
    return { ok: false, code: 'AGENT_LOOP_EXHAUSTED' };
    } finally {
      this.loopRunning = false;
    }
  }

  /** Agent-mode submit revalidation: re-observe, require a clean decision, control check. */
  async agentFinalRevalidation() {
    const cp = await this.wc.executeJavaScript(this.adapter.buildCheckpointScript(), true).catch(() => null);
    if (cp && cp.captchaPresent) {
      this.emit('SUBMISSION_BLOCKED', 'CAPTCHA_REQUIRED');
      return { ok: false, code: 'CAPTCHA_REQUIRED' };
    }
    const obs = await this.observe();
    if (!obs.ok) return { ok: false, code: 'OBSERVE_FAILED' };
    const decision = await this.decideRemote(obs.state);
    if (!decision || !decision.submit) {
      this.emit('SUBMISSION_BLOCKED', `VERIFICATION:${decision && decision.asks.length ? String(decision.asks[0].label).slice(0, 60) : 'not-clean'}`);
      return { ok: false, code: 'VERIFICATION_FAILED' };
    }
    const control = await this.wc.executeJavaScript(this.adapter.buildSubmitControlCheckScript(), true);
    if (!control.ok) {
      this.emit('SUBMISSION_BLOCKED', control.code);
      return { ok: false, code: control.code };
    }
    return { ok: true, control: control.control };
  }

  /** ONE click on the validated control, then confirmation detection. Never called without server authorization.
   *  A visible CAPTCHA at click time pauses for the human (never bypassed) and
   *  the loop KEEPS WATCHING through the solve → confirmation. */
  async performSubmit() {
    if (this.submitPerformed) return { ok: false, code: 'SUBMISSION_ALREADY_PERFORMED' };
    const wc = this.wc;
    this.submitPerformed = true;
    this.setState('SUBMITTING');
    this.emit('SUBMIT_CONTROL_ACTIVATED', 'application-submit');
    // Make the session visible + focused: an occluded/backgrounded view cannot
    // render an hCaptcha challenge, and the human must SEE it to solve it.
    try {
      if (this.manager && typeof this.manager.setVisibleSession === 'function') this.manager.setVisibleSession(this.executionId);
    } catch { /* visibility is best-effort */ }
    try {
      const win = this.manager && this.manager.parentWindow;
      if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); win.focus(); }
    } catch { /* focus is best-effort */ }
    // Trusted input first: a programmatic .click() carries no user activation,
    // and gesture-gated submit handlers (invisible hCaptcha) silently stall on
    // it. Validate + measure in-page, then send REAL mouse events at the control.
    const r = await wc.executeJavaScript(this.adapter.buildSubmitScript({ trustedInput: true }), true);
    if (!r.ok) {
      this.setState('FAILED');
      this.emit('SUBMISSION_FAILED', r.code);
      this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
      return r;
    }
    if (r.rect && r.rect.w > 0 && r.rect.h > 0) {
      try {
        await this.trustedClick(r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2);
      } catch (e) {
        const fallback = await wc.executeJavaScript(this.adapter.buildSubmitScript(), true);
        if (!fallback.ok) {
          this.setState('FAILED');
          this.emit('SUBMISSION_FAILED', fallback.code);
          this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
          return fallback;
        }
      }
    } else {
      // No measurable rect (offscreen/odd layout): programmatic click fallback.
      const fallback = await wc.executeJavaScript(this.adapter.buildSubmitScript(), true);
      if (!fallback.ok) {
        this.setState('FAILED');
        this.emit('SUBMISSION_FAILED', fallback.code);
        return fallback;
      }
    }
    let captchaNotified = false;
    // SPA form submits (Greenhouse) POST via fetch and the app's own success UI
    // can freeze in this environment — the network response is the ground
    // truth. Watch the REAL submission POST (status + body) alongside the DOM.
    const netPosts = new Map(); // requestId -> { url, status, done }
    let netConfirmed = null;
    try {
      const dbg = this.wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      dbg.on('message', (_event, method, params) => {
        try {
          if (method === 'Network.requestWillBeSent' && params && params.request) {
            const u = String(params.request.url || '');
            if (params.request.method === 'POST' && /greenhouse\.io|lever\.co|ashbyhq\.com/.test(u)) {
              netPosts.set(params.requestId, { url: u });
            }
          }
          if (method === 'Network.responseReceived' && params && netPosts.has(params.requestId)) {
            const entry = netPosts.get(params.requestId);
            entry.status = params.response ? params.response.status : 0;
            entry.done = true;
            if (entry.status >= 200 && entry.status < 400) {
              netConfirmed = { status: entry.status, requestId: params.requestId };
            } else {
              this.emit('SUBMISSION_POST_REJECTED', `status=${entry.status}`);
            }
          }
        } catch { /* network watch must never break the flow */ }
      });
      await dbg.sendCommand('Network.enable');
    } catch { /* network watch is best-effort */ }

    const deadline = Date.now() + 6 * 60 * 1000; // human CAPTCHA solve window
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      // A dead renderer (chrome-error page) can never produce a confirmation —
      // fail fast and honestly instead of waiting out the window.
      let cur = '';
      try { cur = String(wc.getURL() || ''); } catch { /* ignore */ }
      if (cur.startsWith('chrome-error://')) {
        this.waitReason = 'SUBMISSION_UNCONFIRMED';
        this.setState('WAITING_FOR_USER');
        this.emit('SUBMISSION_UNCONFIRMED', `page-error:${cur.slice(0, 40)}`);
        return { ok: false, code: 'SUBMITTED_UNVERIFIED' };
      }
      const c = await wc.executeJavaScript(this.adapter.buildConfirmationScript(), true);
      if (c.confirmed || c.duplicate) {
        this.setState('SUBMITTED');
        this.emit('SUBMISSION_CONFIRMED', c.duplicate ? 'ALREADY_APPLIED' : (c.evidence || 'SUCCESS_TEXT'));
        return { ok: true, verified: true };
      }
      // SPA submit: a 2xx submission POST whose RESPONSE BODY carries the real
      // success markers is provider confirmation even if the app UI froze.
      if (netConfirmed && netConfirmed.requestId) {
        let body = '';
        try { const r = await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId: netConfirmed.requestId }); body = String((r && r.body) || ''); } catch { /* body may be unavailable */ }
        if (/thank you for applying|application (has been|was) (submitted|received)|we('ve| have) received your application|already (applied|received)|gracias por aplicar|hemos recibido|obrigado por se candidatar|vielen dank|merci|\/confirmation/i.test(body)) {
          this.setState('SUBMITTED');
          this.emit('SUBMISSION_CONFIRMED', /already/i.test(body) ? 'ALREADY_APPLIED' : `POST_${netConfirmed.status}_SUCCESS`);
          return { ok: true, verified: true };
        }
        netConfirmed = null; // body without markers — keep watching the DOM
      }
      // A visible CAPTCHA can appear at click time (hCaptcha challenge): tell
      // the user ONCE, keep watching while they solve — never interact with it.
      // Checked BEFORE error classification (Lever renders captcha/required
      // text that would otherwise be misread as a rejection).
      const cp = await wc.executeJavaScript(this.adapter.buildCheckpointScript(), true).catch(() => null);
      if (cp && cp.captchaPresent) {
        if (!captchaNotified) {
          captchaNotified = true;
          this.waitReason = 'CAPTCHA_REQUIRED';
          this.setState('WAITING_FOR_USER');
          this.emit('HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
        }
        continue;
      }
      if (captchaNotified && !(cp && cp.captchaPresent)) {
        // Solved — Lever's callback submits; keep watching for confirmation.
        captchaNotified = false;
        this.waitReason = null;
        this.setState('SUBMITTING');
      }
      if (c.error) {
        this.waitReason = 'SUBMISSION_REJECTED';
        this.setState('WAITING_FOR_USER');
        this.emit('SUBMISSION_UNCONFIRMED', `rejected:${String(c.evidence || 'validation')}`);
        return { ok: false, code: 'SUBMISSION_REJECTED' };
      }
      // `formGone` alone is NOT proof: a validation error or a navigation can
      // remove the form without accepting the application. Positivity required.
    }
    // Timed out: capture a short page snippet so the row message is actionable.
    let snippet = null;
    try {
      snippet = await wc.executeJavaScript(
        `(() => { const t = (document.body && document.body.innerText) || ''; const m = t.match(/[^\\n]*(error|required|invalid|captcha)[^\\n]*/i); return String(m ? m[0] : t).slice(0, 160); })()`,
        true
      );
    } catch { /* snippet is best-effort */ }
    this.waitReason = 'SUBMISSION_UNCONFIRMED';
    this.setState('WAITING_FOR_USER');
    this.emit('SUBMISSION_UNCONFIRMED', snippet ? `no confirmation: ${String(snippet).slice(0, 150)}` : 'no confirmation within 6min — user reviews');
    return { ok: false, code: 'SUBMITTED_UNVERIFIED' };
  }
}

class BrowserSessionManager {
  constructor({ onEvent, parentWindow, maxConcurrency = 5 } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.parentWindow = parentWindow || null;
    this.maxConcurrency = Math.max(1, Math.min(5, Number(maxConcurrency) || 5));
    this.sessions = new Map(); // executionId -> Session
    this.visibleId = null;
    this.partition = null;
    this._partitionReady = false;
  }

  emit(session, type, detail = '') {
    if (process.env.TAILOR_BROWSER_DEBUG === '1') {
      try { console.log(`TAILOR_EVT ${session ? session.state : 'IDLE'} ${type} ${String(detail).slice(0, 420)}`); } catch { /* debug only */ }
    }
    try {
      this.onEvent({ executionId: session ? session.executionId : null, type, detail: String(detail).slice(0, 200), state: session ? session.state : 'IDLE', at: new Date().toISOString() });
    } catch { /* telemetry must never break execution */ }
  }

  ensurePartition(userId) {
    if (this._partitionReady) return;
    this.partition = `persist:tailor-user-${String(userId || 'guest').slice(0, 64)}`;
    const p = electronSession.fromPartition(this.partition);
    try {
      p.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      p.on('will-download', (e) => e.preventDefault());
    } catch { /* defaults apply */ }
    this._partitionReady = true;
  }

  makeView() {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false, // background sessions keep executing
        devTools: process.env.TAILOR_BROWSER_DEVTOOLS === '1',
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      let providerPopup = false;
      try { providerPopup = !!(greenhouseAdapter.parseLeverUrl(url) || lever.parseLeverUrl(url)); } catch { /* external */ }
      this.emit(null, 'EXTERNAL_OPEN_BLOCKED', providerPopup ? 'provider-popup' : 'external');
      return { action: 'deny' };
    });
    return view;
  }

  /** Create an independent execution session (own view; visible only if first). */
  createSession({ executionId, userId, attemptId, plan, resumeBytes, resumeSha256, resumeFilename, preAuthorizedSubmit, statusToken, backendBase }) {
    this.ensurePartition(userId);
    const session = new Session(this, { executionId, userId, attemptId, plan, resumeBytes, resumeSha256, resumeFilename, preAuthorizedSubmit });
    session.statusToken = String(statusToken || '');
    session.backendBase = String(backendBase || '');
    session.view = this.makeView();
    this.sessions.set(session.executionId, session);
    const wc = session.view.webContents;
    // Page-health telemetry: a crashed/blank renderer must never masquerade
    // as "Action required" with a white view.
    wc.on('did-navigate', (_e, url) => { session.pageUrl = String(url || session.pageUrl || ''); });
    wc.on('did-finish-load', () => { try { session.pageUrl = String(wc.getURL() || session.pageUrl || ''); } catch { /* ignore */ } });
    wc.on('render-process-gone', (_e, details) => {
      session.crashed = true;
      this.emit(session, 'RUN_FAILED', `renderer-gone:${String((details && details.reason) || 'unknown').slice(0, 40)}`);
      session.setState('FAILED');
      session.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
    });
    wc.on('will-navigate', (e, url) => {
      try {
        const target = session.adapter.parseLeverUrl(url);
        if (target) {
          if (session.canonical && target.canonical !== session.canonical) {
            e.preventDefault();
            this.emit(session, 'NAVIGATION_BLOCKED', String(url).slice(0, 120));
          }
          return; // same posting (or navigation before identity) → allow
        }
        // Terminal/flow routes of the SAME provider host (confirmation,
        // thanks, already-received) are part of the real submission flow.
        const host = String(url || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        const canonHost = session.canonical ? String(session.canonical).replace(/^https?:\/\//, '').split('/')[0].toLowerCase() : '';
        if (canonHost && host === canonHost && /\/(confirmation|thanks|already-received)(?:[?#]|$)/i.test(String(url))) return;
        if (!session.canonical) return;
        e.preventDefault();
        this.emit(session, 'NAVIGATION_BLOCKED', String(url).slice(0, 120));
      } catch { /* a navigation event must never crash the main process */ }
    });
    if (!this.visibleId) this.setVisibleSession(session.executionId);
    this.emit(session, 'SESSION_CREATED', `attempt=${plan && plan.attemptId ? plan.attemptId : ''}`);
    return session;
  }

  setVisibleSession(executionId) {
    const target = this.sessions.get(String(executionId));
    if (!target || !target.view) return { ok: false, code: 'UNKNOWN_SESSION' };
    for (const s of this.sessions.values()) {
      if (s.attached && s !== target && this.parentWindow) {
        try { this.parentWindow.contentView.removeChildView(s.view); } catch { /* ignore */ }
        s.attached = false;
      }
    }
    if (!target.attached && this.parentWindow) {
      this.parentWindow.contentView.addChildView(target.view);
      target.attached = true;
    }
    this.visibleId = target.executionId;
    this.relayout();
    this.emit(target, 'SESSION_VISIBLE');
    return { ok: true, executionId: target.executionId, state: target.state };
  }

  relayout() {
    const visible = this.sessions.get(this.visibleId);
    if (visible && visible.view && this.parentWindow && visible.attached) {
      const [w, h] = this.parentWindow.getContentSize();
      visible.view.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  }

  getSession(executionId) {
    return this.sessions.get(String(executionId)) || null;
  }

  /** Cancel ONLY this execution: destroy its view, release its slot (Phase 29). */
  destroySession(executionId, reason = 'CLOSED') {
    const session = this.sessions.get(String(executionId));
    if (!session) return { ok: false, code: 'UNKNOWN_SESSION' };
    if (session.attached && this.parentWindow) {
      try { this.parentWindow.contentView.removeChildView(session.view); } catch { /* ignore */ }
      session.attached = false;
    }
    session.dispose();
    session.state = 'CLOSED';
    this.sessions.delete(session.executionId);
    if (this.visibleId === session.executionId) {
      this.visibleId = null;
      const next = this.sessions.keys().next();
      if (!next.done) this.setVisibleSession(next.value);
    }
    try { console.log('TAILOR_BROWSER_SESSION_CLOSED', session.executionId, reason); } catch { /* ignore */ }
    this.emit(session, 'SESSION_CLOSED', reason);
    // The agent owns the window lifecycle: when the LAST session ends, the
    // window hides itself (no lingering empty shell after a finished run).
    if (this.sessions.size === 0 && this.parentWindow && !this.parentWindow.isDestroyed()) {
      try { this.parentWindow.hide(); } catch { /* window already gone */ }
    }
    return { ok: true };
  }

  getState() {
    const visible = this.sessions.get(this.visibleId);
    return {
      maxConcurrency: this.maxConcurrency,
      visibleSessionId: this.visibleId,
      sessions: [...this.sessions.values()].map((s) => ({
        executionId: s.executionId,
        attemptId: s.attemptId,
        state: s.state,
        url: s.canonical || (s.currentPlan && s.currentPlan.url) || '',
        title: (s.currentPlan && s.currentPlan.title) || '',
        company: (s.currentPlan && s.currentPlan.company) || '',
        checkpoint: s.state === 'WAITING_FOR_USER' ? 'ACTION_REQUIRED' : null,
        waitReason: s.waitReason || null,
        asks: s.pendingAsks || [],
        preAuthorizedSubmit: s.preAuthorizedSubmit,
        pageUrl: s.pageUrl || '',
        crashed: s.crashed === true,
      })),
      // Back-compat aggregate view for older callers.
      state: visible ? visible.state : 'IDLE',
      userId: visible ? visible.userId : '',
      attemptId: visible ? visible.attemptId : null,
      canonical: visible ? visible.canonical : null,
      partition: this.partition,
    };
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.destroySession(id, 'CLOSE_ALL');
  }
}

module.exports = { BrowserSessionManager, Session, STATES };
