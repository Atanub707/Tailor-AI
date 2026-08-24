import type { Page } from 'playwright';
import type { ATSAdapter, ApplicationForm, FieldMapping, CandidateProfile, FillResult, UploadResult, ValidationResult, SubmissionResult, ApplicationReceipt, ApplicationDocuments } from '../../types.js';
export const ashbyAdapter: ATSAdapter = {
  id: 'ashby',
  async detect(page: Page): Promise<boolean> { return page.url().includes('ashby'); },
  async inspect(page: Page): Promise<ApplicationForm> { return { ats: 'ashby', url: page.url(), fields: [], hasFileUpload: true, hasCoverLetter: false, customQuestions: [] }; },
  async mapProfile(form: ApplicationForm, profile: CandidateProfile): Promise<FieldMapping[]> { return []; },
  async fill(page: Page, mapping: FieldMapping[]): Promise<FillResult> { return { filled: 0, failed: [] }; },
  async uploadDocuments(page: Page, docs: ApplicationDocuments): Promise<UploadResult> { return { success: true, fileName: docs.resumePath }; },
  async validate(page: Page): Promise<ValidationResult> { return { valid: true, errors: [] }; },
  async submit(page: Page): Promise<SubmissionResult> { return { success: false, error: 'ashby adapter not yet implemented' }; },
  async getReceipt(page: Page): Promise<ApplicationReceipt> { return { applicationId: 'ashby-pending', jobId: page.url(), company: 'unknown', role: 'unknown', ats: 'ashby', submittedAt: new Date().toISOString(), resume: { file: '', hash: '' }, answers: [], fields: [], status: 'needs_review' }; },
};
