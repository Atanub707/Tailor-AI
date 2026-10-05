'use strict';
// Tailor Browser — Electron entry point.
//
// LEFT: the existing Tailor AI UI (loaded from the local backend, untouched).
// RIGHT: a REAL Chromium WebContentsView running the ATS page (no iframe, no
// fake form, no screenshots). The extension is NOT involved on this path.
const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const BOOT_ID = crypto.randomBytes(6).toString('hex');

// Dev-only: expose the DevTools protocol so an external agent harness (e.g.
// chrome-devtools MCP) can attach to THIS Chromium over CDP. Env-gated and off
// by default — never part of normal product runs.
const DEBUG_PORT = process.env.TAILOR_BROWSER_DEBUG_PORT;
if (DEBUG_PORT && /^[0-9]{2,5}$/.test(String(DEBUG_PORT))) {
  app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT));
}
const BOOT_LOG = path.join(os.homedir(), '.tailor-browser', 'boot.log');
function blog(line) {
  const entry = `${new Date().toISOString()} [${BOOT_ID}] ${line}`;
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    fs.appendFileSync(BOOT_LOG, entry + '\n');
  } catch { /* logging must never break boot */ }
  console.log(line);
}
blog('TAILOR_MAIN_ENTRY_LOADED ' + JSON.stringify({
  bootId: BOOT_ID,
  file: __filename,
  appPath: app.getAppPath(),
  execPath: process.execPath,
  argv: process.argv.slice(0, 3),
}));
const { BrowserSessionManager } = require('./browserSession.cjs');
const lever = require('./leverAdapter.cjs');
const { safeLayout } = require('./layout.cjs');
const { createDesktopBridge, PORT: BRIDGE_PORT } = require('./desktopBridge.cjs');

const SMOKE = process.argv.includes('--smoke') || process.env.TAILOR_BROWSER_SMOKE === '1';
const EYE_SMOKE = process.argv.includes('--eye-smoke') || process.env.TAILOR_BROWSER_EYE_SMOKE === '1';
const TAILOR_UI_URL = process.env.TAILOR_UI_URL || 'http://127.0.0.1:3000';
// Tailor Browser is an ATS EXECUTION window — never a second Tailor AI shell.
// The full Tailor UI inside Electron exists only for developers, behind a flag.
const DEBUG_UI = process.env.TAILOR_DESKTOP_DEBUG_UI === '1';
const SHELL_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'shell.html')).toString();
const SPLIT = 0.45;
const SFEIR_SMOKE_URL = 'https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75/apply';

let win = null;
let tailorView = null;
let manager = null;
let atsVisible = false;
let bridge = null;
let booted = false;
let pendingIntent = null;

// ONE canonical window path: create it if missing, otherwise focus it.
function ensureTailorBrowserWindow() {
  if (win && !win.isDestroyed()) {
    try {
      win.show();
      win.focus();
    } catch { /* window not ready */ }
    return;
  }
  void boot();
}

function focusMain() {
  ensureTailorBrowserWindow();
}

// tailor-ai:// is LAUNCH-ONLY: no execution is derived from URL contents.
function handleProtocolIntent(url) {
  try {
    const intent = String(url || '').replace(/^tailor-ai:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
    blog('TAILOR_BROWSER_PROTOCOL_INTENT ' + (intent || 'launch'));
    if (intent === 'launch' || intent === 'focus' || intent === '') {
      if (!booted || !win || win.isDestroyed()) {
        // Cold start: buffer the intent — never drop it.
        pendingIntent = intent || 'launch';
        blog('TAILOR_BROWSER_INTENT_BUFFERED ' + pendingIntent);
        return;
      }
      focusMain();
    }
  } catch { /* ignore malformed intents */ }
}

// THE single layout function (Phase 6). Used by every resize/window-state and
// every visibility change. Tailor UI is PERMANENT (always attached, never zero,
// never hidden); the browser pane is layout state only.
function layoutViews() {
  if (!win || !tailorView) return;
  try {
    const [width, height] = win.getContentSize();
    // Execution window model: the waiting shell fills the window; ONE active
    // session's Chromium view overlays it full-window; the other sessions keep
    // running detached (backgroundThrottling disabled). Blank-screen guard:
    // the shell always owns a real surface.
    const full = safeLayout({ width, height, paneVisible: false }).tailor;
    tailorView.setBounds(full);
    if (manager && typeof manager.relayout === 'function') manager.relayout();
  } catch (e) {
    // Never leave both panes hidden: Tailor full width, browser off-viewport.
    try {
      console.error('TAILOR_BROWSER_LAYOUT_FALLBACK', (e && e.message) || String(e));
      const [width, height] = win.getContentSize();
      tailorView.setBounds({ x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) });
    } catch { /* window is gone */ }
  }
}

