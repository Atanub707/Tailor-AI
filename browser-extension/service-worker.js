// Tailor AI Browser Companion — service worker (MV3).
// ALL localhost traffic happens here (CORS-exempt via host_permissions).
// Content scripts never fetch localhost. No secrets in logs.
const API_BASE = 'http://127.0.0.1:3000/api/browser-companion';
const PROTOCOL_VERSION = 1;

const LOG = (...args) => { console.log('[companion]', ...args); };

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
    const { sessionId, eventType, reasonCode, metadata } = message;
    if (!sessionId || !eventType) { sendResponse({ ok: false, code: 'INVALID_EVENT' }); return; }
    (async () => {
      const s = await chrome.storage.session.get('bearer');
      if (!s.bearer) { sendResponse({ ok: false, code: 'NO_BEARER' }); return; }
      await localFetch(`/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: eventType, reasonCode, metadata }),
        headers: { Authorization: `Bearer ${s.bearer}` },
      });
      sendResponse({ ok: true });
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