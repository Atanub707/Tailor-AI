'use strict';
// Greenhouse adapter — job-boards.greenhouse.io / boards.greenhouse.io.
//
// Implements the SAME agent interface as leverAdapter.cjs so browserSession can
// pick an adapter per session by URL (parseLeverUrl, buildIdentityScript,
// buildObserveScript, validateAgentAction, buildActScript, buildSubmitScript,
// buildSubmitControlCheckScript, buildCheckpointScript, buildConfirmationScript).
// Legacy scripted-mode helpers exist as honest stubs (agent mode is required).
//
// Guardrails identical to Lever: never touch submit controls via act, never
// touch CAPTCHA nodes, exactly-once submit through the authorized path,
// positive-only confirmation markers.

const GREENHOUSE_HOSTS = ['greenhouse.io', 'job-boards.greenhouse.io', 'boards.greenhouse.io'];

/** Parse a Greenhouse application URL. Same contract as lever.parseLeverUrl:
 *  { canonical, siteSlug, postingId, isApplyPage } or null for foreign hosts.
 *  The boards URL IS the application page (the form renders on it). */
function parseLeverUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!GREENHOUSE_HOSTS.includes(host) && !host.endsWith('.greenhouse.io')) return null;
  if (!/^(job-boards|boards)(\.[a-z]{2})?\.greenhouse\.io$/.test(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const jobsIdx = parts.indexOf('jobs');
  if (jobsIdx !== 1 || !parts[0] || !parts[2]) return null;
  const siteSlug = parts[0];
  const postingId = parts[2];
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(siteSlug) || !/^[0-9]{4,20}$/.test(postingId)) return null;
  return {
    canonical: `https://${host}/${siteSlug}/jobs/${postingId}`,
    siteSlug,
    postingId,
    isApplyPage: true,
  };
}

/** READ-ONLY page identity probe. */
function buildIdentityScript() {
  return `(() => ({ href: location.href }))()`;
}

