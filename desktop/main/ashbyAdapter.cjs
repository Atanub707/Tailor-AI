'use strict';
// Ashby adapter — jobs.ashbyhq.com application forms.
//
// Implements the SAME agent interface as leverAdapter.cjs / greenhouseAdapter.cjs
// so browserSession can pick an adapter per session by URL.
//
// Ashby facts (verified live on real boards):
//   - SPA, NO <form> element; plain inputs/radios/textareas.
//   - Core fields are id-based: #_systemfield_name / #_systemfield_email /
//     #_systemfield_resume (hidden file input behind an "Upload file" button).
//   - Custom questions are UUID-id plain inputs; radio groups are native
//     radios (value="on"!) whose option text lives in label[for].
//   - Invisible reCAPTCHA (anchor iframe + g-recaptcha-response token).
//   - Submit is a <button> with text "Submit Application".
//
// Guardrails identical to the other providers: never touch submit controls via
// act, never touch CAPTCHA nodes, exactly-once submit through the authorized
// path, positive-only confirmation markers.

const ASHBY_HOST = 'jobs.ashbyhq.com';

/** Parse an Ashby application URL. Same contract as lever.parseLeverUrl:
 *  { canonical, siteSlug, postingId, isApplyPage } or null for foreign hosts. */
function parseLeverUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== ASHBY_HOST) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const siteSlug = parts[0];
  const postingId = parts[1];
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(siteSlug) || !/^[A-Za-z0-9-]{6,64}$/.test(postingId)) return null;
  const isApplyPage = /^application\/?$/.test(parts[2] || '');
  return {
    canonical: `https://${host}/${siteSlug}/${postingId}`,
    siteSlug,
    postingId,
    isApplyPage,
  };
}

/** The form route (canonical job URL + this suffix). */
function applySuffix() {
  return '/application';
}

/** READ-ONLY page identity probe. */
function buildIdentityScript() {
  return `(() => ({ href: location.href }))()`;
}

/** Resume file input selector (hidden behind the "Upload file" button). */
function resumeSelector() {
  return 'input[type="file"]#_systemfield_resume, input[type="file"][name="_systemfield_resume"]';
}

/** READ-ONLY page inventory for the agent loop (shared agentDecision shape). */
function buildObserveScript() {
  return `(() => {
    const REF = 'data-ta-ref';
    for (const old of document.querySelectorAll('[' + REF + ']')) old.removeAttribute(REF);
    let n = 0;
    const ref = (el) => { n += 1; const r = 'ta' + n; el.setAttribute(REF, r); return r; };
    const text = (t) => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
    const visible = (el) => {
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      } catch (e) { return false; }
    };
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && text(l.textContent)) return text(l.textContent).slice(0, 500);
      }
      const aria = el.getAttribute('aria-label');
      if (aria && text(aria)) return text(aria).slice(0, 500);
      const wrap = el.closest('label');
      if (wrap && text(wrap.textContent)) return text(wrap.textContent).slice(0, 500);
      const box = el.closest('[class*="field"], [class*="question"], [class*="input"]');
      const l2 = box ? box.querySelector('label, legend') : null;
      return l2 ? text(l2.textContent).slice(0, 500) : (el.placeholder || el.id || '');
    };
    const groupLabelFor = (node) => {
      const box = node.closest('[role="radiogroup"], fieldset, [class*="field"], [class*="question"], [class*="input"]');
      if (!box) return '';
      const lg = box.querySelector('legend, [class*="label"]:not(label), label:not([for])');
      return lg ? text(lg.textContent).slice(0, 500) : '';
    };
    const groupRequired = (node, groupText) => {
      const box = node.closest('[role="radiogroup"], fieldset, [class*="field"], [class*="question"], [class*="input"]');
      if (box && (box.getAttribute('aria-required') === 'true' || box.querySelector('[aria-required="true"]'))) return true;
      return /\\*\\s*$/.test(String(groupText || '')) || /\\*/.test(String(groupText || ''));
    };

    const fields = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName.toLowerCase())).toLowerCase();
      if (type === 'hidden') continue;
      // File inputs sit behind custom upload buttons (visually hidden) — the
      // REAL attach targets must never be visibility-filtered.
      if (type === 'file') {
        fields.push({ ref: ref(el), kind: 'file', name: el.id || el.name || '', label: labelFor(el),
          required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          value: el.files && el.files.length ? String(el.files[0].name).slice(0, 80) : '' });
        continue;
      }
      if (!visible(el)) continue;
      if (el.tagName === 'SELECT') {
        fields.push({ ref: ref(el), kind: 'select', name: el.id || el.name || '', label: labelFor(el),
          required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          value: String(el.value || '').slice(0, 120),
          options: Array.from(el.options).slice(0, 40).map((o) => ({ option: text(o.text).slice(0, 120), checked: o.selected })) });
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        const groupName = el.getAttribute('name') || '';
        const group = groupName ? Array.from(document.querySelectorAll('[name="' + CSS.escape(groupName) + '"]')) : [el];
        const gLabel = groupLabelFor(el);
        fields.push({ ref: ref(el), kind: type === 'radio' ? 'radio' : (group.length > 1 ? 'checkbox-group' : 'checkbox'),
          name: groupName, label: labelFor(el), groupLabel: gLabel || undefined,
          required: groupRequired(el, gLabel),
          value: String(el.value || '').slice(0, 120), checked: !!el.checked });
        continue;
      }
      fields.push({ ref: ref(el), kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', name: el.id || el.name || '',
        label: labelFor(el), required: !!(el.required || el.getAttribute('aria-required') === 'true'),
        value: String(el.value || '').slice(0, 300) });
    }

    // Invisible reCAPTCHA: a VISIBLE challenge iframe is the only human
    // checkpoint (the badge/anchor alone is not).
    const challengeIframe = Array.from(document.querySelectorAll('iframe[title*="recaptcha" i], iframe[src*="/recaptcha/"]'))
      .find((f) => {
        const src = String(f.src || '');
        const t = String(f.title || '');
        if (!visible(f)) return false;
        return /bframe|challenge/i.test(src) || /challenge/i.test(t);
      });

    const errors = Array.from(document.querySelectorAll('[aria-invalid="true"], [class*="error" i]:not(:empty), [role="alert"]'))
      .filter((e) => visible(e) && text(e.textContent))
      .map((e) => text(e.textContent).slice(0, 140)).slice(0, 6);

    const submitBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => /submit application/i.test(text(b.textContent)));
    return {
      url: location.href, title: document.title,
      formPresent: true,
      captchaPresent: !!challengeIframe, errors, fields,
      buttons: [],
      submitControl: submitBtn ? { ref: ref(submitBtn), label: text(submitBtn.textContent), disabled: !!submitBtn.disabled, visible: visible(submitBtn) } : null,
    };
  })()`;
}

