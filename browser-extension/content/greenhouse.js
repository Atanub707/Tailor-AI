// Tailor AI Browser Companion — Greenhouse content script (ISOLATED world,
// top frame). Two-pass: full read-only validation → mutation. Never submits,
// never touches CAPTCHA, never stores bytes.
(() => {
  if (window.top !== window) return;
  let clientSeq = 0;
  const nextClientEventId = () => `seq-${++clientSeq}`;
  const report = (sid, type, reasonCode, metadata = {}) => chrome.runtime.sendMessage({ type: 'TAILOR_ASSIST_EVENT', sessionId: sid, eventType: type, reasonCode, metadata, clientEventId: nextClientEventId() }, () => {});

  // ── DOM facade (Greenhouse: fields identified by ID; no name attrs) ──
  function facadeForm() {
    const form = document.getElementById('application-form');
    if (!form) return null;
    const inputs = [];
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || 'text').toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const id = el.id || el.name || '';
      if (!id) continue;
      if (type === 'file' && id === 'resume') { continue; } // resume tracked separately
      const options = [];
      if (tag === 'select') for (const o of el.options) options.push(o.value);
      else if (type === 'radio' || type === 'checkbox') {
        for (const same of form.querySelectorAll(`input[id^="${CSS.escape(id)}"]`)) options.push(same.value);
        if (!options.length) {
          for (const same of form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)) options.push(same.value);
        }
      }
      inputs.push({ name: id, type: tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : type, value: el.value || '', required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true', options, tagName: tag.toUpperCase(), el });
    }
    const resumeInput = form.querySelector('input[type="file"][id="resume"], input[type="file"]');
    return { id: 'application-form', enctype: '', inputs, resumeInput, captchaHint: !!form.querySelector('.g-recaptcha, [class*="recaptcha"], textarea[name="g-recaptcha-response"]') };
  }

  function parseIdentity(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || (u.hostname !== 'boards.greenhouse.io' && u.hostname !== 'job-boards.greenhouse.io')) return null;
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length < 3 || seg[1] !== 'jobs') return null;
      return { hostname: u.hostname, companySlug: seg[0], postingId: seg[2], isApplicationPage: true };
    } catch { return null; }
  }

  // PASS 1 — READ-ONLY
  function pass1Validate(payload) {
    const expected = parseIdentity(payload.canonicalActionUrl);
    if (!expected) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const id = parseIdentity(location.href);
    if (!id || id.companySlug !== expected.companySlug || id.postingId !== expected.postingId) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const form = facadeForm();
    if (!form || form.id !== 'application-form') return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const failures = [];
    const fillPlan = [];
    for (const field of payload.fields) {
      const el = form.inputs.find((i) => i.name === field.providerFieldId);
      if (!el) { if (field.required) failures.push('missing:' + field.providerFieldId); continue; }
      if ((el.type === 'select' || el.type === 'radio') && el.options.length && !el.options.includes(String(field.approvedValue))) {
        failures.push('option:' + field.providerFieldId); continue;
      }
      fillPlan.push({ name: field.providerFieldId, value: field.approvedValue, kind: el.type });
    }
    for (const f of form.inputs) {
      if (f.required && !payload.fields.some((p) => p.providerFieldId === f.name)) failures.push('unsupported:' + f.name);
    }
    if (!form.resumeInput) failures.push('resume-control-missing');
    return { ok: failures.length === 0, failures, fillPlan, form };
  }

  // PASS 2 — MUTATION
  function pass2Fill(form, fillPlan) {
    let filled = 0;
    for (const item of fillPlan) {
      const el = form.inputs.find((i) => i.name === item.name);
      if (!el) continue;
      const dom = el.el;
      if (el.type === 'select') { dom.value = String(item.value); dom.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (el.type === 'radio') {
        const candidates = form.inputs.filter((i) => i.name === item.name && i.type === 'radio');
        const target = candidates.find((i) => i.value === String(item.value)) || candidates[0];
        if (target) { target.el.checked = true; target.el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el.type === 'checkbox') { dom.checked = item.value === true; dom.dispatchEvent(new Event('change', { bubbles: true })); }
      else { dom.value = String(item.value); dom.dispatchEvent(new Event('input', { bubbles: true })); dom.dispatchEvent(new Event('change', { bubbles: true })); }
      filled += 1;
    }
    return filled;
  }

  function attachResume(resumeInput, bytes, filename, mimeType) {
    try {
      const file = new File([bytes], filename, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      resumeInput.files = dt.files;
      resumeInput.dispatchEvent(new Event('change', { bubbles: true }));
      return resumeInput.files.length === 1 ? { ok: true } : { ok: false, reason: 'VERIFY_FAILED' };
    } catch { return { ok: false, reason: 'ATTACH_FAILED' }; }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LEVER_RUN') return; // same bootstrap channel (provider-agnostic)
    const { sessionId } = message;
    if (!sessionId) { sendResponse({ ok: false, code: 'NO_SESSION' }); return; }
    chrome.runtime.sendMessage({ type: 'LEVER_BOOTSTRAP', sessionId }, (r) => {
      if (!r || !r.ok) { sendResponse({ ok: false, code: r?.code || 'BOOTSTRAP_FAILED' }); return; }
      const payload = r.payload;
      report(sessionId, 'SESSION_OPENED');
      const v = pass1Validate(payload);
      if (!v.ok) { report(sessionId, v.reason === 'PAGE_IDENTITY_MISMATCH' ? 'PAGE_IDENTITY_MISMATCH' : 'FORM_CHANGED', v.reason); sendResponse({ ok: false, code: v.reason }); return; }
      if (v.failures.length) { report(sessionId, 'FORM_CHANGED', v.failures[0]); sendResponse({ ok: false, code: 'FORM_CHANGED' }); return; }
      report(sessionId, 'PAGE_VERIFIED');
      report(sessionId, 'FORM_DISCOVERED', null, { fields: String(v.form.inputs.length) });
      const filled = pass2Fill(v.form, v.fillPlan);
      if (filled > 0) report(sessionId, 'FIELDS_FILLED', null, { count: String(filled) });
      if (v.form.captchaHint) {
        report(sessionId, 'HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
      } else {
        report(sessionId, 'READY_FOR_USER_SUBMISSION');
      }
      sendResponse({ ok: true });
    });
    return true;
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LEVER_RESUME') return;
    const { sessionId, bytes, filename, mimeType } = message;
    if (!sessionId || !bytes || !(bytes instanceof ArrayBuffer)) { sendResponse({ ok: false, code: 'BAD_RESUME_MSG' }); return; }
    const form = facadeForm();
    if (!form || !form.resumeInput) { sendResponse({ ok: false, code: 'NO_RESUME_CONTROL' }); return; }
    const r = attachResume(form.resumeInput, bytes, filename, mimeType);
    if (r.ok) report(sessionId, 'RESUME_ATTACHED', undefined, { artifactHashPrefix: filename.replace('resume-', '').replace('.pdf', ''), size: String(bytes.byteLength), mimeType });
    else report(sessionId, 'RESUME_ATTACHMENT_FAILED', 'RESUME_ATTACHMENT_REQUIRED');
    sendResponse({ ok: r.ok, code: r.reason });
    return true;
  });
})();