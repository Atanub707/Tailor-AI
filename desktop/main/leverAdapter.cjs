'use strict';
// Tailor Browser — Lever provider adapter (MAIN PROCESS ONLY).
//
// Deterministic DOM automation only. These scripts are provider-controlled:
// they are built in the main process, never supplied by renderer or page
// content. Invariants (asserted by tests/desktop/tailorBrowser.test.ts):
//   - never calls the form's native submit or dispatches submit events
//   - never interacts with CAPTCHA (detection only)
//   - never reads or touches field VALUES other than the frozen plan values
//   - submit (Phase 24) exists but is flag-gated in main, default OFF

const LEVER_HOST = 'jobs.lever.co';

/** Parse + canonicalize a Lever posting URL. */
function parseLeverUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:' || u.hostname !== LEVER_HOST) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    const isApply = seg[seg.length - 1] === 'apply';
    const siteSlug = seg[0];
    const postingId = isApply ? seg[seg.length - 2] : seg[seg.length - 1];
    return { hostname: u.hostname, siteSlug, postingId, isApplyPage: isApply, canonical: `https://${LEVER_HOST}/${siteSlug}/${postingId}` };
  } catch {
    return null;
  }
}

/** Validate a plan handed over IPC (renderer treated as untrusted). */
function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['NO_PLAN'], url: null };
  if (plan.provider !== 'lever') errors.push('PROVIDER_UNSUPPORTED');
  const url = parseLeverUrl(plan.url);
  if (!url || !url.isApplyPage) errors.push('INVALID_APPLY_URL');
  if (typeof plan.postingId === 'string' && url && plan.postingId !== url.postingId) errors.push('POSTING_MISMATCH');
  if (!Array.isArray(plan.fields) || plan.fields.length > 120) {
    errors.push('BAD_FIELDS');
  } else {
    for (const f of plan.fields) {
      if (!f || typeof f.providerFieldId !== 'string' || !f.providerFieldId || f.providerFieldId.length > 120) {
        errors.push('BAD_FIELD_ID');
        break;
      }
      const v = f.approvedValue;
      const okVal = typeof v === 'string' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
      if (!okVal || (typeof v === 'string' && v.length > 5000)) {
        errors.push('BAD_FIELD_VALUE');
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors, url };
}

const NORMALIZE_SRC = `
  function taNormalize(value, fieldType) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(function (v) { return String(v).trim().toLowerCase(); }).sort().join(',');
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    var raw = String(value);
    var type = String(fieldType || '').toUpperCase();
    if (type === 'PHONE') { var digits = raw.replace(/\\D/g, ''); return digits || raw.trim().toLowerCase(); }
    if (type === 'NUMBER') { var n = Number(raw.replace(/,/g, '').trim()); return isFinite(n) ? String(n) : raw.trim().toLowerCase(); }
    if (type === 'BOOLEAN' || type === 'SINGLE_SELECT' || type === 'MULTI_SELECT') {
      var t = raw.trim().toLowerCase();
      if (t === 'true' || t === '1') return 'yes';
      if (t === 'false' || t === '0') return 'no';
      return t;
    }
    return raw.trim().replace(/\\s+/g, ' ').toLowerCase();
  }
`;

/** Read-only identity/checkpoint probe. */
function buildIdentityScript() {
  return `(() => {
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    return {
      href: location.href,
      title: document.title,
      hasForm: !!form,
      captchaPresent: !!(form && form.querySelector('.h-captcha, [data-sitekey], input[name="h-captcha-response"]')),
      resumeControl: !!(form && form.querySelector('input[type="file"][name="resume"]')),
      fieldCount: form ? form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').length : 0,
    };
  })()`;
}

/** CAPTCHA/manual checkpoint probe (detection only — never interaction). */
function buildCheckpointScript() {
  // Robust clear-detection: hCaptcha/Lever can place the token in a textarea
  // OR a hidden input; a cleared challenge is the PRIMARY resume signal.
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { formGone: true, captchaPresent: false, captchaFieldFilled: false, cleared: true };
    const ta = form.querySelector('textarea[name="h-captcha-response"]');
    const inp = form.querySelector('input[name="h-captcha-response"]');
    const fromIframe = !!form.querySelector('iframe[title*="hCaptcha" i], iframe[src*="hcaptcha.com"]');
    const token = String((ta && ta.value) || (inp && inp.value) || '').trim();
    const captchaPresent = !!(form.querySelector('.h-captcha, [data-sitekey]') || ta || inp || fromIframe);
    return { formGone: false, captchaPresent, captchaFieldFilled: token.length > 0, cleared: token.length > 0 };
  })()`;
}

/** PASS 1 + PASS 2: validate everything read-only, then fill the frozen plan. */
function buildFillScript(plan) {
  return `(() => {
    ${NORMALIZE_SRC}
    const plan = ${JSON.stringify(plan)};
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    if (!form) return { ok: false, reason: 'NO_APPLICATION_FORM', filled: 0, failures: [], captchaPresent: false };
    const captchaPresent = !!form.querySelector('.h-captcha, [data-sitekey], input[name="h-captcha-response"]');
    const find = (name) => {
      const all = form.querySelectorAll('input, select, textarea');
      for (const el of all) {
        if (el.name === name && el.type !== 'password') return el;
      }
      return null;
    };
    const failures = [];
    for (const f of plan.fields) {
      const el = find(f.providerFieldId);
      if (!el) { failures.push('missing:' + f.providerFieldId); continue; }
      const kind = el.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el.type || 'text');
      if ((kind === 'select' || kind === 'radio') && el.options && el.options.length) {
        const opts = Array.from(el.options).map((o) => o.value).concat(Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).map((i) => i.value));
        if (!opts.includes(String(f.approvedValue))) failures.push('option:' + f.providerFieldId);
      }
    }
    if (failures.length) return { ok: false, reason: 'VALIDATION_FAILED', filled: 0, failures, captchaPresent };
    const wasCorrect = {};
    let filled = 0;
    for (const f of plan.fields) {
      const el = find(f.providerFieldId);
      if (!el) continue;
      const kind = el.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el.type || 'text');
      if (el.type === 'checkbox') wasCorrect[f.providerFieldId] = el.checked === (f.approvedValue === true);
      else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        wasCorrect[f.providerFieldId] = !!(t && t.checked);
      } else if (el.tagName === 'SELECT') wasCorrect[f.providerFieldId] = taNormalize(el.value, 'SINGLE_SELECT') === taNormalize(f.approvedValue, 'SINGLE_SELECT');
      else wasCorrect[f.providerFieldId] = taNormalize(el.value, kind) === taNormalize(f.approvedValue, kind);

      if (el.type === 'checkbox') {
        const target = el.value === '1' || el.value === '' ? el : Array.from(form.querySelectorAll('input[type="checkbox"][name="' + CSS.escape(el.name) + '"]'))[0];
        if (target) { target.checked = f.approvedValue === true; target.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        if (t) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el.tagName === 'SELECT') {
        el.value = String(f.approvedValue);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = String(f.approvedValue);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      filled += 1;
    }
    return { ok: true, reason: null, filled, failures: [], captchaPresent, wasCorrect };
  })()`;
}

/** Read-back verification against the frozen plan (READ-ONLY). */
function buildReadBackScript(plan, wasCorrect) {
  return `(() => {
    ${NORMALIZE_SRC}
    const plan = ${JSON.stringify(plan)};
    const wasCorrect = ${JSON.stringify(wasCorrect || {})};
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    if (!form) return { statuses: '', newRequiredCount: 0 };
    const find = (name) => {
      const all = form.querySelectorAll('input, select, textarea');
      for (const el of all) if (el.name === name && el.type !== 'password') return el;
      return null;
    };
    const approvedNames = {};
    for (const f of plan.fields) approvedNames[f.providerFieldId] = true;
    const statuses = [];
    for (const f of plan.fields) {
      const el = find(f.providerFieldId);
      if (!el) { statuses.push('N'); continue; }
      const kind = el.type === 'checkbox' ? 'BOOLEAN' : (el.type === 'radio' || el.tagName === 'SELECT' ? 'SINGLE_SELECT' : (el.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el.type || 'text')));
      let observed;
      if (el.type === 'checkbox') observed = el.checked ? 'true' : 'false';
      else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        observed = t && t.checked ? String(f.approvedValue) : el.value;
      } else observed = el.value;
      statuses.push(taNormalize(observed, kind) === taNormalize(f.approvedValue, kind) ? (wasCorrect[f.providerFieldId] ? 'A' : 'V') : 'M');
    }
    let newRequiredCount = 0;
    for (const el of form.querySelectorAll('input, select, textarea')) {
      if (el.required && !approvedNames[el.name] && el.name !== 'resume' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden') newRequiredCount += 1;
    }
    return { statuses: statuses.join(''), newRequiredCount };
  })()`;
}

/**
 * Phase 24 — explicit submission. Strict provider-specific control identity.
 * Main-process gated: never invoked unless TAILOR_BROWSER_SUBMIT_ENABLED=1
 * and the server-side attempt says READY_FOR_USER_SUBMISSION.
 */
function buildSubmitScript() {
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { ok: false, code: 'NO_APPLICATION_FORM' };
    const btn = form.querySelector('#btn-submit');
    if (!btn || btn.tagName !== 'BUTTON') return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if ((btn.getAttribute('type') || 'submit').toLowerCase() !== 'submit') return { ok: false, code: 'UNEXPECTED_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    btn.click();
    return { ok: true, control: 'lever:application-submit' };
  })()`;
}

