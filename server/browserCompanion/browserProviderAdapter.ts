// Multi-provider Browser Companion — common provider contract + router.
// Every provider adapter implements the SAME two-pass safety contract:
// PASS 1 read-only validation → PASS 2 mutation (only on ok). Provider
// DOM logic stays inside adapters; nothing provider-specific leaks into
// the engine/session/dashboard/events.

export type CompanionProvider = 'lever' | 'greenhouse' | 'ashby';

export interface FacadeInputElement {
  name: string;          // provider field identity (Lever: name attr; Greenhouse: id; Ashby: name/id)
  type: string;
  value: string;
  required: boolean;
  options: string[];     // for select/radio/checkbox groups
  checked?: boolean;
  tagName: string;
}

export interface FacadeForm {
  id?: string;
  enctype?: string;
  inputs: FacadeInputElement[];
  captchaHint?: boolean;
  resumePresent?: boolean;
}

export interface FacadeDocument {
  url: string;
  form: FacadeForm | null;
  pageText?: string;
}

export interface ProviderIdentity {
  provider: CompanionProvider;
  hostname: string;
  companySlug: string;
  postingId: string;
  isApplicationPage: boolean;
}

export interface ApprovedFieldInput {
  providerFieldId: string;
  type: string;
  approvedValue: string | string[] | boolean;
  required: boolean;
}

export interface FillPlanItem { providerFieldId: string; kind: string; value: string | string[] | boolean }

export type ValidationVerdict =
  | { ok: true; plan: FillPlanItem[]; resumePresent: boolean; checkpoint: { captchaPresent: boolean; loginRequired: boolean; mfaRequired: boolean; unsupportedRequired: boolean } }
  | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'FIELD_MISSING' | 'OPTION_CHANGED' | 'UNKNOWN_REQUIRED' | 'RESUME_CONTROL_MISSING'; failures: string[] };

export interface SubmitObservation {
  classification: 'CONFIRMED' | 'UNCONFIRMED' | 'FAILED' | 'STILL_ON_FORM' | 'IDENTITY_CHANGED';
  evidenceType?: string;
  confirmationFingerprint?: string;
  failureCategory?: string;
}

/** Provider-independent two-pass validator shared by all adapters.
 *  PASS 1: read-only full validation; ANY mismatch → zero mutations. */
export function validateAgainstPlan(form: FacadeForm, approved: ApprovedFieldInput[]): ValidationVerdict {
  const failures: string[] = [];
  const byId = new Map(form.inputs.map((f) => [f.name, f]));
  const plan: FillPlanItem[] = [];
  for (const a of approved) {
    const f = byId.get(a.providerFieldId);
    if (!f) {
      if (a.required) failures.push(`missing:${a.providerFieldId}`);
      continue;
    }
    if (['select', 'radio', 'checkbox'].includes(f.type) && f.options.length && !f.options.includes(String(a.approvedValue))) {
      failures.push(`option:${a.providerFieldId}`);
      continue;
    }
    plan.push({ providerFieldId: a.providerFieldId, kind: f.type, value: a.approvedValue });
  }
  // REVERSE pass: required controls without an approved value → unknown required.
  const approvedIds = new Set(approved.map((a) => a.providerFieldId));
  for (const f of form.inputs) {
    if (f.required && !approvedIds.has(f.name) && f.name !== 'resume' && !['checkbox', 'radio'].includes(f.type)) {
      failures.push(`unsupported:${f.name}`);
    }
  }
  const resumePresent = form.resumePresent === true;
  if (!resumePresent) failures.push('resume-control-missing');
  const captcha = form.captchaHint === true;
  const checkpoint = {
    captchaPresent: captcha,
    loginRequired: /login|sign in|signin/i.test(form.id ?? ''),
    mfaRequired: false,
    unsupportedRequired: failures.some((f) => f.startsWith('unsupported:')),
  };
  if (failures.length > 0) {
    const reason = failures[0].startsWith('option:') ? 'OPTION_CHANGED' : failures[0].startsWith('unsupported:') ? 'UNKNOWN_REQUIRED' : failures[0].startsWith('resume-control') ? 'RESUME_CONTROL_MISSING' : 'FIELD_MISSING';
    return { ok: false, reason, failures };
  }
  return { ok: true, plan, resumePresent, checkpoint };
}

