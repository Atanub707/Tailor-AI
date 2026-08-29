// Tailor AI Browser Companion — service worker (MV3).
// ALL localhost traffic happens here (CORS-exempt via host_permissions).
// Content scripts never fetch localhost. No secrets in logs.
const API_BASE = 'http://127.0.0.1:3000/api/browser-companion';
const PROTOCOL_VERSION = 1;

const LOG = (...args) => { console.log('[companion]', ...args); };

// Secret isolation: pairing secret readable only by trusted extension
// contexts (never content scripts). Ignored on browsers without support.
if (chrome.storage?.local?.setAccessLevel) {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

async function localFetch(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    // PNA-safe: explicit local address space
    targetAddressSpace: 'local',
  });
  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    try { const d = await res.json(); code = d.code || d.error || code; } catch {}
    throw new Error(code);
  }
  return res.json();
}

async function getPairing() {
  const p = await chrome.storage.local.get(['pairingId', 'installSecret']);
  return p.pairingId && p.installSecret ? p : null;
}

async function isPaired() {
  const p = await getPairing();
  if (!p) return false;
  try {
    const r = await localFetch('/status', { method: 'POST', body: JSON.stringify(p) });
    return r.paired === true;
  } catch { return false; }
}

// ── Web UI bridge (content script relays postMessage) ─────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const { type } = message;

  if (type === 'TAILOR_PING') {
    isPaired().then((paired) => sendResponse({ paired, protocolVersion: PROTOCOL_VERSION }));
    return true;
  }

  if (type === 'TAILOR_START_ASSIST') {
    // The web UI sends ONLY {sessionId} — the extension claims the token
    // from localhost; answers/resume/tokens never traverse the page bridge.
    const { sessionId } = message;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
      sendResponse({ ok: false, code: 'INVALID_SESSION' });
      return true;
    }
    (async () => {
      const p = await getPairing();
      if (!p) { sendResponse({ ok: false, code: 'PAIRING_REQUIRED' }); return; }
      const claimed = await localFetch(`/sessions/${encodeURIComponent(sessionId)}/claim`, {
        method: 'POST',
        body: JSON.stringify(p),
      });
      const payload = await localFetch(`/sessions/${encodeURIComponent(sessionId)}/payload`, {
        headers: { Authorization: `Bearer ${claimed.token}` },
      });
      sendResponse({ ok: true, canonicalActionUrl: payload.canonicalActionUrl, sessionId });
    })().catch((e) => sendResponse({ ok: false, code: String(e.message || e) }));
    return true;
  }

  if (type === 'TAILOR_ASSIST_EVENT') {
    // Content script → localhost event relay (bearer already stored in
    // chrome.storage.session for this SW instance).
    const { sessionId, eventType, reasonCode, metadata, clientEventId } = message;
    if (!sessionId || !eventType) { sendResponse({ ok: false, code: 'INVALID_EVENT' }); return; }
    (async () => {
      const s = await chrome.storage.session.get('bearer');
      if (!s.bearer) { sendResponse({ ok: false, code: 'NO_BEARER' }); return; }
      await localFetch(`/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: eventType, reasonCode, metadata, clientEventId }),
        headers: { Authorization: `Bearer ${s.bearer}` },
      });
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, code: String(e.message || e) }));
    return true;
  }

  if (type === 'LEVER_FETCH_RESUME') {
    // Fetch the EXACT approved resume bytes from the backend (session
    // bearer only) and hand ONLY the bytes to the content script.
    const { sessionId } = message;
    if (!sessionId) { sendResponse({ ok: false, code: 'NO_SESSION' }); return; }
    (async () => {
      const s = await chrome.storage.session.get('bearer');
      if (!s.bearer) { sendResponse({ ok: false, code: 'NO_BEARER' }); return; }
      const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/resume`, {
        headers: { Authorization: `Bearer ${s.bearer}` },
        targetAddressSpace: 'local',
      });
      if (!res.ok) { sendResponse({ ok: false, code: 'RESUME_' + res.status }); return; }
      const bytes = await res.arrayBuffer();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : 'resume.pdf';
      // Route to the tab's content script (the lever page is the only
      // recipient; bytes never stored).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) { sendResponse({ ok: false, code: 'NO_TAB' }); return; }
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'LEVER_RESUME', sessionId, bytes, filename, mimeType: 'application/pdf' });
      bytes = null;
      sendResponse({ ok: !!r && r.ok === true, code: r?.code });
    })().catch((e) => sendResponse({ ok: false, code: String(e.message || e) }));
    return true;
  }

  return false;
});

// ── Lever content script ↔ SW: session bootstrap for the current tab ──────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'LEVER_BOOTSTRAP') return;
  const { sessionId } = message;
  if (!sessionId) { sendResponse({ ok: false, code: 'NO_SESSION' }); return; }
  (async () => {
    const p = await getPairing();
    if (!p) { sendResponse({ ok: false, code: 'PAIRING_REQUIRED' }); return; }
    const claimed = await localFetch(`/sessions/${encodeURIComponent(sessionId)}/claim`, {
      method: 'POST', body: JSON.stringify(p),
    });
    await chrome.storage.session.set({ bearer: claimed.token });
    const payload = await localFetch(`/sessions/${encodeURIComponent(sessionId)}/payload`, {
      headers: { Authorization: `Bearer ${claimed.token}` },
    });
    sendResponse({ ok: true, payload });
  })().catch((e) => sendResponse({ ok: false, code: String(e.message || e) }));
  return true;
});

LOG('service worker ready (protocol ' + PROTOCOL_VERSION + ')');