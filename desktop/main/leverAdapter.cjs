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

/** Parse + canonicalize a Lever posting URL. Post-submit routes (/thanks,
 *  /already-received) keep the SAME posting canonical — they must never look
 *  like a different posting to the navigation guard. */
function parseLeverUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:' || u.hostname !== LEVER_HOST) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    const TERMINAL = new Set(['apply', 'thanks', 'already-received']);
    let postingId;
    let isApplyPage = false;
    if (TERMINAL.has(seg[seg.length - 1]) && seg.length >= 3) {
      postingId = seg[seg.length - 2];
      isApplyPage = seg[seg.length - 1] === 'apply';
    } else {
      postingId = seg[seg.length - 1];
    }
    return { hostname: u.hostname, siteSlug: seg[0], postingId, isApplyPage, canonical: `https://${LEVER_HOST}/${seg[0]}/${postingId}` };
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

/** Checkbox-group helpers: MULTI_SELECT options live on per-option checkbox
 *  inputs sharing one name; the visible option text is the input value or the
 *  associated label. */
const CHECKBOX_SRC = `
  function taCheckboxOption(input, form) {
    var v = String(input.value || '').trim();
    if (v && v !== '1' && v !== 'on' && v !== 'true') return v;
    var label = input.closest('label');
    if (!label && input.id) { try { label = form.querySelector('label[for="' + CSS.escape(input.id) + '"]'); } catch (e) { label = null; } }
    return label ? String(label.textContent || '').trim() : '';
  }
  function taCheckboxGroup(input, form) {
    try { return Array.prototype.slice.call(form.querySelectorAll('input[type="checkbox"][name="' + CSS.escape(input.name) + '"]')); }
    catch (e) { return [input]; }
  }
  function taWantedList(value) {
    if (Array.isArray(value)) return value.map(function (v) { return String(v).trim(); }).filter(Boolean);
    return String(value === null || value === undefined ? '' : value).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function taIsBooleanCheckbox(group, value) {
    return group.length <= 1 && typeof value === 'boolean';
  }
  function taCheckboxState(group, form) {
    return group.filter(function (i) { return i.checked; }).map(function (i) { return taCheckboxOption(i, form).toLowerCase(); }).sort().join(',');
  }
  function taCheckboxWanted(value) {
    return taWantedList(value).map(function (s) { return s.toLowerCase(); }).sort().join(',');
  }
`;

/** Tolerant single-select matching: exact, parenthetical-stripped ("Asian" →
 *  "Asian (Not Hispanic or Latino)"), and veteran-label synonyms. */
const SELECT_SRC = `
  function taOptionKeys(value) {
    var norm = String(value === null || value === undefined ? '' : value).trim().replace(/\\s+/g, ' ').toLowerCase();
    var stripped = norm.replace(/\\([^)]*\\)/g, ' ').replace(/\\s+/g, ' ').trim();
    var vet = stripped.replace(/protected\\s+veteran/g, 'veteran').replace(/\\s+/g, ' ').trim();
    var keys = [];
    [norm, stripped, vet].forEach(function (k) { if (k && keys.indexOf(k) === -1) keys.push(k); });
    return keys;
  }
  function taOptionEqual(a, b) {
    var ka = taOptionKeys(a), kb = taOptionKeys(b);
    for (var i = 0; i < ka.length; i++) if (kb.indexOf(ka[i]) !== -1) return true;
    return false;
  }
  function taMatchOption(value, options) {
    var want = taOptionKeys(value);
    for (var i = 0; i < options.length; i++) {
      var keys = taOptionKeys(options[i].value).concat(taOptionKeys(options[i].text));
      for (var j = 0; j < want.length; j++) if (keys.indexOf(want[j]) !== -1) return options[i].value;
    }
    return null;
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

/** CAPTCHA/manual checkpoint probe (detection only — never interaction).
 *  Lever ships an hCaptcha widget on every form; a mere widget node is NOT a
 *  checkpoint. We pause ONLY when a human actually has something to do: the
 *  widget/challenge is VISIBLE or the challenge iframe is displayed. A filled
 *  token (passive verification already solved) always clears. */
function buildCheckpointScript() {
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { formGone: true, captchaPresent: false, captchaFieldFilled: false, cleared: true };
    const ta = form.querySelector('textarea[name="h-captcha-response"]');
    const inp = form.querySelector('input[name="h-captcha-response"]');
    const gta = document.querySelector('textarea[name="g-recaptcha-response"]');
    const ginp = document.querySelector('input[name="g-recaptcha-response"]');
    const token = String((ta && ta.value) || (inp && inp.value) || (gta && gta.value) || (ginp && ginp.value) || '').trim();
    const captchaFieldFilled = token.length > 0;
    // A human checkpoint exists ONLY when a challenge is genuinely on-screen.
    // hCaptcha/reCAPTCHA challenge overlays are BODY-LEVEL — scan the document.
    const visible = (el) => {
      if (!el) return false;
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 4 || r.height <= 4) return false;
        if (r.right <= 0 || r.bottom <= 0) return false;
        return true;
      } catch (e) { return false; }
    };
    const challengeVisible = Array.from(document.querySelectorAll('iframe[title*="hCaptcha" i], iframe[src*="hcaptcha.com"], iframe[title*="reCAPTCHA" i], iframe[src*="/recaptcha/"], .h-captcha-challenge, [data-hcaptcha-widget-id]')).some(visible);
    const captchaPresent = !captchaFieldFilled && challengeVisible;
    return { formGone: false, captchaPresent, captchaFieldFilled, cleared: captchaFieldFilled || !captchaPresent };
  })()`;
}

