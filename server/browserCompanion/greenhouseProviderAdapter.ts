// Greenhouse provider adapter — hosted boards (boards.greenhouse.io /
// job-boards.greenhouse.io). Research (2026-08, GET-only): the application
// form is server-rendered inside <form id="application-form">; fields are
// identified by ID (no name attributes): first_name/last_name/email/phone/
// preferred_name/cover_letter/resume + question_{id} custom fields; labels
// via <label for=...> and aria-label; required via `required` + aria-required;
// resume = input#resume (accept .pdf,.doc,.docx,.txt,.rtf); no EEO fields on
// sampled boards; reCAPTCHA possible per board (g-recaptcha-response).
import type {
  BrowserProviderAdapter, CompanionProvider, FacadeDocument, FacadeForm,
  ProviderIdentity, ApprovedFieldInput, ValidationVerdict, SubmitObservation,
  FillPlanItem,
} from './browserProviderAdapter.js';
import { validateAgainstPlan, applyValidatedPlan, observeSuccessText } from './browserProviderAdapter.js';

const UNSUPPORTED_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);

export class GreenhouseProviderAdapter implements BrowserProviderAdapter {
  readonly provider: CompanionProvider = 'greenhouse';

  identifyPage(doc: FacadeDocument, expected: { companySlug: string; postingId: string }): { ok: true; identity: ProviderIdentity } | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' } {
    let u: URL;
    try { u = new URL(doc.url); } catch { return { ok: false, reason: 'URL_UNSAFE' }; }
    if (u.protocol !== 'https:' || (u.hostname !== 'boards.greenhouse.io' && u.hostname !== 'job-boards.greenhouse.io')) {
      return { ok: false, reason: 'URL_UNSAFE' };
    }
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 3 || seg[1] !== 'jobs') return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const id: ProviderIdentity = { provider: 'greenhouse', hostname: u.hostname, companySlug: seg[0], postingId: seg[2], isApplicationPage: true };
    if (id.companySlug !== expected.companySlug || id.postingId !== expected.postingId) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    if (!doc.form || (doc.form.id && doc.form.id !== 'application-form')) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    return { ok: true, identity: id };
  }

  inspectForm(form: FacadeForm) {
    return form.inputs
      .filter((el) => !UNSUPPORTED_TYPES.has(el.type))
      .map((el) => ({ providerFieldId: el.name, kind: el.type, label: el.name, required: el.required, options: el.options }));
  }

  validate(form: FacadeForm, approved: ApprovedFieldInput[]): ValidationVerdict {
    return validateAgainstPlan(form, approved);
  }

  apply(doc: FacadeDocument, plan: FillPlanItem[]) {
    return applyValidatedPlan(doc, plan);
  }

  locateResumeInput(form: FacadeForm): boolean {
    return form.resumePresent === true;
  }

  detectHumanCheckpoint(form: FacadeForm): { present: boolean; kinds: string[] } {
    const captcha = form.captchaHint === true;
    const kinds: string[] = [];
    if (captcha) kinds.push('CAPTCHA_REQUIRED');
    return { present: kinds.length > 0, kinds };
  }

  observeSubmission(doc: FacadeDocument): SubmitObservation {
    return observeSuccessText(doc);
  }
}