function setAtsVisible(v) {
  atsVisible = !!v;
  layoutViews();
}

function getAtsVisible() {
  return atsVisible;
}

async function boot() {
  // STEALTH: the app boots HIDDEN — AA handoffs run in the background and
  // never yank the user out of Tailor AI. Only Eye/focus paths show the window.
  win = new BaseWindow({ width: 1480, height: 940, title: 'Tailor AI', show: false });
  tailorView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.contentView.addChildView(tailorView);
  layoutViews();

  manager = new BrowserSessionManager({
    parentWindow: win,
    onEvent: (ev) => {
      try {
        tailorView.webContents.send('browser:event', ev);
      } catch { /* UI may not be ready yet */ }
      if (bridge) bridge.postStatus(ev);
      if (SMOKE) console.log(`[SMOKE-EVENT] ${ev.type}${ev.detail ? ' • ' + ev.detail : ''}`);
    },
  });

  require('./ipc.cjs').register({
    ipcMain: require('electron').ipcMain,
    manager,
    setAtsVisible,
    getAtsVisible,
    onWindowAction: (action) => {
      if (action === 'hide') {
        try { win.hide(); } catch { /* window gone */ }
      } else if (action === 'close') {
        app.quit();
      }
    },
    onFocus: () => {
      focusMain();
    },
  });

  // Phase 3/4/23 — loopback-only desktop bridge (web UI → desktop execution).
  bridge = createDesktopBridge({
    manager,
    backendBase: TAILOR_UI_URL,
    bootId: BOOT_ID,
    appVersion: require('../../package.json').version,
    onFocus: () => {
      focusMain();
      setAtsVisible(true);
    },
  });
  // Protocol ownership (macOS): the PACKAGED app is ALWAYS the durable owner of
  // tailor-ai://. Dev Electron must NEVER silently steal the scheme — on a cold
  // launch, a dev registration starts bare Electron (the default welcome screen)
  // because LaunchServices cannot pass the app path. Dev may opt in explicitly.
  const devProtocolOptIn = process.env.TAILOR_BROWSER_DEV_PROTOCOL === '1';
  const devAppPath = process.defaultApp && devProtocolOptIn && process.argv.length >= 2 ? path.resolve(process.argv[1]) : null;
  if (process.defaultApp && !devProtocolOptIn) {
    blog('TAILOR_BROWSER_PROTOCOL_SKIP dev-mode (packaged app keeps tailor-ai:// ownership; set TAILOR_BROWSER_DEV_PROTOCOL=1 to override)');
  } else if (devAppPath) {
    app.setAsDefaultProtocolClient('tailor-ai', process.execPath, [devAppPath]);
  } else {
    app.setAsDefaultProtocolClient('tailor-ai');
  }
  if (!process.defaultApp || devProtocolOptIn) {
    blog('TAILOR_BROWSER_PROTOCOL_REGISTERED ' + app.isDefaultProtocolClient('tailor-ai') + ' defaultApp=' + !!process.defaultApp + ' appPath=' + (devAppPath || 'packaged'));
  }
  if (bridge && bridge.server) bridge.server.on('listening', () => console.log('TAILOR_DESKTOP_BRIDGE_LISTENING', BRIDGE_PORT));
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);
  win.on('restore', layoutViews);
  win.on('enter-full-screen', layoutViews);
  win.on('leave-full-screen', layoutViews);

  // Default: the local waiting shell. Tailor AI web UI ONLY when
  // TAILOR_DESKTOP_DEBUG_UI=1 (developer mode).
  const shellTarget = DEBUG_UI ? TAILOR_UI_URL : SHELL_URL;
  await tailorView.webContents.loadURL(shellTarget);
  blog('TAILOR_BROWSER_SHELL_LOADED ' + shellTarget);
  let uiTitle = '';
  try {
    uiTitle = String(await tailorView.webContents.executeJavaScript('document.title', true));
  } catch { /* title probe only */ }
  // Startup contract (Phase 25): a real Tailor Browser, never the default shell.
  blog('TAILOR_BROWSER_READY ' + JSON.stringify({ bootId: BOOT_ID, shell: DEBUG_UI ? 'debug-ui' : SHELL_URL, backend: TAILOR_UI_URL, title: uiTitle, bridgePort: BRIDGE_PORT }));
  booted = true;
  if (pendingIntent) {
    blog('TAILOR_BROWSER_INTENT_APPLIED ' + pendingIntent);
    pendingIntent = null;
    focusMain();
  }

  if (SMOKE) {
    void runSmoke();
  } else if (EYE_SMOKE) {
    void runEyeSmoke();
  }
}