/** PASS 1 + PASS 2: validate everything read-only, then fill the frozen plan. */
function buildFillScript(plan) {
  return `(() => {
    ${NORMALIZE_SRC}
    ${CHECKBOX_SRC}
    ${SELECT_SRC}
    const plan = ${JSON.stringify(plan)};
    const form = document.getElementById('application-form') || document.querySelector('form[enctype="multipart/form-data"]');
    if (!form) return { ok: false, reason: 'NO_APPLICATION_FORM', filled: 0, failures: [], captchaPresent: false };
    // Pause only on a genuinely visible challenge (or a filled token = already
    // solved). A passive hCaptcha parks its iframe off-screen/hidden, and the
    // widget container node exists on every Lever form — neither is a checkpoint.
    const hcToken = String(((form.querySelector('textarea[name="h-captcha-response"]') || {}).value) || ((form.querySelector('input[name="h-captcha-response"]') || {}).value) || ((document.querySelector('textarea[name="g-recaptcha-response"]') || {}).value) || ((document.querySelector('input[name="g-recaptcha-response"]') || {}).value) || '').trim();
    const hcVisible = (el) => {
      if (!el) return false;
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 4 || r.height <= 4) return false;
        if (r.right <= 0 || r.bottom <= 0) return false;
        return true;
      } catch (e) { return false; }
    };
    const hcChallenge = Array.from(document.querySelectorAll('iframe[title*="hCaptcha" i], iframe[src*="hcaptcha.com"], iframe[title*="reCAPTCHA" i], iframe[src*="/recaptcha/"], .h-captcha-challenge')).some(hcVisible);
    const captchaPresent = hcToken.length === 0 && hcChallenge;
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
      if ((el.tagName === 'SELECT' || el.type === 'radio') && el.options && el.options.length) {
        if (el.tagName === 'SELECT') {
          const options = Array.from(el.options).map((o) => ({ value: o.value, text: String(o.text) }));
          if (taMatchOption(String(f.approvedValue), options) === null) failures.push('option:' + f.providerFieldId);
        } else {
          const opts = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).map((i) => i.value);
          if (!opts.includes(String(f.approvedValue))) failures.push('option:' + f.providerFieldId);
        }
      }
      if (el.type === 'checkbox') {
        const group = taCheckboxGroup(el, form);
        if (!taIsBooleanCheckbox(group, f.approvedValue)) {
          const optionNames = group.map((i) => taCheckboxOption(i, form).toLowerCase());
          for (const wanted of taWantedList(f.approvedValue)) {
            if (!optionNames.includes(wanted.toLowerCase())) failures.push('option:' + f.providerFieldId);
          }
        }
      }
    }
    if (failures.length) return { ok: false, reason: 'VALIDATION_FAILED', filled: 0, failures, captchaPresent };
    const wasCorrect = {};
    let filled = 0;
    for (const f of plan.fields) {
      const el = find(f.providerFieldId);
      if (!el) continue;
      const kind = el.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el.type || 'text');
      if (el.type === 'checkbox') {
        const group = taCheckboxGroup(el, form);
        wasCorrect[f.providerFieldId] = taIsBooleanCheckbox(group, f.approvedValue)
          ? el.checked === (f.approvedValue === true)
          : taCheckboxState(group, form) === taCheckboxWanted(f.approvedValue);
      }
      else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        wasCorrect[f.providerFieldId] = !!(t && t.checked);
      } else if (el.tagName === 'SELECT') {
        const so = el.options[el.selectedIndex];
        wasCorrect[f.providerFieldId] = !!so && !!String(so.value) && taOptionEqual(String(so.text), String(f.approvedValue));
      } else wasCorrect[f.providerFieldId] = taNormalize(el.value, kind) === taNormalize(f.approvedValue, kind);

      if (el.type === 'checkbox') {
        const group = taCheckboxGroup(el, form);
        if (taIsBooleanCheckbox(group, f.approvedValue)) {
          const target = group[0] || el;
          if (target.checked !== (f.approvedValue === true)) {
            target.checked = f.approvedValue === true;
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          const wanted = taWantedList(f.approvedValue).map((s) => s.toLowerCase());
          for (const opt of group) {
            const shouldCheck = wanted.includes(taCheckboxOption(opt, form).toLowerCase());
            if (opt.checked !== shouldCheck) {
              opt.checked = shouldCheck;
              opt.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }
      } else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        if (t) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el.tagName === 'SELECT') {
        const target = taMatchOption(String(f.approvedValue), Array.from(el.options).map((o) => ({ value: o.value, text: String(o.text) })));
        if (target !== null) {
          el.value = target;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
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
    ${CHECKBOX_SRC}
    ${SELECT_SRC}
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
      let checkboxMulti = false;
      let checkboxOk = false;
      let selectState = null;
      if (el.type === 'checkbox') {
        const group = taCheckboxGroup(el, form);
        if (taIsBooleanCheckbox(group, f.approvedValue)) {
          observed = el.checked ? 'true' : 'false';
        } else {
          checkboxMulti = true;
          observed = taCheckboxState(group, form);
          checkboxOk = observed === taCheckboxWanted(f.approvedValue);
        }
      } else if (el.type === 'radio') {
        const t = Array.from(form.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')).find((i) => i.value === String(f.approvedValue));
        observed = t && t.checked ? String(f.approvedValue) : el.value;
      } else if (el.tagName === 'SELECT') {
        const so = el.options[el.selectedIndex];
        observed = so ? String(so.text) : el.value;
        selectState = { ok: !!so && !!String(so.value) && taOptionEqual(String(so.text), String(f.approvedValue)) };
      } else observed = el.value;
      if (checkboxMulti) {
        statuses.push(checkboxOk ? (wasCorrect[f.providerFieldId] ? 'A' : 'V') : 'M');
      } else if (selectState) {
        statuses.push(selectState.ok ? (wasCorrect[f.providerFieldId] ? 'A' : 'V') : 'M');
      } else {
        statuses.push(taNormalize(observed, kind) === taNormalize(f.approvedValue, kind) ? (wasCorrect[f.providerFieldId] ? 'A' : 'V') : 'M');
      }
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
 * Main-process gated: never invoked unless the server-side attempt says
 * READY_FOR_USER_SUBMISSION and the token is authorized.
 *
 * `trustedInput: true` validates + measures the control and returns its rect
 * WITHOUT clicking — the caller then sends real input events (trusted gesture,
 * required by gesture-gated submit handlers like invisible hCaptcha). The
 * default path keeps the programmatic click as a fallback.
 */
function buildSubmitScript(opts) {
  const trustedInput = !!(opts && opts.trustedInput);
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { ok: false, code: 'NO_APPLICATION_FORM' };
    const btn = form.querySelector('#btn-submit');
    if (!btn || btn.tagName !== 'BUTTON') return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    const type = (btn.getAttribute('type') || 'submit').toLowerCase();
    if (type !== 'submit' && type !== 'button') return { ok: false, code: 'UNEXPECTED_CONTROL' };
    const marked = btn.getAttribute('data-qa') === 'btn-submit' || /\\btemplate-btn-submit\\b/.test(String(btn.className || ''));
    if (!marked) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* keep measuring */ }
    const rect = (() => { try { const r = btn.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; } })();
    // Belt and braces: Lever's location typeahead may have cleared the hidden
    // selectedLocation (blur) after we filled it. Re-assert the exact JSON shape
    // Lever itself writes (JSON.stringify(locationObject)) right before click.
    const locInput = form.querySelector('#location-input');
    const selLoc = form.querySelector('#selected-location');
    if (locInput && selLoc && String(locInput.value || '').trim()) {
      let okJson = false;
      try { const p = JSON.parse(String(selLoc.value || '')); okJson = !!p && typeof p === 'object' && !!p.name; } catch (e) { okJson = false; }
      if (!okJson) selLoc.value = JSON.stringify({ name: String(locInput.value).trim() });
    }
    const useTrusted = ${trustedInput ? 'true' : 'false'};
    if (!useTrusted) btn.click();
    return { ok: true, control: 'lever:application-submit', rect, clicked: !useTrusted };
  })()`;
}

