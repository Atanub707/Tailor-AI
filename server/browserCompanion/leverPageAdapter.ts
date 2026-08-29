// Browser Companion Phase 1 — Lever page adapter (canonical logic).
// Operates on a narrow DOM facade so it is unit-testable with synthetic
// pages; the extension content script implements the same facade against the
// real document. ISOLATED world, top frame only. No submit, no CAPTCHA
// interaction, no resume.

export interface FacadeInputElement {
  name: string;
  type: string;
  value: string;
  required: boolean;
  options: string[];          // for select/radio/checkbox group
  checked?: boolean;
  tagName: string;
}

export interface FacadeForm {
  id?: string;
  enctype?: string;
  inputs: FacadeInputElement[];
  /** Structural CAPTCHA evidence (widget/sitekey/response-input presence) —
   *  set by the caller from the real page; never manipulated. */
  captchaHint?: boolean;
}

export interface FacadeDocument {
  url: string;
  form: FacadeForm | null;
}

export interface LeverIdentity {
  hostname: string;
  siteSlug: string;
  postingId: string;
  isApplyPage: boolean;
}

export function parseLeverIdentity(url: string): LeverIdentity | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'jobs.lever.co') return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    const isApply = seg[seg.length - 1] === 'apply';
    const postingId = isApply ? seg[seg.length - 2] : seg[seg.length - 1];
    return { hostname: u.hostname, siteSlug: seg[0], postingId, isApplyPage: isApply };
  } catch {
    return null;
  }
}

export type PageVerification =
  | { ok: true; identity: LeverIdentity; formPresent: boolean }
  | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' };

/** BEFORE ANY FILL: protocol/host/slug/posting/form checks. */
export function verifyPage(doc: FacadeDocument, expected: { siteSlug: string; postingId: string }): PageVerification {
  const identity = parseLeverIdentity(doc.url);
  if (!identity) return { ok: false, reason: 'URL_UNSAFE' };
  if (!identity.isApplyPage) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
  if (identity.siteSlug !== expected.siteSlug) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
  if (identity.postingId !== expected.postingId) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
  const form = doc.form;
  if (!form || (form.id && form.id !== 'application-form')) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
  return { ok: true, identity, formPresent: true };
}

export interface NormalizedFormField {
  providerFieldId: string;
  kind: 'TEXT' | 'TEXTAREA' | 'EMAIL' | 'TEL' | 'SELECT' | 'RADIO' | 'CHECKBOX' | 'UNSUPPORTED';
  label: string;
  required: boolean;
  options: string[];
}

const UNSUPPORTED_TYPES = new Set(['file', 'password', 'hidden', 'submit', 'button', 'image', 'reset']);

export function inspectForm(form: FacadeForm): NormalizedFormField[] {
  const fields: NormalizedFormField[] = [];
  for (const el of form.inputs) {
    const t = el.type.toLowerCase();
    if (UNSUPPORTED_TYPES.has(t)) continue; // file/password/hidden never exposed
    let kind: NormalizedFormField['kind'];
    if (el.tagName === 'TEXTAREA') kind = 'TEXTAREA';
    else if (t === 'email') kind = 'EMAIL';
    else if (t === 'tel') kind = 'TEL';
    else if (t === 'select') kind = 'SELECT';
    else if (t === 'radio') kind = 'RADIO';
    else if (t === 'checkbox') kind = 'CHECKBOX';
    else if (t === 'text') kind = 'TEXT';
    else kind = 'UNSUPPORTED';
    fields.push({ providerFieldId: el.name, kind, label: el.name, required: el.required, options: el.options });
  }
  return fields;
}

export function detectCaptcha(form: FacadeForm): boolean {
  return form.captchaHint === true;
}

export type FillPlanItem = { providerFieldId: string; kind: NormalizedFormField['kind']; value: string | string[] | boolean };
export type FillPlan = { ok: true; items: FillPlanItem[] } | { ok: false; reason: 'FORM_CHANGED' | 'FIELD_MISSING' | 'OPTION_CHANGED' | 'UNKNOWN_REQUIRED' | 'CONSENT_MISMATCH' | 'EEO_REQUIRED' };

const SKIP_FILL = new Set(['consent', 'eeo', 'unknown']);

/** Build a fill plan from CURRENT form + APPROVED values. The current DOM is
 *  the transport authority; the approval is the value authority. Any
 *  material mismatch → STOP that application. */
export function planFill(form: FacadeForm, approved: Array<{ providerFieldId: string; type: string; approvedValue: string | string[] | boolean; required: boolean }>): FillPlan {
  const current = inspectForm(form);
  const byId = new Map(current.map((f) => [f.providerFieldId, f]));
  const items: FillPlanItem[] = [];
  for (const a of approved) {
    const f = byId.get(a.providerFieldId);
    if (!f) {
      if (a.required) return { ok: false, reason: 'FIELD_MISSING' };
      continue; // optional approved field absent → skip silently
    }
    if (f.kind === 'UNSUPPORTED') {
      if (a.required) return { ok: false, reason: 'UNKNOWN_REQUIRED' };
      continue;
    }
    const value = a.approvedValue;
    if (f.kind === 'SELECT' || f.kind === 'RADIO') {
      const v = String(value);
      if (f.options.length && !f.options.includes(v)) return { ok: false, reason: 'OPTION_CHANGED' };
      items.push({ providerFieldId: a.providerFieldId, kind: f.kind, value: v });
      continue;
    }
    if (f.kind === 'CHECKBOX') {
      // Consent/EEO never auto-filled here (the approval already contains
      // only explicitly approved decisions; the plan only passes exact
      // approved booleans — no inference, no marketing default).
      items.push({ providerFieldId: a.providerFieldId, kind: f.kind, value });
      continue;
    }
    items.push({ providerFieldId: a.providerFieldId, kind: f.kind, value: value });
  }
  return { ok: true, items };
}

/** Simulate the approved fill on a facade (test surface for the extension's
 *  real DOM implementation; returns the resulting input values). */
export function applyFill(doc: FacadeDocument, plan: FillPlan): { applied: number; submitClicked: boolean } {
  if (!plan.ok) return { applied: 0, submitClicked: false };
  let applied = 0;
  for (const item of plan.items) {
    const el = doc.form?.inputs.find((i) => i.name === item.providerFieldId);
    if (!el) continue;
    if (typeof item.value === 'boolean') el.checked = item.value;
    else el.value = Array.isArray(item.value) ? item.value.join(',') : item.value;
    applied += 1;
  }
  return { applied, submitClicked: false }; // the adapter NEVER clicks submit
}