/** Confirmation detection (READ-ONLY, Phase 27). */
function buildConfirmationScript() {
  return `(() => {
    const text = document.body ? (document.body.innerText || '') : '';
    const url = location.href;
    const m = (url + ' ' + text).match(/application.?submitted|thank you.*application|application received|successfully applied/i);
    return { confirmed: !!m, evidence: m ? String(m[0]).slice(0, 48) : null, formGone: !document.getElementById('application-form') };
  })()`;
}

/**
 * Validation WITHOUT clicking — used for the pre-submit control check.
 * The actual click happens only in buildSubmitScript, after server authorization.
 */
function buildSubmitControlCheckScript() {
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { ok: false, code: 'NO_APPLICATION_FORM' };
    const btn = form.querySelector('#btn-submit');
    if (!btn || btn.tagName !== 'BUTTON') return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if ((btn.getAttribute('type') || 'submit').toLowerCase() !== 'submit') return { ok: false, code: 'UNEXPECTED_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    return { ok: true, control: 'lever:application-submit' };
  })()`;
}

module.exports = {
  LEVER_HOST,
  parseLeverUrl,
  validatePlan,
  buildIdentityScript,
  buildCheckpointScript,
  buildFillScript,
  buildReadBackScript,
  buildSubmitScript,
  buildSubmitControlCheckScript,
  buildConfirmationScript,
};
