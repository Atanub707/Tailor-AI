// Lever provider adapter — implements the common BrowserProviderAdapter.
// Reuses the existing leverPageAdapter semantics (Phase 1/2 verified logic).
import type {
  BrowserProviderAdapter, CompanionProvider, FacadeDocument, FacadeForm,
  ProviderIdentity, ApprovedFieldInput, ValidationVerdict, SubmitObservation,
  FillPlanItem,
} from './browserProviderAdapter.js';
import { validateAgainstPlan, applyValidatedPlan, observeSuccessText } from './browserProviderAdapter.js';

export class LeverProviderAdapter implements BrowserProviderAdapter {
  readonly provider: CompanionProvider = 'lever';

  identifyPage(doc: FacadeDocument, expected: { companySlug: string; postingId: string }): { ok: true; identity: ProviderIdentity } | { ok: false; reason: 'PAGE_IDENTITY_MISMATCH' | 'URL_UNSAFE' } {
    let id: ProviderIdentity | null = null;
    try {
      const u = new URL(doc.url);
      if (u.protocol !== 'https:' || u.hostname !== 'jobs.lever.co') return { ok: false, reason: 'URL_UNSAFE' };
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length < 2) return { ok: false, reason: 'URL_UNSAFE' };
      const isApply = seg[seg.length - 1] === 'apply';
      id = { provider: 'lever', hostname: u.hostname, companySlug: seg[0], postingId: isApply ? seg[seg.length - 2] : seg[seg.length - 1], isApplicationPage: isApply };
    } catch { return { ok: false, reason: 'URL_UNSAFE' }; }
    if (!id.isApplicationPage) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    if (id.companySlug !== expected.companySlug || id.postingId !== expected.postingId) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    if (!doc.form || (doc.form.id && doc.form.id !== 'application-form')) return { ok: false, reason: 'PAGE_IDENTITY_MISMATCH' };
    return { ok: true, identity: id };
  }

  inspectForm(form: FacadeForm) {
    return form.inputs.map((el) => ({
      providerFieldId: el.name, kind: el.type, label: el.name, required: el.required, options: el.options,
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
    const captcha = form.captchaHint === true;
    return { present: captcha, kinds: captcha ? ['CAPTCHA_REQUIRED'] : [] };
  }

  observeSubmission(doc: FacadeDocument): SubmitObservation {
    return observeSuccessText(doc);
  }
}