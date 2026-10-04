'use strict';
// Tailor Browser — IPC contract (Phase 7). The renderer is UNTRUSTED:
// every payload is validated here before it reaches the session manager.
// There is deliberately NO arbitrary code-execution channel: only the seven
// validated commands below can ever reach the browser session.
const lever = require('./leverAdapter.cjs');

const MAX_RESUME_BYTES = 10 * 1024 * 1024;

function register({ ipcMain, manager, setAtsVisible, getAtsVisible, onWindowAction, onFocus }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        return { ok: false, code: 'IPC_ERROR', message: String((err && err.message) || err).slice(0, 120) };
      }
    });
  };

  handle('browser:createSession', async (userId) => {
    manager.userId = String(userId || '').slice(0, 64);
    manager.ensureView();
    setAtsVisible(true);
    return { ok: true, partition: manager.partition, state: manager.getState() };
  });

  handle('browser:show', async () => {
    if (!manager.view) return { ok: false, code: 'NO_SESSION', visible: false };
    setAtsVisible(true);
    return { ok: true, visible: true };
  });

  // Hiding never destroys the session — the view (and its profile) stays alive.
  handle('browser:hide', async () => {
    setAtsVisible(false);
    return { ok: true, visible: false, state: manager.getState() };
  });

  // Phase 17 — explicit visibility command (Eye button in desktop mode).
  handle('browser:setVisibility', async (visible) => {
    const v = visible === true;
    if (v && !manager.view) return { ok: false, code: 'NO_SESSION', visible: false };
    setAtsVisible(v);
    return { ok: true, visible: v };
  });

  handle('browser:getState', async () => ({ ok: true, ...manager.getState(), paneVisible: typeof getAtsVisible === 'function' ? getAtsVisible() : false }));
  handle('browser:focusSession', async (executionId) => {
    const r = manager.setVisibleSession(String(executionId || ''));
    if (r.ok && typeof onFocus === 'function') onFocus();
    return r;
  });

  handle('browser:resume', async () => manager.resumeCheckpoint());

  handle('browser:runFill', async (payload) => {
    const plan = payload && payload.plan;
    const v = lever.validatePlan(plan);
    if (!v.ok) return { ok: false, code: 'PLAN_REJECTED', errors: v.errors };
    let resumeBytes = null;
    if (payload && payload.resumeBytes) {
      const buf = Buffer.from(payload.resumeBytes);
      if (buf.length > MAX_RESUME_BYTES) return { ok: false, code: 'RESUME_TOO_LARGE' };
      if (buf.subarray(0, 5).toString('ascii') !== '%PDF-') return { ok: false, code: 'RESUME_INVALID' };
      resumeBytes = buf;
    }
    manager.ensureView();
    setAtsVisible(true);
    return manager.runFill({
      plan,
      resumeBytes,
      resumeSha256: payload && payload.resumeSha256,
      resumeFilename: payload && payload.resumeFilename,
    });
  });

  // Waiting-shell window controls (hide/close only — never navigation).
  handle('browser:windowAction', async (action) => {
    if (action !== 'hide' && action !== 'close') return { ok: false, code: 'BAD_ACTION' };
    if (typeof onWindowAction === 'function') onWindowAction(action);
    return { ok: true };
  });

  handle('browser:close', async () => {
    manager.close();
    return { ok: true };
  });
}

module.exports = { register, MAX_RESUME_BYTES };