/** Confirmation detection (READ-ONLY, Phase 27). */
function buildConfirmationScript() {
  return `(() => {
    const url = location.href;
    const text = document.body ? (document.body.innerText || '') : '';
    // Lever's REAL success surface: /thanks (or LeverAppId redirect),
    // .confirmation-message / [data-qa="msg-submit-success"] / "Application submitted!".
    const successDom = !!document.querySelector('.confirmation-message, [data-qa="msg-submit-success"]');
    const successUrl = /\\/thanks(?:[?#]|$)/i.test(url) || /[?&]LeverAppId=/i.test(url);
    const successText = /application submitted|thank you for applying|we.ve received your application/i.test(text);
    const duplicate = /\\/already-received(?:[?#]|$)/i.test(url) || /already (applied|received|submitted)|you have already applied/i.test(text);
    const error = /there was an error verifying your application|this field is required|please (complete|fill|enter|select)|verify you are human|complete the captcha/i.test(text) && !successDom && !successUrl;
    const confirmed = successUrl || successDom || successText;
    const m = (text.match(/application submitted|thank you for applying|we.ve received your application|already (applied|received|submitted)/i) || url.match(/\\/thanks|already-received|LeverAppId=[^&]+/i));
    return { confirmed, duplicate, error, evidence: m ? String(m[0]).slice(0, 60) : null, formGone: !document.getElementById('application-form') };
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
    // Lever's real control is type="button" (id/class/data-qa pinned below);
    // accept submit|button but require the EXACT marked control + label.
    const type = (btn.getAttribute('type') || 'submit').toLowerCase();
    if (type !== 'submit' && type !== 'button') return { ok: false, code: 'UNEXPECTED_CONTROL' };
    const marked = btn.getAttribute('data-qa') === 'btn-submit' || /\\btemplate-btn-submit\\b/.test(String(btn.className || ''));
    if (!marked) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    return { ok: true, control: 'lever:application-submit' };
  })()`;
}