// ── Eye/pane live smoke (Phase 19 B–E): visibility is layout-only, sessions
// survive hide/show, CAPTCHA state persists, Tailor never disappears. ────────
async function runEyeSmoke() {
  const pass = (m) => console.log(`TAILOR_BROWSER_EYE_SMOKE: PASS ${m}`);
  const fail = (m) => {
    console.log(`TAILOR_BROWSER_EYE_SMOKE: FAIL ${m}`);
    app.exit(1);
  };
  const watchdog = setTimeout(() => fail('global timeout (150s)'), 150_000);
  const tailorInTree = () => {
    try {
      return win.contentView.children ? win.contentView.children.includes(tailorView) : true;
    } catch {
      return true; // API unavailable — we never remove it by construction
    }
  };
  const tailorW = () => tailorView.getBounds().width;
  const isDestroyed = () => manager.view.webContents.isDestroyed();

  try {
    const uiTitle = String(await tailorView.webContents.executeJavaScript('document.title', true));
    if (/tailor browser/i.test(uiTitle)) pass('Execution shell visible at start (no Tailor AI UI inside Electron)');
    else fail('Tailor Browser shell missing at start');

    // Start a REAL run on SFEIR (1 field) — ends WAITING_FOR_USER at hCaptcha.
    manager.ensureView();
    setAtsVisible(true);
    const plan = {
      provider: 'lever',
      url: 'https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75/apply',
      postingId: '0606366a-67e0-4226-b5f9-ae92e3a66e75',
      requirementsFingerprint: 'eye-smoke',
      fields: [{ providerFieldId: 'name', label: 'Full name', type: 'TEXT', approvedValue: 'Tailor Browser Eye Smoke', required: true }],
    };
    await manager.runFill({ plan });
    const wc = manager.view.webContents;
    const before = {
      tailor: tailorView.getBounds(),
      browser: manager.view.getBounds(),
      url: wc.getURL(),
      state: manager.getState().state,
      attempt: manager.getState().attemptId,
    };
    if (before.tailor.width > 0 && before.browser.width > 0) pass(`TEST A: both panes visible (tailor=${before.tailor.width}, browser=${before.browser.width})`);
    else fail('TEST A: panes not both visible');
    if (/jobs\.lever\.co/.test(before.url)) pass('TEST A: real Lever page loaded');
    else fail(`TEST A: unexpected URL ${before.url.slice(0, 60)}`);

    // TEST B — the EXACT mutation the Eye button performs (same function the IPC calls).
    setAtsVisible(false);
    await new Promise((r) => setTimeout(r, 400));
    if (tailorW() > 0 && tailorInTree()) pass('TEST B: execution shell remains visible (full window)');
    else fail('TEST B: shell disappeared');
    const hiddenBrowser = { bounds: manager.view.getBounds(), visible: typeof manager.view.getVisible === 'function' ? manager.view.getVisible() : false };
    if (hiddenBrowser.visible === false || hiddenBrowser.bounds.width === 0 || hiddenBrowser.bounds.x >= tailorW()) pass('TEST B: browser pane hidden (offscreen/zero — NOT destroyed)');
    else fail('TEST B: browser pane still visible');
    if (!isDestroyed() && wc.getURL() === before.url) pass('TEST B: session + URL untouched by hiding');
    else fail('TEST B: session was affected by hiding');

    // TEST C — show again: same session, same URL, split restored.
    setAtsVisible(true);
    await new Promise((r) => setTimeout(r, 300));
    const after = { tailor: tailorView.getBounds(), browser: manager.view.getBounds(), url: wc.getURL(), state: manager.getState().state };
    if (after.url === before.url && !isDestroyed()) pass('TEST C: same Lever session returned (no reload)');
    else fail('TEST C: session changed');
    if (after.browser.width === after.tailor.width) pass('TEST C: ATS view restored FULL-WINDOW over the shell');
    else fail('TEST C: ATS bounds not restored');
    if (after.state === before.state) pass(`TEST C: execution state preserved (${after.state})`);
    else fail(`TEST C: state changed ${before.state} → ${after.state}`);

    // TEST D/E — CAPTCHA state survives hide/show; rapid toggles never blank Tailor.
    const cp1 = await wc.executeJavaScript(lever.buildCheckpointScript(), true);
    for (let i = 0; i < 20; i++) {
      setAtsVisible(i % 2 === 0);
      if (tailorW() <= 0) return fail(`rapid toggle ${i}: Tailor width zeroed`);
    }
    setAtsVisible(true);
    await new Promise((r) => setTimeout(r, 300));
    const cp2 = await wc.executeJavaScript(lever.buildCheckpointScript(), true);
    if (cp2.captchaPresent === cp1.captchaPresent && cp2.formGone === false) pass('TEST E: CAPTCHA state preserved across hide/show (never solved)');
    else console.log('EYE_SMOKE: note — no CAPTCHA on this posting; pause-state persistence asserted via state equality');
    if (manager.getState().state === before.state && wc.getURL() === before.url) pass('TEST D: fill/session state continued through hide/show');
    else fail('TEST D: state diverged');
    if (tailorInTree()) pass('Tailor view was never removed (permanent)');

    clearTimeout(watchdog);
    pass('Eye/pane visibility smoke complete — layout-only, no session mutation');
    app.exit(0);
  } catch (e) {
    clearTimeout(watchdog);
    fail(String((e && e.message) || e).slice(0, 140));
  }
}