/** PASS 2 — mutation; only called after validateAgainstPlan returned ok. */
export function applyValidatedPlan(doc: FacadeDocument, plan: FillPlanItem[]): { applied: number; submitClicked: false } {
  let applied = 0;
  for (const item of plan) {
    const el = doc.form?.inputs.find((i) => i.name === item.providerFieldId);
    if (!el) continue;
    if (typeof item.value === 'boolean') el.checked = item.value;
    else el.value = Array.isArray(item.value) ? item.value.join(',') : item.value;
    applied += 1;
  }
  return { applied, submitClicked: false };
}

export interface BrowserProviderAdapter {
  provider: CompanionProvider;
  identifyPage(doc: FacadeDocument, expected: { companySlug: string; postingId: string }): { ok: true; identity: ProviderIdentity } | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' };
  inspectForm(form: FacadeForm): Array<{ providerFieldId: string; kind: string; label: string; required: boolean; options: string[] }>;
  validate(form: FacadeForm, approved: ApprovedFieldInput[]): ValidationVerdict;
  apply(doc: FacadeDocument, plan: FillPlanItem[]): { applied: number; submitClicked: false };
  locateResumeInput(form: FacadeForm): boolean;
  detectHumanCheckpoint(form: FacadeForm): { present: boolean; kinds: string[] };
  observeSubmission(doc: FacadeDocument): SubmitObservation;
}

const SUCCESS_MARKERS: Array<{ marker: RegExp; type: string }> = [
  { marker: /application\s+has been submitted|application.?submitted|thank you.*application|application received|successfully applied|we.?ve received your application/i, type: 'SUCCESS_TEXT' },
];

export function observeSuccessText(doc: FacadeDocument): SubmitObservation {
  const text = String(doc.url + ' ' + (doc.pageText ?? ''));
  for (const { marker, type } of SUCCESS_MARKERS) {
    if (marker.test(text)) {
      const m = text.match(marker);
      return { classification: 'CONFIRMED', evidenceType: type, confirmationFingerprint: String(m?.[0] || 'confirmed').slice(0, 64) };
    }
  }
  if (/error|invalid|failed/i.test(text)) return { classification: 'FAILED', failureCategory: 'UNKNOWN_ERROR' };
  if (doc.form) return { classification: 'STILL_ON_FORM' };
  return { classification: 'UNCONFIRMED', evidenceType: 'NO_POSITIVE_EVIDENCE' };
}

// ── Router: authoritative provider metadata → adapter (never page text) ──

import { LeverProviderAdapter } from './leverProviderAdapter.js';
import { GreenhouseProviderAdapter } from './greenhouseProviderAdapter.js';
import { AshbyProviderAdapter } from './ashbyProviderAdapter.js';

export function resolveProviderAdapter(provider: string): BrowserProviderAdapter {
  switch (provider) {
    case 'lever': return new LeverProviderAdapter();
    case 'greenhouse': return new GreenhouseProviderAdapter();
    case 'ashby': return new AshbyProviderAdapter();
    default:
      throw new Error(`UNSUPPORTED_PROVIDER:${provider}`);
  }
}

/** Canonical application URL validation per provider (allowlisted,
 *  https-only, posting identity enforced). Provider-agnostic version of the
 *  former verifiedLeverActionUrl. */
export function verifiedProviderActionUrl(provider: string, applyUrl: string | undefined, externalJobId?: string): string | null {
  if (!applyUrl) return null;
  let u: URL;
  try { u = new URL(applyUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  const normalizedExternal = String(externalJobId || '').replace(/^(lev|gh|ashby)-/, '');
  if (provider === 'lever') {
    if (u.hostname !== 'jobs.lever.co') return null;
    if (seg.length < 2) return null;
    if (seg[seg.length - 1] !== 'apply') {
      if (seg.length !== 2) return null;
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/apply`;
    }
    const urlJobId = seg[seg.length - 2];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  if (provider === 'greenhouse') {
    if (u.hostname !== 'boards.greenhouse.io' && u.hostname !== 'job-boards.greenhouse.io') return null;
    if (seg.length < 3 || seg[1] !== 'jobs') return null;
    const urlJobId = seg[2];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  if (provider === 'ashby') {
    if (u.hostname !== 'jobs.ashbyhq.com') return null;
    if (seg.length < 3 || seg[2] !== 'application') return null;
    const urlJobId = seg[1];
    if (normalizedExternal && urlJobId !== normalizedExternal) return null;
    return u.toString();
  }
  return null;
}