// ── AGENT PRIMITIVES (Phase 1: one decision layer) ─────────────────────────
// These are the agent's HANDS only: observe is strictly read-only; act executes
// a single validated primitive. Neither makes any decision. Submit controls and
// CAPTCHA elements are structurally unreachable through act — submission only
// ever happens through the authorized performSubmit path.

/** READ-ONLY page inventory: ref-tagged fields/buttons/errors for the loop. */
function buildObserveScript() {
  return `(() => {
    const REF = 'data-ta-ref';
    for (const old of document.querySelectorAll('[' + REF + ']')) old.removeAttribute(REF);
    let n = 0;
    const ref = (el) => { const r = 'ta' + (++n); el.setAttribute(REF, r); return r; };
    const text = (v) => String(v == null ? '' : v).trim().slice(0, 200);
    const labelOf = (el) => {
      try {
        // Prefer the question-scoped label div (EEO selects sit inside a
        // wrapping <label> whose text would otherwise include every option).
        const q = el.closest('.application-question, .application-field, .card-field');
        if (q) { const lab = q.querySelector('.application-label'); if (lab && lab.textContent) return text(lab.textContent); }
        const id = el.getAttribute('id');
        if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l && l.textContent) return text(l.textContent); }
        const wrap = el.closest('label');
        if (wrap) {
          const clone = wrap.cloneNode(true);
          for (const c of clone.querySelectorAll('input, select, textarea, button, a, [data-expand-selector], [id*="Expandable"]')) c.remove();
          if (clone.textContent) return text(clone.textContent);
        }
        return text(el.getAttribute('aria-label'));
      } catch (e) { return ''; }
    };
    // Custom questions hide their real text in cards[...][baseTemplate] JSON.
    const templateCache = new Map();
    const loadTemplate = (cardId) => {
      let tpl = templateCache.get(cardId);
      if (tpl === undefined) {
        const input = document.querySelector('input[name="cards[' + cardId + '][baseTemplate]"]');
        let parsed = null;
        if (input && input.value) {
          const raw = String(input.value).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&amp;/g, '&');
          try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        }
        tpl = parsed;
        templateCache.set(cardId, tpl);
      }
      return tpl;
    };
    const cardTemplateField = (name) => {
      try {
        const m = /^cards\\[([^\\]]+)\\]\\[field(\\d+)\\]$/.exec(String(name || ''));
        if (!m) return {};
        const tpl = loadTemplate(m[1]);
        const f = tpl && Array.isArray(tpl.fields) ? tpl.fields[Number(m[2])] : null;
        if (!f) return {};
        return {
          text: typeof f.text === 'string' ? text(f.text) : '',
          required: !!f.required,
          options: (Array.isArray(f.options) ? f.options : [])
            .map((o) => text(o && typeof o === 'object' ? (o.text || '') : o))
            .filter(Boolean)
            .slice(0, 30),
        };
      } catch (e) { return {}; }
    };
    const cardQuestion = (name) => cardTemplateField(name).text || '';
    const labelFor = (el) => labelOf(el) || cardQuestion(el.name) || text(el.getAttribute('name'));
    const visible = (el) => { try { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return !!(r && (r.width > 0 || r.height > 0)); } catch (e) { return false; } };
    const form = document.getElementById('application-form') || document.body;
    const fields = [];
    const seenGroups = new Set();
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const type = String(el.getAttribute('type') || el.tagName).toLowerCase();
      // Custom-dropdown questions post through hidden cards[...][fieldN] inputs;
      // surface them (with template options) so the loop can fill them.
      if (type === 'hidden' && /^cards\\[.+\\]\\[field\\d+\\]$/.test(String(el.name || ''))) {
        const t = cardTemplateField(el.name);
        if (!t.text) continue; // not a question field (metadata/hidden)
        fields.push({
          ref: ref(el), kind: 'custom-select', name: el.name || '', label: t.text,
          required: !!t.required, value: String(el.value || ''),
          options: (t.options || []).map((o) => ({ option: o, checked: String(el.value || '') === o })),
        });
        continue;
      }
      if (type === 'hidden' || type === 'password') continue;
      if (type === 'file') { fields.push({ ref: ref(el), kind: 'file', name: el.name || '', label: labelFor(el), required: !!el.required, value: el.files && el.files.length ? String(el.files[0].name).slice(0, 80) : '' }); continue; }
      if (type === 'radio' || type === 'checkbox') {
        const name = el.name || '';
        if (name && seenGroups.has(name)) continue;
        if (name) seenGroups.add(name);
        const group = name ? Array.from(form.querySelectorAll('[name="' + CSS.escape(name) + '"]')) : [el];
        const consentish = /consent|agree|terms|privacy/i.test(name) || /consent|agree|terms|privacy/i.test(labelOf(el));
        fields.push({
          ref: ref(el),
          kind: type === 'radio' ? 'radio' : (group.length > 1 ? 'checkbox-group' : 'checkbox'),
          name, label: labelFor(el), required: group.some((g) => g.required), consent: consentish,
          options: group.map((g) => ({ option: text(g.value || (g.closest('label') ? g.closest('label').textContent : '')), checked: !!g.checked })).slice(0, 50),
        });
        continue;
      }
      if (!visible(el)) continue;
      if (el.tagName === 'SELECT') {
        fields.push({ ref: ref(el), kind: 'select', name: el.name || '', label: labelFor(el), required: !!el.required, value: String(el.value || '').slice(0, 120),
          options: Array.from(el.options)
            .map((o) => ({ option: text(o.text), checked: !!o.selected }))
            .filter((o) => o.option && !/^select\\s*\\.{0,3}$/i.test(o.option))
            .slice(0, 50) });
        continue;
      }
      fields.push({ ref: ref(el), kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', name: el.name || '', label: labelFor(el), required: !!el.required, value: String(el.value || '').slice(0, 300) });
      if (fields.length >= 120) break;
    }
    const buttons = [];
    for (const el of form.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      if (!visible(el)) continue;
      if (buttons.length >= 20) break;
      buttons.push({ ref: ref(el), label: text(el.textContent || el.value), id: el.id || '', disabled: !!el.disabled });
    }
    const captchaPresent = (() => {
      try {
        const t = document.querySelector('textarea[name="h-captcha-response"], input[name="h-captcha-response"], textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]');
        if (t && String(t.value || '').trim()) return false;
        return Array.from(document.querySelectorAll('iframe[title*="hCaptcha" i], iframe[src*="hcaptcha.com"], iframe[title*="reCAPTCHA" i], iframe[src*="/recaptcha/"]')).some((f) => {
          const cs = getComputedStyle(f); if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = f.getBoundingClientRect(); return !!(r && r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0);
        });
      } catch (e) { return false; }
    })();
    const errors = Array.from(document.querySelectorAll('.error-message, [role="alert"]')).map((e) => text(e.textContent)).filter(Boolean).slice(0, 6);
    const sc = document.getElementById('btn-submit');
    return {
      url: location.href, title: document.title,
      formPresent: !!document.getElementById('application-form'),
      captchaPresent, errors, fields, buttons,
      submitControl: sc ? { ref: ref(sc), label: text(sc.textContent), disabled: !!sc.disabled, visible: visible(sc) } : null,
      diagnostics: {
        hcapApi: typeof window.hcaptcha !== 'undefined',
        hcapResponse: String((document.getElementById('hcaptchaResponseInput') || {}).value || '').length,
        hcapSubmitBtn: !!document.getElementById('hcaptchaSubmitBtn'),
        visibility: String(document.visibilityState || ''),
        hcapContainer: (() => {
          const c = document.getElementById('h-captcha');
          if (!c) return null;
          const r = (() => { try { return c.getBoundingClientRect(); } catch (e) { return null; } })();
          return { children: c.childElementCount, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
        })(),
        iframes: Array.from(document.querySelectorAll('iframe')).map((f) => String(f.src || '').slice(0, 90)).slice(0, 6),
        locationValue: String((document.getElementById('location-input') || {}).value || '').slice(0, 80),
        selectedLocation: String((document.getElementById('selected-location') || {}).value || '').slice(0, 120),
      },
    };
  })()`;
}

