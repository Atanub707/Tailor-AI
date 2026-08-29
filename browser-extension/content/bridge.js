// Tailor AI Browser Companion — Tailor UI bridge (content script on the
// local web app origin). Relays ONLY minimal activation messages. Answers,
// tokens, and secrets NEVER traverse the page.
(() => {
  const ALLOWED_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!ALLOWED_ORIGINS.includes(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (typeof data.type !== 'string' || !data.type.startsWith('TAILOR_')) return;

    if (data.type === 'TAILOR_PING') {
      chrome.runtime.sendMessage({ type: 'TAILOR_PING' }, (r) => {
        window.postMessage({ type: 'TAILOR_PONG', ...(r || {}) }, event.origin);
      });
      return;
    }

    if (data.type === 'TAILOR_START_ASSIST') {
      // The web UI may send ONLY a sessionId (created by its own backend).
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
      chrome.runtime.sendMessage({ type: 'TAILOR_START_ASSIST', sessionId }, (r) => {
        window.postMessage({ type: 'TAILOR_ASSIST_STARTED', ...(r || {}) }, event.origin);
      });
      return;
    }
  });
})();