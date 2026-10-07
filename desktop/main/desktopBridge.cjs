'use strict';
// Tailor Desktop Bridge — the ONLY web→desktop channel (Phase 3/4/23).
//
// Security model:
//  - binds 127.0.0.1 ONLY (never a wildcard/all-interfaces bind)
//  - origin allowlist (the local Tailor web UI)
//  - execution starts require a single-use, short-lived backend token; the
//    desktop resolves the job/plan FROM THE BACKEND — the page never supplies
//    a URL, JavaScript, or field data
//  - no filesystem access, no arbitrary navigation, no code execution channel
const http = require('node:http');

let ElectronNotification = null;
try { ElectronNotification = require('electron').Notification; } catch { /* non-electron context */ }

/** ONE native OS notification per (execution, moment) — never spam. */
function notifyNative(entry, moment, title, body) {
  try {
    if (!ElectronNotification || !ElectronNotification.isSupported || !ElectronNotification.isSupported()) return;
    entry.notified = entry.notified || {};
    if (entry.notified[moment]) return;
    entry.notified[moment] = true;
    new ElectronNotification({ title, body: String(body || '').slice(0, 160), silent: false }).show();
  } catch { /* notifications are best-effort */ }
}

const ALLOWED_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const PORT = Number(process.env.TAILOR_BRIDGE_PORT || 45451);
const MAX_BODY = 64 * 1024;
const ACTIVE_STATES = new Set(['STARTING', 'NAVIGATING', 'INSPECTING', 'FILLING', 'VERIFYING', 'WAITING_FOR_USER', 'SUBMITTING']);
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/; // base64url single-use execution tokens
const JOB_ID_RE = /^[a-zA-Z0-9._:-]{1,80}$/;

