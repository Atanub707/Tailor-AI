// Tailor AI Browser Companion — Lever content script (ISOLATED world, top
// frame only). PHASE 2: strict TWO-PASS (validate everything read-only,
// then mutate), exact resume attachment via DataTransfer, human-checkpoint
// continuation, submission observation. NEVER clicks submit, NEVER touches
// CAPTCHA, NEVER persists bytes/answers.
(() => {
  if (window.top !== window) return;

  let clientSeq = 0;
  const nextClientEventId = () => `seq-${++clientSeq}`;

  function report(sessionId, type, reasonCode, metadata = {}) {
    chrome.runtime.sendMessage({ type: 'TAILOR_ASSIST_EVENT', sessionId, eventType: type, reasonCode, metadata, clientEventId: nextClientEventId() }, () => {});
  }

  // ── DOM facade (mirrors the tested leverPageAdapter contract) ──────────
  function facadeForm() {
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    if (!form) return null;
    const inputs = [];
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || 'text').toLowerCase();
      if (tag === 'input' && ['hidden', 'file', 'submit', 'button', 'password'].includes(type)) continue;
      const options = [];
      if (tag === 'select') for (const o of el.options) options.push(o.value);
      else if (type === 'radio' || type === 'checkbox') {
        for (const same of form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)) options.push(same.value);
      }
      inputs.push({ name: el.name || '', type: tag === 'textarea' ? 'textarea' : type, value: el.value || '', required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true', options, tagName: tag.toUpperCase(), el });
    }
    const resumeInput = form.querySelector('input[type="file"][name="resume"]');
    return { id: form.id, enctype: form.getAttribute('enctype') || '', inputs, resumeInput, captchaHint: !!form.querySelector('.h-captcha, [data-sitekey], input[name="h-captcha-response"]') };
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

  // PASS 1 — READ-ONLY. Verifies identity + every field/option/consent/
  // EEO/resume/captcha BEFORE any mutation. Zero DOM writes.
  function pass1Validate(session, payload) {
    const expected = parseIdentity(payload.canonicalActionUrl);
    if (!expected) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const id = parseIdentity(location.href);
    if (!id || !id.isApplyPage || id.siteSlug !== expected.siteSlug || id.postingId !== expected.postingId) {
      return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    }
    const form = facadeForm();
    if (!form || (form.id && form.id !== 'application-form')) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const failures = [];
    const fillPlan = [];
    for (const field of payload.fields) {
      const el = form.inputs.find((i) => i.name === field.providerFieldId);
      if (!el) { if (field.required) failures.push('missing:' + field.providerFieldId); continue; }
      if (el.type === 'password') { failures.push('unsupported:password:' + field.providerFieldId); continue; }
      const kind = el.tagName === 'TEXTAREA' ? 'TEXTAREA' : el.type;
      if ((kind === 'select' || kind === 'radio') && el.options.length && !el.options.includes(String(field.approvedValue))) {
        failures.push('option:' + field.providerFieldId);
        continue;
      }
      fillPlan.push({ name: field.providerFieldId, value: field.approvedValue, kind });
    }
    const resumeControl = form.resumeInput;
    if (!resumeControl) failures.push('resume-control-missing');
    return { ok: failures.length === 0, failures, fillPlan, form, resumeControl, captchaPresent: form.captchaHint, id };
  }

  // PASS 2 — MUTATION. Only after pass1.ok.
  function pass2Fill(form, fillPlan) {
    let filled = 0;
    for (const item of fillPlan) {
      const el = form.inputs.find((i) => i.name === item.name);
      if (!el) continue;
      const dom = el.el;
      if (el.type === 'select') {
        dom.value = String(item.value);
        dom.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'radio') {
        const target = form.inputs.filter((i) => i.name === item.name && i.type === 'radio').find((i) => i.value === String(item.value));
        if (target) { target.el.checked = true; target.el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el.type === 'checkbox') {
        const target = form.inputs.find((i) => i.name === item.name && i.type === 'checkbox' && i.value === '1') || form.inputs.find((i) => i.name === item.name && i.type === 'checkbox');
        if (target) { target.el.checked = item.value === true; target.el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        dom.value = String(item.value);
        dom.dispatchEvent(new Event('input', { bubbles: true }));
        dom.dispatchEvent(new Event('change', { bubbles: true }));
      }
      filled += 1;
    }
    return filled;
  }

  // EXACT resume attachment (bytes from the service worker; DataTransfer
  // pattern). Never stored; references released after attach.
  function attachResume(resumeInput, bytes, filename, mimeType) {
    try {
      const file = new File([bytes], filename, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      resumeInput.files = dt.files;
      resumeInput.dispatchEvent(new Event('change', { bubbles: true }));
      if (resumeInput.files.length !== 1 || resumeInput.files[0].name !== filename || resumeInput.files[0].size !== bytes.byteLength) {
        return { ok: false, reason: 'VERIFY_FAILED' };
      }
      return { ok: true };
    } catch { return { ok: false, reason: 'ATTACH_FAILED' }; }
  }

  function submissionObserver(sessionId) {
    let observed = false;
    // Passive user-initiation listener (observation only — never intercepts).
    document.addEventListener('click', (e) => {
      if (observed) return;
      const t = e.target;
      if (t && t.closest && t.closest('#btn-submit, button[type="submit"], input[type="submit"]')) {
        observed = true;
        report(sessionId, 'SUBMISSION_INITIATED');
        setTimeout(() => observeOutcome(sessionId), 4000);
      }
    }, true);

    const observeOutcome = (sid) => {
      const check = () => {
        const text = document.body ? (document.body.innerText || '') : '';
        const url = location.href;
        if (/application.?submitted|thank you.*application|application received|successfully applied/i.test(url + ' ' + text)) {
          const m = (url + ' ' + text).match(/application.?submitted|thank you.*application|application received|successfully applied/i);
          report(sid, 'SUBMISSION_CONFIRMED', undefined, { confirmationEvidenceType: 'SUCCESS_TEXT', confirmationFingerprint: (m ? m[0] : 'confirmed').slice(0, 64).replace(/[^0-9a-f]/gi, '') || 'confirmed' });
          return true;
        }
        if (/error|invalid|failed/i.test(text) && !/application.?submitted/i.test(text)) {
          report(sid, 'SUBMISSION_FAILED', undefined, { failureCategory: 'UNKNOWN_ERROR' });
          return true;
        }
        return false;
      };
      if (check()) return;
      const iv = setInterval(() => { if (check()) clearInterval(iv); }, 3000);
      setTimeout(() => clearInterval(iv), 120000); // give up → UNCONFIRMED via expiry fallback
    };
  }

  // Human-checkpoint continuation: watch for the blocking checkpoint to
  // clear, then RE-VALIDATE everything (read-only) before readiness.
  function checkpointWatcher(sessionId, payload, baseCtx) {
    if (!baseCtx.captchaPresent) return;
    let watching = true;
    const check = () => {
      if (!watching) return;
      const form = facadeForm();
      if (!form) return;
      if (form.captchaHint) return; // still blocked
      watching = false;
      // Checkpoint cleared → full read-only revalidation.
      report(sessionId, 'CHECKPOINT_CLEARED', 'CAPTCHA_REQUIRED');
      const v = pass1Validate(sessionId, payload);
      if (!v.ok) {
        report(sessionId, v.reason === 'PAGE_IDENTITY_MISMATCH' ? 'PAGE_IDENTITY_MISMATCH' : 'FORM_CHANGED', v.reason);
        return;
      }
      if (v.failures.length) { report(sessionId, 'FORM_CHANGED', v.failures[0]); return; }
      report(sessionId, 'READY_FOR_USER_SUBMISSION');
      submissionObserver(sessionId);
    };
    const iv = setInterval(check, 3000);
    setTimeout(() => { watching = false; clearInterval(iv); }, 15 * 60 * 1000);
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Resume bytes arrive from the SW (never paths/secrets).
    if (!message || message.type !== 'LEVER_RESUME') return;
    const { sessionId, bytes, filename, mimeType } = message;
    if (!sessionId || !bytes || !(bytes instanceof ArrayBuffer)) { sendResponse({ ok: false, code: 'BAD_RESUME_MSG' }); return; }
    const form = facadeForm();
    if (!form || !form.resumeInput) { sendResponse({ ok: false, code: 'NO_RESUME_CONTROL' }); return; }
    const r = attachResume(form.resumeInput, bytes, filename, mimeType);
    if (r.ok) {
      report(sessionId, 'RESUME_ATTACHED', undefined, { artifactHashPrefix: filename.replace('resume-', '').replace('.pdf', ''), size: String(bytes.byteLength), mimeType });
    } else {
      report(sessionId, 'RESUME_ATTACHMENT_FAILED', 'RESUME_ATTACHMENT_REQUIRED');
    }
    // release references — never persist bytes
    bytes = null;
    sendResponse({ ok: r.ok, code: r.reason });
    return true;
  });

  function runSession(sessionId, payload) {
    report(sessionId, 'SESSION_OPENED');
    const v = pass1Validate(sessionId, payload);
    if (!v.ok) {
      report(sessionId, v.reason === 'PAGE_IDENTITY_MISMATCH' ? 'PAGE_IDENTITY_MISMATCH' : 'FORM_CHANGED', v.reason);
      return;
    }
    if (v.failures.length) {
      report(sessionId, 'FORM_CHANGED', v.failures[0]);
      return;
    }
    report(sessionId, 'PAGE_VERIFIED');
    report(sessionId, 'FORM_DISCOVERED', null, { fields: String(v.form.inputs.length) });
    const filled = pass2Fill(v.form, v.fillPlan);
    if (filled > 0) report(sessionId, 'FIELDS_FILLED', null, { count: String(filled) });
    // Resume attach via SW (exact bytes from the backend).
    chrome.runtime.sendMessage({ type: 'LEVER_FETCH_RESUME', sessionId }, (r) => {
      if (!r || !r.ok) report(sessionId, 'RESUME_ATTACHMENT_FAILED', 'RESUME_ATTACHMENT_REQUIRED');
    });
    if (v.captchaPresent) {
      // Safe fields + resume already prepared; then STOP for the user.
      report(sessionId, 'HUMAN_ACTION_REQUIRED', 'CAPTCHA_REQUIRED');
      checkpointWatcher(sessionId, payload, v);
    } else {
      report(sessionId, 'READY_FOR_USER_SUBMISSION');
      submissionObserver(sessionId);
    }
    // NO final submit. NO CAPTCHA interaction.
  }
})();