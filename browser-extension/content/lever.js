// Tailor AI Browser Companion — Lever content script (ISOLATED world, top
// frame only). Verifies page identity BEFORE any fill, inspects the current
// form, fills ONLY approved values mapped to the CURRENT DOM, detects
// hCaptcha structurally, and NEVER clicks submit. Resume untouched.
(() => {
  if (window.top !== window) return; // top frame only

  const SESSION_KEY = 'activeSession';

  function report(sessionId, type, reasonCode, metadata = {}) {
    chrome.runtime.sendMessage({ type: 'TAILOR_ASSIST_EVENT', sessionId, eventType: type, reasonCode, metadata }, () => {});
  }

  // ── DOM facade (same contract as the tested leverPageAdapter) ──────────
  function facadeForm() {
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    if (!form) return null;
    const inputs = [];
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && ['hidden', 'file', 'submit', 'button'].includes((el.type || '').toLowerCase())) continue;
      const options = [];
      if (tag === 'select') {
        for (const o of el.options) options.push(o.value);
      } else if (tag === 'input' && (el.type === 'radio' || el.type === 'checkbox')) {
        const name = el.name;
        for (const same of form.querySelectorAll(`input[name="${CSS.escape(name)}"]`)) options.push(same.value);
      }
      inputs.push({
        name: el.name || '',
        type: tag === 'textarea' ? 'textarea' : el.type || 'text',
        value: el.value || '',
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        options,
        tagName: tag.toUpperCase(),
        el,
      });
    }
    return { id: form.id, enctype: form.getAttribute('enctype') || '', inputs };
  }

  function parseIdentity(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.hostname !== 'jobs.lever.co') return null;
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length < 2) return null;
      const isApply = seg[seg.length - 1] === 'apply';
      return { hostname: u.hostname, siteSlug: seg[0], postingId: isApply ? seg[seg.length - 2] : seg[seg.length - 1], isApplyPage: isApply };
    } catch { return null; }
  }

  function verify(expected) {
    const id = parseIdentity(location.href);
    if (!id || !id.isApplyPage) return 'PAGE_IDENTITY_MISMATCH';
    if (id.siteSlug !== expected.siteSlug) return 'PAGE_IDENTITY_MISMATCH';
    if (id.postingId !== expected.postingId) return 'PAGE_IDENTITY_MISMATCH';
    const form = facadeForm();
    if (!form || (form.id && form.id !== 'application-form')) return 'PAGE_IDENTITY_MISMATCH';
    return 'OK';
  }

  function findInput(form, name) {
    return form.inputs.find((i) => i.name === name);
  }

  function fillOne(form, field) {
    const el = findInput(form, field.providerFieldId);
    if (!el) return 'FIELD_MISSING';
    const { el: domEl, kind } = el;
    if (kind === 'SELECT') {
      if (field.approvedValue !== '' && !el.options.includes(String(field.approvedValue))) return 'OPTION_CHANGED';
      if (field.approvedValue !== '') {
        domEl.value = String(field.approvedValue);
        domEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return 'OK';
    }
    if (kind === 'RADIO') {
      const match = form.inputs.filter((i) => i.name === field.providerFieldId && i.type === 'radio');
      if (match.length && !match.some((i) => i.value === String(field.approvedValue))) return 'OPTION_CHANGED';
      const target = match.find((i) => i.value === String(field.approvedValue));
      if (target) { target.el.checked = true; target.el.dispatchEvent(new Event('change', { bubbles: true })); }
      return 'OK';
    }
    if (kind === 'CHECKBOX') {
      // Exact approved boolean only; consent/EEO decisions already in the
      // approval — no inference, no marketing default.
      const match = form.inputs.filter((i) => i.name === field.providerFieldId && i.type === 'checkbox');
      const target = match.find((i) => i.value === '1') || match[0];
      if (target) {
        target.el.checked = field.approvedValue === true;
        target.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return 'OK';
    }
    // text / email / tel / textarea
    domEl.value = String(field.approvedValue);
    domEl.dispatchEvent(new Event('input', { bubbles: true }));
    domEl.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  }

  function detectCaptcha(form) {
    return form.inputs.some((i) => i.name === 'h-captcha-response' || /captcha/i.test(i.name));
  }

  function runSession(sessionId, payload) {
    report(sessionId, 'SESSION_OPENED');
    const expected = parseIdentity(payload.canonicalActionUrl);
    if (!expected) { report(sessionId, 'COMPANION_ERROR', 'BAD_TARGET'); return; }
    const v = verify(expected);
    if (v !== 'OK') {
      report(sessionId, 'PAGE_IDENTITY_MISMATCH', v);
      return;
    }
    report(sessionId, 'PAGE_VERIFIED');
    const form = facadeForm();
    report(sessionId, 'FORM_DISCOVERED', null, { fields: String(form.inputs.length) });
    let filled = 0;
    for (const field of payload.fields) {
      const r = fillOne(form, field);
      if (r === 'OPTION_CHANGED' || r === 'FIELD_MISSING') {
        report(sessionId, 'FORM_CHANGED', r);
        return;
      }
      if (r === 'OK') filled += 1;
    }
    if (filled > 0) report(sessionId, 'FIELDS_FILLED', null, { count: String(filled) });
    if (detectCaptcha(form)) {
      // Safe approved fields are already filled; then STOP and leave the
      // real page visible. Never touch the challenge.
      report(sessionId, 'HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
    }
    // NO final submit. NO resume attachment.
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'LEVER_RUN') return;
    const { sessionId } = message;
    if (!sessionId) { sendResponse({ ok: false, code: 'NO_SESSION' }); return; }
    chrome.runtime.sendMessage({ type: 'LEVER_BOOTSTRAP', sessionId }, (r) => {
      if (!r || !r.ok) { sendResponse({ ok: false, code: r?.code || 'BOOTSTRAP_FAILED' }); return; }
      runSession(sessionId, r.payload);
      sendResponse({ ok: true });
    });
    return true;
  });
})();