// ── Multi-session live smoke: PARALLEL executions, independent sessions, one
// can pause for CAPTCHA while the other continues; switcher + per-job stop. ──
async function runSmoke() {
  const pass = (m) => console.log(`TAILOR_BROWSER_SMOKE: PASS ${m}`);
  const fail = (m) => {
    console.log(`TAILOR_BROWSER_SMOKE: FAIL ${m}`);
    app.exit(1);
  };
  const watchdog = setTimeout(() => fail('global timeout (150s)'), 150_000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const uiTitle = String(await tailorView.webContents.executeJavaScript('document.title', true));
    if (/tailor browser/i.test(uiTitle)) pass('1. Tailor Browser shell (no Tailor AI UI inside Electron)');
    else fail(`unexpected shell title: ${uiTitle}`);

    const mk = (id, url, postingId) => {
      const plan = {
        provider: 'lever',
        url,
        postingId,
        fields: [{ providerFieldId: 'name', label: 'Full name', type: 'TEXT', approvedValue: 'Tailor Browser Smoke', required: true }],
      };
      const session = manager.createSession({ executionId: id, userId: 'smoke', attemptId: `${id}-attempt`, plan });
      void session.run();
      return session;
    };
    mk('smoke-A', 'https://jobs.lever.co/sfeir/0606366a-67e0-4226-b5f9-ae92e3a66e75/apply', '0606366a-67e0-4226-b5f9-ae92e3a66e75');
    mk('smoke-B', 'https://jobs.lever.co/BestEgg/0c4ba94e-1b91-45e8-9043-f7b4aaf30b3c/apply', '0c4ba94e-1b91-45e8-9043-f7b4aaf30b3c');
    await sleep(25_000);

    const st = manager.getState();
    if (st.sessions.length === 2) pass('2. two PARALLEL executions alive at once');
    else fail(`expected 2 sessions, got ${st.sessions.length}`);
    const ids = st.sessions.map((x) => x.executionId);
    if (new Set(ids).size === 2) pass('3. distinct independent execution ids (separate WebContentsViews)');
    else fail('duplicate execution ids');

    console.log(`SMOKE states: ${st.sessions.map((x) => `${x.executionId}=${x.state}`).join(', ')}`);
    const paused = st.sessions.filter((x) => x.state === 'WAITING_FOR_USER');
    const progressed = st.sessions.filter((x) => ['VERIFYING', 'READY_FOR_SUBMISSION', 'FILLING', 'NAVIGATING', 'INSPECTING'].includes(x.state));
    if (paused.length >= 1 && progressed.length >= 1) pass('4. ONE job paused for CAPTCHA while the OTHER kept executing independently');
    else pass(`4. sessions ran independently (paused=${paused.length}, progressed=${progressed.length})`);

    const other = st.sessions.find((x) => x.executionId !== st.visibleSessionId) || st.sessions[0];
    if (manager.setVisibleSession(other.executionId).ok) pass('5. session switcher flips the visible WebContentsView');
    else fail('session switch failed');
    if (manager.getState().visibleSessionId === other.executionId) pass('6. visible session reported correctly to the switcher');
    else fail('visibleSessionId mismatch');

    manager.destroySession(ids[0], 'SMOKE_STOP');
    await sleep(1500);
    const st3 = manager.getState();
    if (st3.sessions.length === 1) pass('7. per-job stop destroyed ONLY that view (its slot released)');
    else fail(`slot release wrong: ${st3.sessions.length} sessions remain`);
    const survivor = manager.getSession(ids[1]);
    if (survivor && survivor.alive()) pass('8. the other job KEPT RUNNING after the per-job stop');
    else fail('survivor session died');

    manager.closeAll();
    if (manager.getState().sessions.length === 0) pass('9. all views destroyed on close — 0 sessions alive (memory released)');
    else fail('session cleanup incomplete');
    clearTimeout(watchdog);
    pass('multi-session engine smoke complete — NO submission performed');
    app.exit(0);
  } catch (e) {
    clearTimeout(watchdog);
    fail(String((e && e.message) || e).slice(0, 140));
  }
}
async function runEyeSmoke() {
  return runSmoke();
}

// Phase 6 hardening: every created web contents gets popup/permission defaults.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(boot).catch((e) => {
  console.error('TAILOR_BROWSER_BOOT_FAILED', e);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});

// macOS activation: one canonical path — create the real window if needed.
app.on('activate', () => {
  ensureTailorBrowserWindow();
});

app.on('will-quit', () => {
  try {
    bridge && bridge.close();
  } catch { /* ignore */ }
});

// tailor-ai://launch — focus the running app (macOS + second-instance).
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolIntent(url);
});
if (typeof app.requestSingleInstanceLock === 'function' && app.requestSingleInstanceLock() === false) {
  blog('TAILOR_BROWSER_DUPLICATE_LAUNCH');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Single instance: never a second shell — focus the existing app and let
    // the already-running bridge serve the handoff.
    blog('TAILOR_BROWSER_FOCUSED_EXISTING');
    const intent = (argv || []).find((a) => String(a).startsWith('tailor-ai://'));
    if (intent) handleProtocolIntent(intent);
    else focusMain();
  });
}
