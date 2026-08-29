// Tailor AI Browser Companion — options page: pairing/unpairing.
const statusEl = document.getElementById('status');
const setStatus = (text, ok) => {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'err';
};

async function localFetch(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:3000/api/browser-companion${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    targetAddressSpace: 'local',
  });
  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    try { const d = await res.json(); code = d.code || d.error || code; } catch {}
    throw new Error(code);
  }
  return res.json();
}

async function refresh() {
  const p = await chrome.storage.local.get(['pairingId', 'installSecret']);
  if (!p.pairingId) { setStatus('Not paired. Get a pairing code from the Tailor AI app, then paste it above.', false); return; }
  try {
    const r = await localFetch('/status', { method: 'POST', body: JSON.stringify({ pairingId: p.pairingId, installSecret: p.installSecret }) });
    setStatus(r.paired ? `Paired (protocol v${r.protocolVersion}).` : 'Pairing revoked — re-pair to continue.', r.paired);
  } catch (e) {
    setStatus(`Tailor AI not reachable (${e.message}). Start the app first.`, false);
  }
}

document.getElementById('pair').addEventListener('click', async () => {
  const code = document.getElementById('code').value.trim();
  if (!code) { setStatus('Enter the one-time pairing code.', false); return; }
  try {
    const r = await localFetch('/pair', { method: 'POST', body: JSON.stringify({ code }) });
    await chrome.storage.local.set({ pairingId: r.pairingId, installSecret: r.installSecret });
    document.getElementById('code').value = '';
    setStatus('Paired successfully.', true);
  } catch (e) {
    setStatus(`Pairing failed (${e.message}).`, false);
  }
});

document.getElementById('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['pairingId', 'installSecret']);
  setStatus('Unpaired locally. Revoke in the Tailor AI app to invalidate this installation.', false);
});

refresh();