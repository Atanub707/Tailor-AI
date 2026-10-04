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

const STATES = [
  'IDLE', 'STARTING', 'NAVIGATING', 'READY', 'INSPECTING', 'FILLING', 'WAITING_FOR_USER',
  'VERIFYING', 'READY_FOR_SUBMISSION', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'CANCELLED', 'CLOSED',
];
const CHECKPOINT_POLL_MS = 2000;
const CHECKPOINT_TIMEOUT_MS = 15 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const AUTO_CLOSE_FAILED_MS = 20_000;
const AUTO_CLOSE_READY_MS = 120_000; // explicit-review window; auto-submit closes sooner

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
      const { root } = await dbg.sendCommand('DOM.getDocument');
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"][name="resume"]' });
      if (!nodeId) return { ok: false, reason: 'NO_RESUME_CONTROL' };
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-resume-'));
      const safeName = String(filename || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const filePath = path.join(tmpDir, safeName);
      fs.writeFileSync(filePath, buf, { mode: 0o600 });
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId });
      const check = await wc.executeJavaScript(
        `(() => { const i = document.querySelector('input[type="file"][name="resume"]'); return i && i.files && i.files.length === 1 ? { name: i.files[0].name, size: i.files[0].size } : null; })()`,
        true
      );
      if (!check || check.size !== buf.length) {
        this.emit('RESUME_ATTACHMENT_FAILED', 'verify-failed');
        return { ok: false, reason: 'RESUME_VERIFY_FAILED' };
      }
      this.emit('RESUME_ATTACHED', `bytes=${buf.length}`);
      return { ok: true };
    } catch (e) {
      this.emit('RESUME_ATTACHMENT_FAILED', String(e.message || e).slice(0, 80));
      return { ok: false, reason: 'RESUME_ATTACH_FAILED' };
    } finally {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  async reattachResumeIfNeeded() {
    if (!this.lastResume) return;
    try {
      const has = await this.wc.executeJavaScript(
        `(() => { const i = document.querySelector('input[type="file"][name="resume"]'); return !!(i && i.files && i.files.length === 1); })()`,
        true
      );
      if (!has) await this.attachResume(this.lastResume.bytes, this.lastResume.sha256, this.lastResume.filename);
    } catch { /* attach failures are reported by attachResume itself */ }
  }

  finishVerification(rb) {
    const clean = rb.newRequiredCount === 0 && !/[MNBU]/.test(rb.statuses);
    if (!clean) {
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
    const wc = this.wc;
    try {
      const target = lever.parseLeverUrl(this.currentPlan.url);
      this.canonical = target ? target.canonical : null;
      this.setState('NAVIGATING');
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('NAVIGATION_TIMEOUT')), NAV_TIMEOUT_MS);
        wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
        wc.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); reject(new Error(`NAVIGATION_FAILED:${code}:${String(desc).slice(0, 60)}`)); });
      });
      await wc.loadURL(target.isApplyPage ? this.currentPlan.url : `${this.canonical}/apply`);
      await loaded;
      this.emit('BROWSER_OPENED', this.canonical);

      const ident = await wc.executeJavaScript(lever.buildIdentityScript(), true);
      const herr = lever.parseLeverUrl(ident.href);
      if (!herr || herr.canonical !== this.canonical) {
        this.setState('FAILED');
        this.emit('JOB_MISMATCH', 'page identity differs from the frozen plan');
        this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
        return { ok: false, code: 'JOB_MISMATCH' };
      }
      this.emit('LEVER_VERIFIED', `${herr.siteSlug}/${herr.postingId}`);
      this.setState('INSPECTING');

      const fill = await wc.executeJavaScript(lever.buildFillScript(this.currentPlan), true);
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
      const rb = await wc.executeJavaScript(lever.buildReadBackScript(this.currentPlan, fill.wasCorrect), true);
      this.emit('FILL_VERIFICATION_COMPLETED', `statuses=${rb.statuses};newRequired=${rb.newRequiredCount}`);

      if (fill.captchaPresent) {
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
        const cp = await this.wc.executeJavaScript(lever.buildCheckpointScript(), true);
        if (cp.formGone) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; this.emit('FORM_GONE', 'page changed'); return; }
        const cleared = cp.cleared === true || !cp.captchaPresent || cp.captchaFieldFilled;
        if (cleared) {
          clearInterval(this.checkpointTimer);
          this.checkpointTimer = null;
          const result = await this.revalidateAfterCheckpoint();
          if (result && result.ok !== true && this.checkpointAttempts < 25) {
            this.checkpointAttempts += 1;
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
    const wc = this.wc;
    const ident = await wc.executeJavaScript(lever.buildIdentityScript(), true);
    const herr = lever.parseLeverUrl(ident.href);
    if (!herr || herr.canonical !== this.canonical) {
      this.setState('FAILED');
      this.emit('JOB_MISMATCH', 'page changed after checkpoint');
      this.scheduleAutoClose(AUTO_CLOSE_FAILED_MS);
      return { ok: false, code: 'JOB_MISMATCH' };
    }
    const refill = await wc.executeJavaScript(lever.buildFillScript(this.currentPlan), true);
    if (refill.ok) this.emit('FIELDS_FILLED', `count=${refill.filled};refill`);
    await this.reattachResumeIfNeeded();
    const rb = await wc.executeJavaScript(lever.buildReadBackScript(this.currentPlan, (refill && refill.wasCorrect) || {}), true);
    this.emit('FILL_VERIFICATION_COMPLETED', `statuses=${rb.statuses};newRequired=${rb.newRequiredCount};revalidated`);
    return this.finishVerification(rb);
  }

  /** Manual unblock: "I completed the challenge — revalidate now." */
  async continueCheckpoint() {
    if (this.state !== 'WAITING_FOR_USER' || !this.currentPlan) return { ok: false, code: 'NOT_WAITING' };
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.emit('CHECKPOINT_CLEARED', 'USER_CONTINUE');
    const result = await this.revalidateAfterCheckpoint();
    if (result && result.ok !== true && this.checkpointAttempts < 25) {
      this.checkpointAttempts += 1;
      this.setState('WAITING_FOR_USER');
      this.emit('HUMAN_ACTION_REQUIRED', 'VERIFICATION_REQUIRED');
      this.waitForCheckpoint({});
    }
    return { ok: true, result };
  }

  /** FINAL submit revalidation: identity → CAPTCHA cleared → refill → clean read-back → control. */
  async finalSubmitRevalidation() {
    const wc = this.wc;
    const ident = await wc.executeJavaScript(lever.buildIdentityScript(), true);
    const herr = lever.parseLeverUrl(ident.href);
    if (!herr || herr.canonical !== this.canonical) {
      this.emit('SUBMISSION_BLOCKED', 'JOB_MISMATCH');
      return { ok: false, code: 'JOB_MISMATCH' };
    }
    const cp = await wc.executeJavaScript(lever.buildCheckpointScript(), true);
    const cleared = cp.cleared === true || cp.captchaPresent === false;
    if (!cleared) {
      this.emit('SUBMISSION_BLOCKED', 'CAPTCHA_REQUIRED');
      return { ok: false, code: 'CAPTCHA_REQUIRED' };
    }
    const refill = await wc.executeJavaScript(lever.buildFillScript(this.currentPlan), true);
    if (refill.ok) this.emit('FIELDS_FILLED', `count=${refill.filled};presubmit`);
    await this.reattachResumeIfNeeded();
    const rb = await wc.executeJavaScript(lever.buildReadBackScript(this.currentPlan, (refill && refill.wasCorrect) || {}), true);
    if (rb.newRequiredCount > 0 || /[MNBU]/.test(rb.statuses)) {
      this.emit('SUBMISSION_BLOCKED', `VERIFICATION:${rb.statuses}`);
      return { ok: false, code: 'VERIFICATION_FAILED', statuses: rb.statuses };
    }
    const control = await wc.executeJavaScript(lever.buildSubmitControlCheckScript(), true);
    if (!control.ok) {
      this.emit('SUBMISSION_BLOCKED', control.code);
      return { ok: false, code: control.code };
    }
    return { ok: true, control: control.control };
  }

  /** ONE click on the validated control, then confirmation detection. Never called without server authorization. */
  async performSubmit() {
    if (this.submitPerformed) return { ok: false, code: 'SUBMISSION_ALREADY_PERFORMED' };
    const wc = this.wc;
    this.submitPerformed = true;
    this.setState('SUBMITTING');
    this.emit('SUBMIT_CONTROL_ACTIVATED', 'lever:application-submit');
    const r = await wc.executeJavaScript(lever.buildSubmitScript(), true);
    if (!r.ok) {
      this.setState('FAILED');
      this.emit('SUBMISSION_FAILED', r.code);
      return r;
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const c = await wc.executeJavaScript(lever.buildConfirmationScript(), true);
      if (c.confirmed || c.formGone) {
        this.setState('SUBMITTED');
        this.emit('SUBMISSION_CONFIRMED', c.confirmed ? 'SUCCESS_TEXT' : 'FORM_REPLACED');
        return { ok: true, verified: true };
      }
    }
    this.setState('WAITING_FOR_USER');
    this.emit('SUBMISSION_UNCONFIRMED', 'no confirmation within 30s — user reviews');
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
      this.emit(null, 'EXTERNAL_OPEN_BLOCKED', lever.parseLeverUrl(url) ? 'lever-popup' : 'external');
      return { action: 'deny' };
    });
    return view;
  }

  /** Create an independent execution session (own view; visible only if first). */
  createSession({ executionId, userId, attemptId, plan, resumeBytes, resumeSha256, resumeFilename, preAuthorizedSubmit }) {
    this.ensurePartition(userId);
    const session = new Session(this, { executionId, userId, attemptId, plan, resumeBytes, resumeSha256, resumeFilename, preAuthorizedSubmit });
    session.view = this.makeView();
    this.sessions.set(session.executionId, session);
    const wc = session.view.webContents;
    wc.on('will-navigate', (e, url) => {
      const target = lever.parseLeverUrl(url);
      if (!target || (session.canonical && target.canonical !== session.canonical)) {
        e.preventDefault();
        this.emit(session, 'NAVIGATION_BLOCKED', String(url).slice(0, 120));
      }
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
        preAuthorizedSubmit: s.preAuthorizedSubmit,
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
