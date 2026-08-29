// Ashby provider adapter — SPA boards (jobs.ashbyhq.com). Research
// (2026-08, GET + rendered-DOM read-only): application renders client-side;
// system fields _systemfield_name/_systemfield_email/_systemfield_resume;
// custom questions keyed by question UUID (name=id={uuid}); radio groups
// share the UUID name with {uuid}_{optionId} ids; labels rendered as text;
// reCAPTCHA possible (g-recaptcha-response textarea). The CURRENT DOM is
// the transport authority — every mutation is preceded by full read-only
// revalidation (SPA rerenders invalidate stale plans).
import type {
  BrowserProviderAdapter, CompanionProvider, FacadeDocument, FacadeForm,
  ProviderIdentity, ApprovedFieldInput, ValidationVerdict, SubmitObservation,
  FillPlanItem,
} from './browserProviderAdapter.js';
import { validateAgainstPlan, applyValidatedPlan, observeSuccessText } from './browserProviderAdapter.js';

const SYSTEM_FIELDS: Record<string, string> = {
  _systemfield_name: 'Full Name',
  _systemfield_email: 'Email',
  _systemfield_phone: 'Phone',
  _systemfield_location: 'Location',
  _systemfield_company: 'Company',
  _systemfield_linkedin: 'LinkedIn',
  _systemfield_github: 'GitHub',
  _systemfield_website: 'Website',
  _systemfield_other: 'Other URL',
};

export class AshbyProviderAdapter implements BrowserProviderAdapter {
  readonly provider: CompanionProvider = 'ashby';

  identifyPage(doc: FacadeDocument, expected: { companySlug: string; postingId: string }): { ok: true; identity: ProviderIdentity } | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' } {
    let u: URL;
    try { u = new URL(doc.url); } catch { return { ok: false, reason: 'URL_UNSAFE' }; }
    if (u.protocol !== 'https:' || u.hostname !== 'jobs.ashbyhq.com') return { ok: false, reason: 'URL_UNSAFE' };
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 3 || seg[2] !== 'application') return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    const id: ProviderIdentity = { provider: 'ashby', hostname: u.hostname, companySlug: seg[0], postingId: seg[1], isApplicationPage: true };
    if (id.companySlug !== expected.companySlug || id.postingId !== expected.postingId) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    return { ok: true, identity: id };
  }

  inspectForm(form: FacadeForm) {
    return form.inputs.map((el) => ({
      providerFieldId: el.name,
      kind: el.type === 'textarea' ? 'TEXTAREA' : el.type,
      label: SYSTEM_FIELDS[el.name] ?? el.name,
      required: el.required,
      options: el.options,
    }));
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
    const captcha = form.captchaHint === true; // g-recaptcha-response present
    return { present: captcha, kinds: captcha ? ['CAPTCHA_REQUIRED'] : [] };
  }

  observeSubmission(doc: FacadeDocument): SubmitObservation {
    return observeSuccessText(doc);
  }
}