/** READ-ONLY page inventory for the agent loop. Mirrors the Lever observe
 *  shape (shared agentDecision contract). */
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
    const form = document.getElementById('application-form') || document.querySelector('form');
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

    const fields = [];
    const scope = form || document;
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName.toLowerCase())).toLowerCase();
      if (type === 'hidden') continue;
      // File inputs sit behind custom upload buttons (visually-hidden) — they
      // are the REAL attach targets and must never be visibility-filtered.
      if (type === 'file') {
        fields.push({ ref: ref(el), kind: 'file', name: el.id || el.name || '', label: labelFor(el), required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          value: el.files && el.files.length ? String(el.files[0].name).slice(0, 80) : '' });
        continue;
      }
      if (el.tagName === 'SELECT') {
        fields.push({ ref: ref(el), kind: 'select', name: el.id || el.name || '', label: labelFor(el), required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          value: String(el.value || '').slice(0, 120),
          options: Array.from(el.options).slice(0, 40).map((o) => ({ option: text(o.text).slice(0, 120), checked: o.selected })) });
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        const groupName = el.getAttribute('name') || '';
        const group = groupName ? Array.from(document.querySelectorAll('[name="' + CSS.escape(groupName) + '"]')) : [el];
        // Radio/checkbox members: label = the OPTION text, groupLabel = the
        // question (legend). Multi-value groups resolve from the question and
        // check the matching member(s).
        const groupLabelFor = (node) => {
          const fs = node.closest('fieldset');
          if (fs) { const lg = fs.querySelector('legend'); if (lg && text(lg.textContent)) return text(lg.textContent).slice(0, 500); }
          const box = node.closest('[class*="field"], [class*="question"]');
          if (box) { const lg = box.querySelector('legend'); if (lg && text(lg.textContent)) return text(lg.textContent).slice(0, 500); }
          return '';
        };
        fields.push({ ref: ref(el), kind: type === 'radio' ? 'radio' : (group.length > 1 ? 'checkbox-group' : 'checkbox'),
          name: groupName, label: labelFor(el), groupLabel: groupLabelFor(el) || undefined,
          required: !!(el.required || el.getAttribute('aria-required') === 'true'), value: String(el.value || '').slice(0, 120), checked: !!el.checked });
        continue;
      }
      // Greenhouse "select" combobox: a text input driving a listbox popover.
      if (el.classList && el.classList.contains('select__input')) {
        // react-select: after selection the search input is EMPTY and the
        // chosen value lives in .select__single-value — read THAT. Leftover
        // filter text is NOT a value (it masked stuck fields as filled).
        const control = el.closest('.select__control') || el.parentElement;
        const single = control ? control.querySelector('.select__single-value') : null;
        const selText = single ? text(single.textContent) : '';
        fields.push({ ref: ref(el), kind: 'custom-select', name: el.id || '', label: labelFor(el), required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          value: selText.slice(0, 120), options: [] });
        continue;
      }
      fields.push({ ref: ref(el), kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', name: el.id || el.name || '',
        label: labelFor(el), required: !!(el.required || el.getAttribute('aria-required') === 'true'), value: String(el.value || '').slice(0, 300) });
    }

    const buttons = Array.from((form || document).querySelectorAll('button, a[role="button"]'))
      .filter((b) => visible(b) && !b.disabled)
      .map((b) => ({ ref: ref(b), label: text(b.textContent).slice(0, 60), type: (b.getAttribute('type') || '').toLowerCase() }))
      .filter((b) => b.label);

    // reCAPTCHA Enterprise: invisible by default; a VISIBLE challenge iframe is
    // the only human checkpoint. The grecaptcha badge (small, corner) is not.
    const challengeIframe = Array.from(document.querySelectorAll('iframe[title*="recaptcha" i], iframe[src*="/recaptcha/"]'))
      .find((f) => {
        const src = String(f.src || '');
        const t = String(f.title || '');
        if (!visible(f)) return false;
        return /bframe|challenge/i.test(src) || /challenge/i.test(t);
      });
    const captchaPresent = !!challengeIframe;

    const errors = Array.from(document.querySelectorAll('[aria-invalid="true"], [class*="error" i]:not(:empty), [role="alert"]'))
      .filter((e) => visible(e) && text(e.textContent))
      .map((e) => text(e.textContent).slice(0, 140)).slice(0, 6);

    // Greenhouse renders mirror nodes for some widgets (e.g. Country appears as
    // both a combobox and a plain mirror input). Keep the interactive one.
    const rank = (k) => (k === 'custom-select' ? 4 : k === 'file' ? 3 : (k === 'radio' || k === 'checkbox' || k === 'checkbox-group') ? 2 : k === 'select' ? 1 : 0);
    const byLabel = new Map();
    const kept = [];
    for (const f of fields) {
      const key = String(f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!key) { kept.push(f); continue; }
      const prev = byLabel.get(key);
      if (!prev) { byLabel.set(key, f); kept.push(f); continue; }
      if (rank(f.kind) > rank(prev.kind)) {
        kept[kept.indexOf(prev)] = f;
        byLabel.set(key, f);
      }
    }
    const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    return {
      url: location.href, title: document.title,
      formPresent: !!form,
      captchaPresent, errors, fields: kept, buttons,
      submitControl: submitBtn ? { ref: ref(submitBtn), label: text(submitBtn.textContent), disabled: !!submitBtn.disabled, visible: visible(submitBtn) } : null,
    };
  })()`;
}

/** Same allow-list as Lever — action validation is provider-neutral. */
const { validateAgentAction } = require('./leverAdapter.cjs');

/** Execute ONE validated primitive. Never touches submit controls or CAPTCHA.
 *  Async: Greenhouse's combobox needs to wait for its listbox to render. */
function buildActScript(action) {
  return `(async () => {
    const a = ${JSON.stringify(action)};
    const el = document.querySelector('[data-ta-ref="' + a.ref + '"]');
    if (!el) return { ok: false, code: 'STALE_REF' };
    const submitish = (x) => { try { const form = document.getElementById('application-form') || document.querySelector('form'); return !!(form && x.closest('form') === form && (x.getAttribute('type') || '').toLowerCase() === 'submit'); } catch (e) { return false; } };
    if (submitish(el)) return { ok: false, code: 'SUBMIT_REQUIRES_AUTHORIZED_PATH' };
    const captchaish = (x) => { try { let p = x; for (let i = 0; i < 4 && p; i++) { if (p.classList && (p.classList.contains('g-recaptcha') || p.classList.contains('h-captcha'))) return true; p = p.parentElement; } return false; } catch (e) { return false; } };
    if (captchaish(el)) return { ok: false, code: 'CAPTCHA_NEVER_TOUCHED' };
    const fire = (node, evs) => { for (const t of evs) node.dispatchEvent(new Event(t, { bubbles: true })); };
    const instantScroll = async (node, block) => {
      try {
        document.documentElement.style.scrollBehavior = 'auto';
        document.body.style.scrollBehavior = 'auto';
      } catch (e) { /* best-effort */ }
      try { node.scrollIntoView({ block: block || 'center' }); } catch (e) { /* best-effort */ }
      let last = -1;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 60));
        if (Math.abs(window.scrollY - last) < 1) break;
        last = window.scrollY;
      }
    };
    const setNative = (node, value) => {
      try {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(node, value); else node.value = value;
        return true;
      } catch (e) { try { node.value = value; return true; } catch (e2) { return false; } }
    };
    // SCOPED menu lookup: only THIS field's react-select menu counts. The
    // intl-tel-input widget keeps a PERMANENT 244-option [role="listbox"]
    // (iti__country-list) in the DOM — reading it poisoned every combobox.
    const findOpenMenu = () => {
      try {
        const own = document.querySelector('.select__menu');
        if (own) return own;
        const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        if (id) { const m = document.getElementById(id); if (m && !m.classList.contains('iti__country-list')) return m; }
        const cont = el.closest('.select__container') || el.closest('.select__control');
        const local = cont ? cont.querySelector('.select__menu') : null;
        if (local) return local;
        // Portaled react-select menus: react-select keeps focus on THIS input
        // while its own menu is open — only then read a NON-iti listbox.
        const active = document.activeElement;
        const ctl = el.closest('.select__control');
        if (active && ctl && (ctl.contains(active) || active === el)) {
          return document.querySelector('[role="listbox"]:not(.iti__country-list):not([class*="iti__"])');
        }
        return null;
      } catch (e) { return null; }
    };
    const findComboboxOption = async (wanted) => {
      const want = String(wanted || '').trim().toLowerCase();
      const startMs = Date.now();
      while (Date.now() < startMs + 8000) {
        await new Promise((r) => setTimeout(r, 200));
        const list = findOpenMenu();
        const opts = list ? Array.from(list.querySelectorAll('[role="option"], li, [class*="option"]'))
          .filter((o) => String(o.textContent || '').trim()) : [];
        if (!opts.length) continue;
        // Option text can carry a dial code ("India +91") — strip it, then
        // prefer EXACT matches so "India" never loses to "British Indian Ocean
        // Territory" (which merely contains the word).
        const clean = (o) => String(o.textContent || '').trim().toLowerCase().replace(/\\s*\\+\\d+$/, '').trim();
        const hit = opts.find((o) => clean(o) === want)
          || opts.find((o) => clean(o).startsWith(want + ' '))
          || opts.slice().sort((a, b) => clean(a).length - clean(b).length).find((o) => clean(o).includes(want) || want.includes(clean(o)));
        if (!hit) continue;
        // Trusted click lands on VIEWPORT coordinates: bring the control (and
        // its portaled menu) into view ONLY when out of sight.
        const cr0 = el.getBoundingClientRect();
        if (cr0.top < 60 || cr0.bottom > window.innerHeight - 60) {
          await instantScroll(el, 'center');
        }
        let r = hit.getBoundingClientRect();
        if (r.top < 4 || r.top > window.innerHeight - 24) {
          window.scrollBy(0, r.top - Math.round(window.innerHeight / 2));
          let last = -1;
          for (let i = 0; i < 15; i++) { await new Promise((r2) => setTimeout(r2, 60)); if (Math.abs(window.scrollY - last) < 1) break; last = window.scrollY; }
          r = hit.getBoundingClientRect();
        }
        return { rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, text: String(hit.textContent || '').trim().slice(0, 80), index: opts.indexOf(hit) };
      }
      const menu = findOpenMenu();
      const all = menu ? Array.from(menu.querySelectorAll('[role="option"], li, [class*="option"]')).map((o) => String(o.textContent || '').trim().replace(/\\s*\\+\\d+$/, '').trim()).filter(Boolean) : [];
      const sample = all.slice(0, 4).map((t) => t.slice(0, 24));
      return { rect: null, diag: { want: want.slice(0, 40), menu: !!menu, opts: menu ? menu.querySelectorAll('[role="option"]').length : 0, sample, options: all.slice(0, 24).map((t) => t.slice(0, 80)) } };
    };
    if (a.action === 'type') {
      const textValue = String(a.value == null ? '' : a.value);
      const isCombobox = !!(el.classList && el.classList.contains('select__input'));
      if (isCombobox) {
        // FULLY-TRUSTED combobox protocol — synthetic events on react-select
        // throw React passive-listener errors and permanently lock the widget.
        // Phase 1: menu closed → measure the control for a trusted open click.
        // Phase 2: menu open → READ the options and measure the match.
        const menuNow = !!findOpenMenu();
        if (!menuNow) {
          const cr0 = el.getBoundingClientRect();
          if (cr0.top < 60 || cr0.bottom > window.innerHeight - 60) {
            await instantScroll(el, 'center');
          }
          const ctl = el.closest('.select__control') || el;
          const cr = ctl.getBoundingClientRect();
          return { ok: false, code: 'NEEDS_TRUSTED_OPEN', rect: { x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2), w: 2, h: 2 } };
        }
        const opt = await findComboboxOption(textValue);
        if (!opt || !opt.rect) {
          if (!findOpenMenu()) {
            const ctl = el.closest('.select__control') || el;
            const cr = ctl.getBoundingClientRect();
            return { ok: false, code: 'NEEDS_TRUSTED_OPEN', rect: { x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2), w: 2, h: 2 } };
          }
          return { ok: false, code: 'OPTION_NOT_FOUND', message: JSON.stringify((opt && opt.diag) || {}) };
        }
        return { ok: false, code: 'NEEDS_TRUSTED_CLICK', rect: opt.rect, option: opt.text, index: typeof opt.index === 'number' ? opt.index : 0 };
      }
      // Text fields: TRUSTED input only. Synthetic input events trip the
      // page's passive-listener React errors (#426/#345) which break the
      // whole form — including the react-select widgets. Measure the field and
      // let the session click + Input.insertText it.
      {
        const rr0 = el.getBoundingClientRect();
        if (rr0.top < 60 || rr0.bottom > window.innerHeight - 60) {
          await instantScroll(el, 'center');
        }
        const r = el.getBoundingClientRect();
        return { ok: false, code: 'NEEDS_TRUSTED_TYPE', rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: 2, h: 2 } };
      }
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