/** Same allow-list as Lever/Greenhouse — action validation is provider-neutral. */
const { validateAgentAction } = require('./leverAdapter.cjs');

/** Execute ONE validated primitive. Never touches submit controls or CAPTCHA.
 *  Text fields use the trusted-input protocol (NEEDS_TRUSTED_TYPE); native
 *  radios/checkboxes are clicked with real input for React to react. */
function buildActScript(action) {
  return `(() => {
    const a = ${JSON.stringify(action)};
    const el = document.querySelector('[data-ta-ref="' + a.ref + '"]');
    if (!el) return { ok: false, code: 'STALE_REF' };
    const submitish = (x) => { try { return (x.getAttribute('type') || '').toLowerCase() === 'submit' || /submit application/i.test(String(x.textContent || '').trim()); } catch (e) { return false; } };
    if (submitish(el)) return { ok: false, code: 'SUBMIT_REQUIRES_AUTHORIZED_PATH' };
    const captchaish = (x) => { try { let p = x; for (let i = 0; i < 4 && p; i++) { if (p.classList && (p.classList.contains('g-recaptcha') || p.classList.contains('h-captcha'))) return true; p = p.parentElement; } return false; } catch (e) { return false; } };
    if (captchaish(el)) return { ok: false, code: 'CAPTCHA_NEVER_TOUCHED' };
    const fire = (node, evs) => { for (const t of evs) node.dispatchEvent(new Event(t, { bubbles: true })); };
    const instantScroll = async (node) => {
      try { document.documentElement.style.scrollBehavior = 'auto'; document.body.style.scrollBehavior = 'auto'; } catch (e) { /* best-effort */ }
      try { node.scrollIntoView({ block: 'center' }); } catch (e) { /* best-effort */ }
      let last = -1;
      for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 60)); if (Math.abs(window.scrollY - last) < 1) break; last = window.scrollY; }
    };
    const measure = (node) => {
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };

    if (a.action === 'type') {
      if (el.tagName === 'SELECT') {
        const want = String(a.value == null ? '' : a.value).trim().toLowerCase();
        let hit = null;
        for (const o of el.options) { if (String(o.value).trim().toLowerCase() === want || String(o.text).trim().toLowerCase() === want) { hit = o; break; } }
        if (!hit) return { ok: false, code: 'OPTION_NOT_FOUND' };
        el.selectedIndex = hit.index;
        fire(el, ['input', 'change']);
        return { ok: true, value: String(el.value) };
      }
      // Text-ish inputs: TRUSTED input only (real keyboard events keep React
      // state in sync). Measure; the session types and reads back.
      const rr0 = el.getBoundingClientRect();
      if (rr0.top < 60 || rr0.bottom > window.innerHeight - 60) {
        return { ok: false, code: 'NEEDS_TRUSTED_TYPE', rect: measure(el), scroll: true };
      }
      return { ok: false, code: 'NEEDS_TRUSTED_TYPE', rect: measure(el) };
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
        if (el.checked !== on) { el.click(); }
        return { ok: true, checked: el.checked };
      }
      const name = el.name || '';
      const group = name ? Array.from(document.querySelectorAll('[name="' + CSS.escape(name) + '"]')) : [el];
      const want = String(a.option || a.value || '').trim().toLowerCase();
      const optText = (g) => {
        const byLabel = g.id ? document.querySelector('label[for="' + CSS.escape(g.id) + '"]') : null;
        const wrap = g.closest('label');
        return String((byLabel ? byLabel.textContent : (wrap ? wrap.textContent : '')) || '').trim().toLowerCase();
      };
      const match = (g) => {
        const v = String(g.value || '').trim().toLowerCase();
        if (v && v !== 'on' && v === want) return true;
        return optText(g) === want;
      };
      let hits = 0;
      for (const g of group) {
        const on = match(g);
        if (on) hits += 1;
        if (on && !g.checked) g.click();
      }
      if (!hits) return { ok: false, code: 'OPTION_NOT_FOUND' };
      return { ok: true, checked: hits };
    }
    if (a.action === 'click') { try { el.click(); return { ok: true }; } catch (e) { return { ok: false, code: 'CLICK_FAILED' }; } }
    if (a.action === 'scroll') { try { el.scrollIntoView({ block: 'center' }); return { ok: true }; } catch (e) { return { ok: false, code: 'SCROLL_FAILED' }; } }
    return { ok: false, code: 'UNKNOWN_ACTION' };
  })()`;
}

