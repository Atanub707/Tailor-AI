import type { Page } from 'playwright';
import type {
  ATSAdapter,
  ApplicationForm,
  ApplicationField,
  FieldMapping,
  CandidateProfile,
  FillResult,
  UploadResult,
  ValidationResult,
  SubmissionResult,
  ApplicationReceipt,
  ApplicationDocuments,
} from '../../types.js';

/**
 * Greenhouse adapter — T1 first.
 * URL: https://boards.greenhouse.io/{company}/jobs/{id}
 * Single page, no login, standard file input, 5 question types.
 * See Phase 0 Track A matrix for details.
 */
export const greenhouseAdapter: ATSAdapter = {
  id: 'greenhouse',

  async detect(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('greenhouse.io')) return true;
    // DOM check: Greenhouse has specific form structure
    try {
      const hasForm = await page.evaluate(() => !!document.querySelector('form[action*="greenhouse"], #application_form, [data-qa="application-form"]'));
      return hasForm;
    } catch {
      return false;
    }
  },

  async inspect(page: Page): Promise<ApplicationForm> {
    // Extract all fields — labels + inputs
    const fields: ApplicationField[] = await page.evaluate(() => {
      const out: any[] = [];
      const form = document.querySelector('form') || document.body;
      const inputs = form.querySelectorAll('input, select, textarea');
      inputs.forEach((el: any) => {
        const label = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || el.id || 'unknown';
        const type = el.type || el.tagName.toLowerCase();
        const required = el.required || el.getAttribute('aria-required') === 'true';
        const tag = el.tagName.toLowerCase();
        let fieldType: any = 'unknown';
        if (tag === 'select') fieldType = 'select';
        else if (type === 'email') fieldType = 'email';
        else if (type === 'tel') fieldType = 'tel';
        else if (type === 'file') fieldType = 'file';
        else if (tag === 'textarea') fieldType = 'textarea';
        else if (type === 'radio') fieldType = 'radio';
        else if (type === 'checkbox') fieldType = 'checkbox';
        else fieldType = 'text';

        const options = tag === 'select' ? [...el.options].map((o: any) => o.text) : undefined;

        out.push({
          label: label.trim(),
          name: el.name,
          id: el.id,
          type: fieldType,
          required,
          options,
          selector: el.id ? `#${el.id}` : `[name="${el.name}"]`,
        });
      });
      return out;
    });

    const hasFileUpload = fields.some((f) => f.type === 'file');
    const customQuestions = fields.filter((f) => !['first name', 'last name', 'email', 'phone', 'location'].some((k) => f.label.toLowerCase().includes(k)));

    return {
      ats: 'greenhouse',
      url: page.url(),
      fields,
      hasFileUpload,
      hasCoverLetter: fields.some((f) => f.label.toLowerCase().includes('cover')),
      customQuestions,
    };
  },

  async mapProfile(form: ApplicationForm, profile: CandidateProfile): Promise<FieldMapping[]> {
    const mappings: FieldMapping[] = [];
    const q = (label: string) => label.toLowerCase();

    for (const field of form.fields) {
      const l = q(field.label);
      let value: string | null = null;
      let source: 'profile' | 'llm' = 'profile';

      if (l.includes('first name')) value = profile.identity.firstName;
      else if (l.includes('last name')) value = profile.identity.lastName;
      else if (l.includes('email')) value = profile.identity.email;
      else if (l.includes('phone')) value = profile.identity.phone;
      else if (l.includes('location') || l.includes('city')) value = profile.identity.location;
      else if (l.includes('linkedin')) value = profile.links.linkedin || '';
      else if (l.includes('github')) value = profile.links.github || '';
      else if (l.includes('website') || l.includes('portfolio')) value = profile.links.portfolio || profile.links.website || '';
      else if (l.includes('sponsorship') || l.includes('authorized to work')) {
        value = profile.workAuthorization.requiresSponsorship ? 'No' : 'Yes';
      } else {
        // Unknown question → will be handled by question engine (LLM) later
        // For now mark as needs_review
        continue;
      }

      if (value !== null) {
        mappings.push({ field, value, source, confidence: 1 });
      }
    }
    return mappings;
  },

  async fill(page: Page, mapping: FieldMapping[]): Promise<FillResult> {
    const failed: typeof mapping[0]['field'][] = [];
    let filled = 0;

    for (const m of mapping) {
      try {
        // Use getByLabel for reliability (Greenhouse has proper labels)
        const locator = page.locator(m.field.selector);
        if (m.field.type === 'select' && Array.isArray(m.value)) {
          await locator.selectOption(m.value[0]);
        } else if (m.field.type === 'select') {
          await locator.selectOption(m.value as string);
        } else if (m.field.type === 'checkbox') {
          const vals = Array.isArray(m.value) ? m.value : [m.value as string];
          for (const v of vals) {
            const cb = page.locator(`${m.field.selector}[value="${v}"]`);
            await cb.check().catch(() => locator.check());
          }
        } else if (m.field.type === 'radio') {
          await page.locator(`${m.field.selector}[value="${m.value}"]`).check();
        } else {
          await locator.fill(m.value as string);
        }
        filled++;
        // Human-like delay
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      } catch {
        failed.push(m.field);
      }
    }
    return { filled, failed };
  },

  async uploadDocuments(page: Page, documents: ApplicationDocuments): Promise<UploadResult> {
    try {
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles(documents.resumePath);
      // Wait for upload progress to complete (Greenhouse shows checkmark)
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return { success: true, fileName: documents.resumePath };
    } catch (e: any) {
      return { success: false, fileName: documents.resumePath, error: e.message };
    }
  },

  async validate(page: Page): Promise<ValidationResult> {
    const errors: string[] = await page.evaluate(() => {
      const errs: string[] = [];
      const required = document.querySelectorAll('[required], [aria-required="true"]');
      required.forEach((el: any) => {
        if (!el.value?.trim()) {
          const label = el.labels?.[0]?.innerText || el.name || el.id;
          errs.push(`Required field empty: ${label}`);
        }
      });
      return errs;
    });
    return { valid: errors.length === 0, errors };
  },

  async submit(page: Page): Promise<SubmissionResult> {
    try {
      const btn = page.locator('button:has-text("Submit Application"), button:has-text("Submit"), input[type="submit"]').first();
      await btn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Check for confirmation
      const confirmation = await page.evaluate(() => document.body.innerText.includes('Thank you') || document.body.innerText.includes('submitted'));
      if (confirmation) {
        return { success: true, confirmationText: 'Thank you' };
      }
      return { success: false, error: 'No confirmation found after submit' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  async getReceipt(page: Page): Promise<ApplicationReceipt> {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    const url = page.url();
    return {
      applicationId: `gh-${Date.now()}`,
      jobId: url,
      company: 'unknown',
      role: 'unknown',
      ats: 'greenhouse',
      submittedAt: new Date().toISOString(),
      resume: { file: 'resume.pdf', hash: '' },
      answers: [],
      fields: [],
      confirmationUrl: url,
      status: text.includes('Thank you') ? 'submitted' : 'needs_review',
    };
  },
};