const AGENT_DOM_ACTIONS = ['type', 'select', 'check', 'click', 'scroll'];

/** Validate + whitelist ONE agent action (main-process gate, renderer untrusted). */
function validateAgentAction(action) {
  if (!action || typeof action !== 'object') return null;
  const a = String(action.action || '');
  const ref = String(action.ref || '');
  if (!/^ta[0-9]{1,4}$/.test(ref)) return null;
  if (a === 'upload_resume') return { action: 'upload_resume', ref };
  if (!AGENT_DOM_ACTIONS.includes(a)) return null;
  const out = { action: a, ref };
  if (typeof action.value === 'string') out.value = action.value.slice(0, 5000);
  if (typeof action.option === 'string') out.option = action.option.slice(0, 300);
  return out;
}

/** Execute ONE validated primitive. Never touches submit controls or CAPTCHA. */
function buildActScript(action) {
  return `(() => {
    const a = ${JSON.stringify(action)};
    const el = document.querySelector('[data-ta-ref="' + a.ref + '"]');
    if (!el) return { ok: false, code: 'STALE_REF' };
    const submitish = (x) => { try { if (x.id === 'btn-submit' || x.getAttribute('data-qa') === 'btn-submit') return true; return /template-btn-submit/.test(String(x.className || '')); } catch (e) { return false; } };
    if (submitish(el)) return { ok: false, code: 'SUBMIT_REQUIRES_AUTHORIZED_PATH' };
    const captchaish = (x) => { try { let p = x; for (let i = 0; i < 4 && p; i++) { if (p.classList && (p.classList.contains('h-captcha') || p.classList.contains('g-recaptcha'))) return true; p = p.parentElement; } return false; } catch (e) { return false; } };
    if (captchaish(el)) return { ok: false, code: 'CAPTCHA_NEVER_TOUCHED' };
    const fire = (node, evs) => { for (const t of evs) node.dispatchEvent(new Event(t, { bubbles: true })); };
    const setNative = (node, value) => {
      try {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(node, value); else node.value = value;
        return true;
      } catch (e) { try { node.value = value; return true; } catch (e2) { return false; } }
    };
    if (a.action === 'type') {
      const textValue = String(a.value == null ? '' : a.value);
      const isLocation = (el.name === 'location' || el.id === 'location-input');
      if (!setNative(el, textValue)) return { ok: false, code: 'SET_FAILED' };
      // Lever's location input runs a typeahead search on 'input' whose blur
      // handler CLEARS both the field and the hidden selectedLocation once the
      // results dropdown has shown. Fire ONLY 'change': it marks the field as
      // user-touched for parseResume.js (which otherwise later overwrites it
      // with '' — updateIfUntouched), but never triggers the dropdown.
      if (isLocation) {
        fire(el, ['change']);
        const hidden = document.querySelector('input[name="selectedLocation"]');
        if (hidden) hidden.value = textValue.trim() ? JSON.stringify({ name: textValue.trim() }) : '';
        return { ok: true, value: String(el.value || '').slice(0, 100), location: true };
      }
      fire(el, ['input', 'change']);
      return { ok: true, value: String(el.value || '').slice(0, 100) };
    }
    if (a.action === 'select') {
      const want = String(a.value == null ? (a.option || '') : a.value).trim().toLowerCase();
      let hit = null;
      for (const o of el.options) { if (String(o.value).trim().toLowerCase() === want || String(o.text).trim().toLowerCase() === want) { hit = o; break; } }
      if (!hit) return { ok: false, code: 'OPTION_NOT_FOUND' };
      el.selectedIndex = hit.index;
      fire(el, ['input', 'change']);
      return { ok: true, value: String(el.value) };
    }
    if (a.action === 'check') {
      const bv = a.value;
      if (bv === true || bv === false || bv === 'true' || bv === 'false') {
        const on = bv === true || bv === 'true';
        if (el.checked !== on) { el.checked = on; fire(el, ['input', 'change']); }
        return { ok: true, checked: on };
      }
      const name = el.name || '';
      const group = name ? Array.from(document.querySelectorAll('[name="' + CSS.escape(name) + '"]')) : [el];
      const want = String(a.option || a.value || '').trim().toLowerCase();
      const match = (g) => {
        const v = String(g.value || '').trim().toLowerCase();
        if (v && v === want) return true;
        const lbl = g.closest('label');
        return !!(lbl && String(lbl.textContent || '').trim().toLowerCase() === want);
      };
      let hits = 0;
      for (const g of group) { const on = match(g); if (on) hits += 1; if (g.checked !== on) { g.checked = on; fire(g, ['input', 'change']); } }
      if (!hits) return { ok: false, code: 'OPTION_NOT_FOUND' };
      return { ok: true, checked: hits };
    }
    if (a.action === 'click') { try { el.click(); return { ok: true }; } catch (e) { return { ok: false, code: 'CLICK_FAILED' }; } }
    if (a.action === 'scroll') { try { el.scrollIntoView({ block: 'center' }); return { ok: true }; } catch (e) { return { ok: false, code: 'SCROLL_FAILED' }; } }
    return { ok: false, code: 'UNKNOWN_ACTION' };
  })()`;
}

module.exports = {
  LEVER_HOST,
  buildObserveScript,
  buildActScript,
  validateAgentAction,
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