/** PURE: manager event → backend execution state (unit-tested). */
function mapEventToState(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'STATE') {
    return (
      {
        STARTING: 'DESKTOP_CONNECTED',
        NAVIGATING: 'NAVIGATING',
        INSPECTING: 'INSPECTING',
        FILLING: 'FILLING',
        VERIFYING: 'VERIFYING',
        WAITING_FOR_USER: 'WAITING_FOR_USER',
        READY_FOR_SUBMISSION: 'READY_FOR_REVIEW',
        FAILED: 'FAILED',
      }[String(ev.detail)] || null
    );
  }
  return (
    {
      BROWSER_OPENED: 'NAVIGATING',
      LEVER_VERIFIED: 'INSPECTING',
      FIELDS_FILLED: 'FILLING',
      RESUME_ATTACHED: 'ATTACHING_RESUME',
      RESUME_NOT_ATTACHED: 'ATTACHING_RESUME',
      RESUME_SKIPPED: 'ATTACHING_RESUME',
      FILL_VERIFICATION_COMPLETED: 'VERIFYING',
      HUMAN_ACTION_REQUIRED: 'WAITING_FOR_USER',
      READY_FOR_REVIEW: 'READY_FOR_REVIEW',
      RUN_FAILED: 'FAILED',
      FILL_FAILED: 'FAILED',
      JOB_MISMATCH: 'FAILED',
      PLAN_REJECTED: 'FAILED',
      SUBMIT_CONTROL_ACTIVATED: 'SUBMITTING',
      SUBMISSION_CONFIRMED: 'SUBMITTED_VERIFIED',
      // Unconfirmed/rejected are NOT terminal: keep the session so the user can
      // review, fix, and retry — never delete on an unverified outcome.
      SUBMISSION_UNCONFIRMED: 'WAITING_FOR_USER',
      SUBMISSION_REJECTED: 'WAITING_FOR_USER',
      // NOTE: SUBMISSION_BLOCKED and CHECKPOINT_CLEARED are deliberately NOT
      // mapped. They fire during NORMAL operation (a field act retried, a
      // decide hiccup, a checkpoint auto-clearing) — mapping them flipped the
      // row to "Action needed" mid-fill and made clicks land on a session with
      // nothing to ask. Row state is driven by STATE events + the heartbeat.
      SUBMISSION_FAILED: 'FAILED',
    }[String(ev.type)] || null
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createDesktopBridge({ manager, backendBase, onFocus, port = PORT, bootId = '', appVersion = '' }) {
  const sessions = new Map(); // executionId -> { statusToken, attemptId, userId, jobId, preAuthorizedSubmit }

  const corsHeaders = (origin) => {
    if (!ALLOWED_ORIGINS.has(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  };
  const json = (res, code, body, origin) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(JSON.stringify(body));
  };

  const TERMINAL_STATES = new Set(['FAILED', 'SUBMITTED_VERIFIED']);
  const STATUS_ENDPOINT = `${backendBase}/api/auto-apply/desktop-execution/status`;
  // Heartbeat safety net: even if an event post is ever dropped, the CURRENT
  // state of every session is re-posted every 5s (idempotent) — rows can never
  // spin forever on a lost transition.
  const STATE_TO_EXECUTION = {
    STARTING: 'DESKTOP_CONNECTED', NAVIGATING: 'NAVIGATING', INSPECTING: 'INSPECTING',
    FILLING: 'FILLING', VERIFYING: 'VERIFYING', WAITING_FOR_USER: 'WAITING_FOR_USER',
    READY_FOR_SUBMISSION: 'READY_FOR_REVIEW', SUBMITTING: 'SUBMITTING',
    SUBMITTED: 'SUBMITTED_VERIFIED', FAILED: 'FAILED',
  };
  let heartbeat = null;
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      for (const [executionId, entry] of sessions) {
        const session = manager.getSession(executionId);
        if (!session) continue;
        const state = STATE_TO_EXECUTION[session.state];
        if (!state) continue;
        void fetch(STATUS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statusToken: entry.statusToken, state, event: `HEARTBEAT${session.waitReason ? ':' + session.waitReason : ''}` }),
        }).catch(() => {});
      }
    }, 5000);
  }

  /** Server-authorized, exactly-once submit chain for ONE session (explicit click OR pre-authorized auto). */
  async function runSubmit(executionId) {
    const entry = sessions.get(executionId);
    const session = manager.getSession(executionId);
    if (!entry || !session) return { ok: false, code: 'UNKNOWN_SESSION' };
    const prep = await session.finalSubmitRevalidation();
    if (!prep.ok) return { ok: false, code: prep.code, statuses: prep.statuses };
    const mark = await fetch(`${backendBase}/api/auto-apply/desktop-execution/mark-submitting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusToken: entry.statusToken }),
    });
    const m = await mark.json().catch(() => null);
    if (!mark.ok) return { ok: false, code: (m && m.code) || 'SUBMIT_NOT_AUTHORIZED' };
    const result = await session.performSubmit();
    if (result && result.ok && result.verified) {
      await fetch(`${backendBase}/api/auto-apply/desktop-execution/submitted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusToken: entry.statusToken, confirmationType: 'SUCCESS_MESSAGE' }),
      }).catch(() => {});
      // receipt + Applied persisted; brief grace, then close THIS session.
      setTimeout(() => manager.destroySession(executionId, 'APPLIED'), 3000);
      return { ok: true, verified: true };
    }
    return { ok: false, verified: false, code: (result && result.code) || 'SUBMITTED_UNVERIFIED' };
  }

  const postStatus = (ev) => {
    const executionId = ev && ev.executionId ? String(ev.executionId) : '';
    if (ev && ev.type === 'SESSION_CLOSED') {
      const closing = sessions.get(executionId);
      const reason = String(ev.detail || 'CLOSED').toUpperCase();
      // A dead session must leave an HONEST row — never a frozen "Action
      // needed"/"Filling" forever. APPLIED is excluded (the confirmed-submit
      // path already posted SUBMITTED_VERIFIED and deleted its entry).
      if (closing && !reason.includes('APPLIED')) {
        void fetch(STATUS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statusToken: closing.statusToken, state: 'FAILED', event: `SESSION_CLOSED:${reason}`.slice(0, 80) }),
        }).catch(() => {});
      }
      sessions.delete(executionId);
      return;
    }
    const entry = sessions.get(executionId);
    if (!entry) return;
    // Timeline ring buffer: keep the user-visible milestones only.
    try {
      const t = String(ev.type || '');
      const NOISE = t === 'STATE' || t === 'FORM_DISCOVERED' || t === 'SESSION_VISIBLE' || /^SUBMISSION_BLOCKED/.test(t);
      if (t && !NOISE) {
        entry.events = entry.events || [];
        entry.events.push({ type: t, detail: String(ev.detail || '').slice(0, 120), state: String(ev.state || ''), at: String(ev.at || new Date().toISOString()) });
        if (entry.events.length > 15) entry.events.splice(0, entry.events.length - 15);
      }
    } catch { /* timeline is best-effort */ }
    const state = mapEventToState(ev);
    if (!state) return;
    // Carry WHY the session is waiting (waitReason) in the posted event string
    // so the row can say "2 questions" / "CAPTCHA" instead of a generic line.
    const session = manager.getSession(executionId);
    const reason = session && session.waitReason ? ':' + session.waitReason : '';
    const failureDetail = (ev.type === 'RUN_FAILED' || ev.type === 'JOB_MISMATCH') && ev.detail ? ':' + String(ev.detail).slice(0, 48) : '';
    const eventStr = `${String(ev.type || '')}${reason}${failureDetail}`.slice(0, 80);
    // Away-from-screen moments: needs-you and finished (OS-level, once each).
    try {
      const title = String((session && session.currentPlan && session.currentPlan.title) || 'Application');
      const company = String((session && session.currentPlan && session.currentPlan.company) || '');
      if (ev.type === 'HUMAN_ACTION_REQUIRED') {
        notifyNative(entry, 'need', 'Taylor AI — action needed', `${title}${company ? ' · ' + company : ''}: the run needs you.`);
      } else if (ev.type === 'SUBMISSION_CONFIRMED') {
        notifyNative(entry, 'applied', 'Taylor AI — applied ✓', `${title}${company ? ' · ' + company : ''}: submitted and confirmed.`);
      } else if (ev.type === 'RUN_FAILED' && !String(ev.detail || '').includes('STOPPED_BY_USER')) {
        notifyNative(entry, 'stopped', 'Taylor AI — run stopped', `${title}${company ? ' · ' + company : ''}: nothing was submitted unless confirmed. Open Taylor AI to restart.`);
      }
    } catch { /* notifications are best-effort */ }
    if (TERMINAL_STATES.has(state)) {
      sessions.delete(executionId);
      void fetch(STATUS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusToken: entry.statusToken, state, event: eventStr }),
      }).catch(() => {});
      return;
    }
    // Pre-authorized: verified + ready → submit automatically (no user click).
    if (state === 'READY_FOR_REVIEW' && entry.preAuthorizedSubmit && !entry.autoSubmitted) {
      entry.autoSubmitted = true;
      void runSubmit(executionId).then((r) => {
        // Blocked by a human checkpoint / verification: allow a retry once the
        // user resolves it and the session reaches READY_FOR_REVIEW again.
        if (r && r.ok !== true && ['CAPTCHA_REQUIRED', 'VERIFICATION_FAILED', 'SUBMIT_NOT_AUTHORIZED'].includes(String(r.code))) {
          entry.autoSubmitted = false;
        }
      });
    }
    // non-terminal state → post so Tailor AI rows update live (no focus steal)
    void fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusToken: entry.statusToken, state, event: eventStr }),
    }).catch(() => {});
  };

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }
    const path = String(req.url || '').split('?')[0];

    try {
      if (req.method === 'GET' && path === '/health') {
        // Identity: Chrome MUST reject anything else answering on this port.
        const snapshot = manager.getState();
        const sessionsOut = (snapshot.sessions || []).map((s) => {
          const entry = sessions.get(s.executionId);
          return { ...s, events: (entry && entry.events) || [] };
        });
        return json(res, 200, {
          available: true,
          app: 'tailor-browser',
          appVersion,
          version: '1.0.0',
          protocolVersion: 1,
          bootId,
          busy: sessionsOut.length > 0,
          visibleSessionId: snapshot.visibleSessionId,
          sessions: sessionsOut,
        }, origin);
      }

      if (req.method === 'POST' && path === '/auto-apply/start') {
        const body = await readJson(req);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        const executionToken = typeof body.executionToken === 'string' ? body.executionToken : '';
        if (!JOB_ID_RE.test(jobId) || !TOKEN_RE.test(executionToken)) return json(res, 400, { error: 'BAD_REQUEST' }, origin);
        const claim = await fetch(`${backendBase}/api/auto-apply/desktop-handoff/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // bootId: executions from OLDER app boots are dead — the server
          // supersedes them so they can never block new handoffs.
          body: JSON.stringify({ executionToken, jobId, bootId }),
        });
        const data = await claim.json().catch(() => null);
        if (!claim.ok) {
          const code = (data && data.error) || 'CLAIM_FAILED';
          const outStatus = claim.status === 409 || claim.status === 422 || claim.status === 401 ? claim.status : 401;
          // Pass the REAL reason through: blockers + message are what the row shows.
          return json(res, outStatus, {
            error: code,
            blockers: (data && data.blockers) || undefined,
            message: (data && data.message) || undefined,
            current: data && data.current,
            limit: data && data.limit,
          }, origin);
        }
        sessions.set(String(data.executionId), {
          statusToken: data.statusToken,
          attemptId: data.attemptId,
          userId: data.userId,
          jobId,
          preAuthorizedSubmit: data.preAuthorizedSubmit === true,
          autoSubmitted: false,
          events: [], // ring buffer of user-visible milestones (timeline)
        });
        let resumeBytes = null;
        if (data.plan && data.plan.resume && data.resumeUrl) {
          try {
            const rr = await fetch(`${backendBase}${data.resumeUrl}`);
            if (rr.ok) resumeBytes = Buffer.from(await rr.arrayBuffer());
          } catch { /* run continues; reported as RESUME_NOT_ATTACHED */ }
        }
        const session = manager.createSession({
          executionId: data.executionId,
          userId: data.userId,
          attemptId: data.attemptId,
          plan: data.plan,
          resumeBytes,
          resumeSha256: data.plan && data.plan.resume ? data.plan.resume.sha256 : undefined,
          resumeFilename: data.plan && data.plan.resume ? data.plan.resume.filename : undefined,
          preAuthorizedSubmit: data.preAuthorizedSubmit === true,
          statusToken: data.statusToken,
          backendBase,
        });
        // STEALTH execution: the new job becomes the session shown IF/WHEN the
        // user opens Tailor Browser (Eye), but the handoff NEVER steals focus —
        // the user stays inside Tailor AI.
        manager.setVisibleSession(data.executionId);
        void session.run();
        return json(res, 200, { accepted: true, desktopExecutionId: data.executionId, attemptId: data.attemptId, preAuthorizedSubmit: data.preAuthorizedSubmit === true }, origin);
      }

      if (req.method === 'POST' && path === '/auto-apply/submit') {
        const body = await readJson(req);
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        if (!sessions.has(executionId)) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const r = await runSubmit(executionId);
        return json(res, 200, r, origin);
      }

      if (req.method === 'POST' && path === '/auto-apply/continue') {
        const body = await readJson(req);
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        const session = manager.getSession(executionId);
        if (!session) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const r = await session.continueCheckpoint();
        return json(res, r.ok ? 200 : 409, r, origin);
      }

      if (req.method === 'POST' && path === '/auto-apply/focus') {
        const body = await readJson(req).catch(() => ({}));
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        if (executionId) {
          // Honest result: a stale executionId must NOT report success.
          const r = manager.setVisibleSession(executionId);
          if (!r || r.ok === false) return json(res, 404, { error: (r && r.code) || 'UNKNOWN_SESSION' }, origin);
        }
        if (typeof onFocus === 'function') onFocus();
        return json(res, 200, { ok: true }, origin);
      }

      // Deep-focus: land the window ON the exact field (scroll + highlight).
      if (req.method === 'POST' && path === '/auto-apply/focus-field') {
        const body = await readJson(req).catch(() => ({}));
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        const session = manager.getSession(executionId);
        if (!session) return json(res, 404, { error: 'UNKNOWN_SESSION' }, origin);
        const r = await session.focusField(body.ref, body.name);
        return json(res, r.ok ? 200 : 404, r, origin);
      }

      // Evidence: a small JPEG of the live page for the Needs-you panel.
      if (req.method === 'POST' && path === '/auto-apply/screenshot') {
        const body = await readJson(req).catch(() => ({}));
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        const session = manager.getSession(executionId);
        if (!session) return json(res, 404, { error: 'UNKNOWN_SESSION' }, origin);
        const r = await session.screenshot();
        return json(res, r.ok ? 200 : 404, r, origin);
      }

      // The USER asserts the outcome of an unconfirmed submission. "It
      // submitted" records a receipt (USER_ASSERTED) + Applied, exactly like a
      // detected confirmation — the human IS the evidence. Idempotent.
      if (req.method === 'POST' && path === '/auto-apply/assert-submitted') {
        const body = await readJson(req).catch(() => ({}));
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        const entry = sessions.get(executionId);
        const session = manager.getSession(executionId);
        if (!entry || !session) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const r = await fetch(`${backendBase}/api/auto-apply/desktop-execution/submitted`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statusToken: entry.statusToken, confirmationType: 'USER_ASSERTED' }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || data.ok !== true) {
          return json(res, 409, { error: (data && data.code) || 'ASSERT_FAILED' }, origin);
        }
        try {
          session.setState('SUBMITTED');
          session.emit('SUBMISSION_CONFIRMED', 'USER_ASSERTED');
        } catch { /* session may be mid-teardown */ }
        sessions.delete(executionId);
        setTimeout(() => manager.destroySession(executionId, 'APPLIED'), 3000);
        return json(res, 200, { ok: true, receiptId: data.receiptId || null, duplicate: data.duplicate === true }, origin);
      }

      if (req.method === 'POST' && path === '/auto-apply/stop') {
        const body = await readJson(req);
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        if (!sessions.has(executionId)) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const session = manager.getSession(executionId);
        if (session) session.emit('RUN_FAILED', 'STOPPED_BY_USER');
        manager.destroySession(executionId, 'STOPPED_BY_USER');
        sessions.delete(executionId);
        return json(res, 200, { ok: true, stopped: executionId }, origin);
      }

      // ── AGENT PRIMITIVES (Phase 1): the decision loop's hands ──────────
      // observe = read-only page inventory; act = ONE validated primitive.
      // Neither makes decisions; submit stays on the authorized path.
      if (req.method === 'POST' && path === '/agent/observe') {
        const body = await readJson(req);
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        if (!sessions.has(executionId)) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const session = manager.getSession(executionId);
        if (!session) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const r = await session.observe();
        return json(res, r.ok ? 200 : 409, r, origin);
      }

      if (req.method === 'POST' && path === '/agent/act') {
        const body = await readJson(req);
        const executionId = typeof body.executionId === 'string' ? body.executionId : '';
        if (!sessions.has(executionId)) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const session = manager.getSession(executionId);
        if (!session) return json(res, 409, { error: 'EXECUTION_MISMATCH' }, origin);
        const r = await session.act(body.action);
        return json(res, 200, r, origin);
      }

      return json(res, 404, { error: 'NOT_FOUND' }, origin);
    } catch (e) {
      return json(res, 500, { error: 'BRIDGE_ERROR', message: String((e && e.message) || e).slice(0, 80) }, origin);
    }
  });

  server.on('error', (e) => {
    console.error('TAILOR_DESKTOP_BRIDGE_ERROR', (e && e.code) || String(e));
  });
  server.listen(port, '127.0.0.1');
  startHeartbeat();

  return {
    server,
    postStatus,
    getSessions: () => [...sessions.keys()],
    close: () => {
      clearInterval(heartbeat);
      heartbeat = null;
      try {
        server.close();
      } catch { /* already closed */ }
    },
  };
}

module.exports = { createDesktopBridge, mapEventToState, ALLOWED_ORIGINS, PORT };