/** Explicit submission (same guarantees as Lever): exact control identity,
 *  trusted-input option for suspicious-click gates. */
function buildSubmitScript(opts) {
  const trustedInput = !!(opts && opts.trustedInput);
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { ok: false, code: 'NO_APPLICATION_FORM' };
    const btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.tagName !== 'BUTTON') return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* keep measuring */ }
    const rect = (() => { try { const r = btn.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; } })();
    const useTrusted = ${trustedInput ? 'true' : 'false'};
    if (!useTrusted) btn.click();
    return { ok: true, control: 'greenhouse:application-submit', rect, clicked: !useTrusted };
  })()`;
}

function buildSubmitControlCheckScript() {
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { ok: false, code: 'NO_APPLICATION_FORM' };
    const btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.tagName !== 'BUTTON') return { ok: false, code: 'NO_SUBMIT_CONTROL' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'SUBMIT_CONTROL_DISABLED' };
    if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) return { ok: false, code: 'SUBMIT_CONTROL_NOT_VISIBLE' };
    if (!/submit application/i.test(String(btn.textContent || '').trim())) return { ok: false, code: 'UNEXPECTED_CONTROL' };
    return { ok: true, control: 'greenhouse:application-submit' };
  })()`;
}

/** Human-checkpoint probe: reCAPTCHA Enterprise token + visible challenge. */
function buildCheckpointScript() {
  return `(() => {
    const form = document.getElementById('application-form');
    if (!form) return { formGone: true, captchaPresent: false, captchaFieldFilled: false, cleared: true };
    const inp = form.querySelector('textarea[name="g-recaptcha-response"]') || form.querySelector('input[name="g-recaptcha-response"]');
    const token = String((inp && inp.value) || '').trim();
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

/** Confirmation detection — POSITIVE markers only (never formGone alone). */
function buildConfirmationScript() {
  return `(() => {
    const url = location.href;
    const text = document.body ? (document.body.innerText || '') : '';
    // Greenhouse serves a universal /confirmation route (any language) and
    // localized thank-you copy — English, Spanish, Portuguese, French, German.
    const successUrl = /\\/confirmation(?:[?#]|$)/i.test(url);
    const successText = /thank you for applying|application (has been|was) (submitted|received)|we('ve| have) received your application|successfully submitted|thanks for applying|gracias por aplicar|hemos recibido (tu|su) (aplicaci|solicitud)|gracias por postularte|obrigado por se candidatar|recebemos sua candidatura|merci (d'avoir|pour avoir) postul|nous avons (bien )?re[cç]u votre candidature|vielen dank f(ü|u)r (ihre|deine) bewerbung|wir haben (ihre|deine) bewerbung erhalten/i.test(text);
    const formGone = !document.getElementById('application-form');
    const duplicate = /already (applied|submitted)|you('ve| have) already applied|ya (te|se) (has|ha) (postulado|aplicado)|ya has enviado|j(á|a) (se )?candidatou|vous avez d(é|e)j(à|a) postul|bereits beworben/i.test(text);
    const error = !successText && !successUrl && (/please (complete|fill|correct|enter|select)/i.test(text) || /captcha/i.test(text) || !!document.querySelector('[aria-invalid="true"]'));
    const confirmed = successUrl || successText;
    const m = (text.match(/thank you for applying|gracias por aplicar|hemos recibido|already (applied|submitted)|ya (te|se)/i) || url.match(/\\/confirmation|already-received|LeverAppId=[^&]+/i));
    return { confirmed, duplicate, error, evidence: m ? String(m[0]).slice(0, 60) : null, formGone };
  })()`;
}

/** Post-click verification for a react-select combobox: the chosen value
 *  lives in .select__single-value (the search input clears on selection). */
function buildComboboxCheckScript(ref) {
  const safeRef = String(ref || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `(() => {
    const el = document.querySelector('[data-ta-ref="${safeRef}"]');
    if (!el) return { value: '' };
    const control = el.closest('.select__control') || el.parentElement;
    const single = control ? control.querySelector('.select__single-value') : null;
    return { value: (single ? String(single.textContent || '') : String(el.value || '')).trim().slice(0, 120) };
  })()`;
}

/** Is THIS field's combobox menu open? Scoped to the field — the permanent
 *  iti__country-list (intl-tel-input) must NEVER count as an open menu. */
function buildMenuCheckScript(ref) {
  const safeRef = String(ref || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `(() => {
    const el = document.querySelector('[data-ta-ref="${safeRef}"]');
    if (!el) return false;
    if (document.querySelector('.select__menu')) return true;
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (id) { const m = document.getElementById(id); if (m && !m.classList.contains('iti__country-list')) return true; }
    const cont = el.closest('.select__container') || el.closest('.select__control');
    if (cont && cont.querySelector('.select__menu')) return true;
    const active = document.activeElement;
    if (cont && active && (cont.contains(active) || active === el)) {
      return !!document.querySelector('[role="listbox"]:not(.iti__country-list):not([class*="iti__"])');
    }
    return false;
  })()`;
}

/** FRESH control center right before a trusted open click: the page re-renders
 *  and scrolls between cycles — a stale rect makes the click miss the widget. */
function buildControlRectScript(ref) {
  const safeRef = String(ref || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `(async () => {
    const el = document.querySelector('[data-ta-ref="${safeRef}"]');
    if (!el) return null;
    try { document.documentElement.style.scrollBehavior = 'auto'; document.body.style.scrollBehavior = 'auto'; } catch (e) { /* best-effort */ }
    const ctl = el.closest('.select__control') || el;
    try { ctl.scrollIntoView({ block: 'center' }); } catch (e) { /* keep measuring */ }
    await new Promise((r) => setTimeout(r, 250));
    const r = ctl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

// ── Legacy scripted-mode helpers (agent mode is required for Greenhouse) ──
function unsupported() {
  return `(() => ({ ok: false, code: 'AGENT_MODE_REQUIRED' }))()`;
}

module.exports = {
  LEVER_HOST: 'job-boards.greenhouse.io',
  GREENHOUSE_HOSTS,
  parseLeverUrl,
  buildIdentityScript,
  buildObserveScript,
  validateAgentAction,
  buildActScript,
  buildSubmitScript,
  buildSubmitControlCheckScript,
  buildCheckpointScript,
  buildConfirmationScript,
  buildComboboxCheckScript,
  buildMenuCheckScript,
  buildControlRectScript,
  buildFillScript: unsupported,
  buildReadBackScript: unsupported,
  buildPlanScript: unsupported,
};