/** Explicit submission: exact control identity, trusted-input option. */
function buildSubmitScript(opts) {
  const trustedInput = !!(opts && opts.trustedInput);
  return `(() => {
    const text = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /submit application/i.test(text(b.textContent)));
    if (!btn) return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* keep measuring */ }
    const rect = (() => { try { const r = btn.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; } })();
    const useTrusted = ${trustedInput ? 'true' : 'false'};
    if (!useTrusted) btn.click();
    return { ok: true, control: 'ashby:application-submit', rect, clicked: !useTrusted };
  })()`;
}

function buildSubmitControlCheckScript() {
  return `(() => {
    const text = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /submit application/i.test(text(b.textContent)));
    if (!btn) return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    return { ok: true, control: 'ashby:application-submit' };
  })()`;
}

/** Human-checkpoint probe: reCAPTCHA token + visible challenge. */
function buildCheckpointScript() {
  return `(() => {
    const tokenField = document.querySelector('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]');
    const token = String((tokenField && tokenField.value) || '').trim();
    const captchaFieldFilled = token.length > 0;
    const visible = (el) => {
      if (!el) return false;
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      } catch (e) { return false; }
    };
    const challengeVisible = Array.from(document.querySelectorAll('iframe[title*="recaptcha" i], iframe[src*="/recaptcha/"]'))
      .some((f) => visible(f) && (/bframe|challenge/i.test(String(f.src || '')) || /challenge/i.test(String(f.title || ''))));
    const captchaPresent = !captchaFieldFilled && challengeVisible;
    return { formGone: false, captchaPresent, captchaFieldFilled, cleared: captchaFieldFilled || !captchaPresent };
  })()`;
}

/** Confirmation detection — POSITIVE markers only (never absence of the form). */
function buildConfirmationScript() {
  return `(() => {
    const url = location.href;
    const text = document.body ? (document.body.innerText || '') : '';
    const successText = /application (has been |was )?(successfully )?submitted|thanks? (you )?for (applying|submitting|your application)|thank you for (applying|your interest|your application)|we('ve| have) received your application|your application (has been |was )?received|successfully applied|gracias por (aplicar|postularte|tu solicitud)|hemos recibido (tu|su) (solicitud|candidatura)|obrigado por (se candidatar|sua candidatura)|recebemos sua candidatura|merci (d'avoir|pour avoir) postul|nous avons (bien )?re[cç]u votre candidature|vielen dank f(ü|u)r (ihre|deine) bewerbung|wir haben (ihre|deine) bewerbung erhalten/i.test(text);
    const duplicate = /already (applied|submitted)|you('ve| have) already applied|ya (te|se) (has|ha) (postulado|aplicado)|j(á|a) (se )?candidatou|vous avez d(é|e)j(à|a) postul|bereits beworben/i.test(text);
    const error = !successText && !duplicate && (/please (complete|fill|correct|enter|select)/i.test(text) || /captcha/i.test(text) || !!document.querySelector('[aria-invalid="true"]'));
    const confirmed = successText;
    const m = text.match(/application (has been |was )?(successfully )?submitted|thanks? (you )?for (applying|submitting|your application)|thank you for applying|we('ve| have) received your application|gracias por aplicar|hemos recibido|obrigado por se candidatar|vielen dank|merci/i);
    return { confirmed, duplicate, error, evidence: m ? String(m[0]).slice(0, 60) : null, formGone: false };
  })()`;
}

// ── Legacy scripted-mode helpers (agent mode is required for Ashby) ──
function unsupported() {
  return `(() => ({ ok: false, code: 'AGENT_MODE_REQUIRED' }))()`;
}

module.exports = {
  ASHBY_HOST,
  parseLeverUrl,
  applySuffix,
  resumeSelector,
  buildIdentityScript,
  buildObserveScript,
  validateAgentAction,
  buildActScript,
  buildSubmitScript,
  buildSubmitControlCheckScript,
  buildCheckpointScript,
  buildConfirmationScript,
  buildFillScript: unsupported,
  buildReadBackScript: unsupported,
  buildPlanScript: unsupported,
};
