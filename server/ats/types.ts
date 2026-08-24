import type { Page } from 'playwright';

// ── Candidate Profile — single source of truth, local only ──────────────
// Mirrors §7 of your research. Never invents facts — LLM only transforms.
export interface CandidateProfile {
  identity: {
    firstName: string;
    lastName: string;
    fullName: string;
    email: string;
    phone: string;
    location: string;
  };
  links: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    website?: string;
  };
  workAuthorization: {
    country: string;
    requiresSponsorship: boolean;
    status?: string; // OPT, H-1B, citizen, etc.
  };
  education: Array<{ degree: string; institution: string; dates: string; details?: string }>;
  experience: Array<{ title: string; company: string; location?: string; dates: string; responsibilities: string[] }>;
  skills: Array<{ category: string; items: string[] }>;
  preferences: Record<string, unknown>;
  questions: Record<string, string>; // relocation, salary, noticePeriod, etc.
  truthConstraints: {
    neverInventExperience: boolean;
    neverInventEducation: boolean;
    neverInventEmployment: boolean;
  };
}

// ── Form inspection ─────────────────────────────────────────────────────
export interface ApplicationField {
  label: string;
  name?: string;
  id?: string;
  type: 'text' | 'email' | 'tel' | 'select' | 'radio' | 'checkbox' | 'file' | 'textarea' | 'unknown';
  required: boolean;
  options?: string[];
  selector: string; // Playwright selector to locate it
  rawHtml?: string;
}

export interface ApplicationForm {
  ats: string; // greenhouse | lever | ashby | ...
  url: string;
  fields: ApplicationField[];
  hasFileUpload: boolean;
  hasCoverLetter: boolean;
  customQuestions: ApplicationField[];
}

// ── Mapping & results ───────────────────────────────────────────────────
export interface FieldMapping {
  field: ApplicationField;
  value: string | string[]; // string[] for multi-select/checkbox
  source: 'profile' | 'llm' | 'manual';
  confidence: number; // 0-1
}

export interface FillResult { filled: number; failed: ApplicationField[]; }
export interface UploadResult { success: boolean; fileName: string; error?: string; }
export interface ValidationResult { valid: boolean; errors: string[]; }
export interface SubmissionResult { success: boolean; confirmationUrl?: string; confirmationText?: string; error?: string; }

export interface ApplicationReceipt {
  applicationId: string;
  jobId: string;
  company: string;
  role: string;
  ats: string;
  submittedAt: string;
  resume: { file: string; hash: string };
  coverLetter?: { file: string; hash: string };
  answers: Array<{ question: string; answer: string; source: string }>;
  fields: Array<{ label: string; value: string }>;
  confirmationUrl?: string;
  screenshot?: string; // base64 or file path
  status: 'submitted' | 'draft' | 'needs_review' | 'failed';
}

// ── Documents ───────────────────────────────────────────────────────────
export interface ApplicationDocuments {
  resumePath: string; // local file path to tailored PDF
  coverLetterPath?: string;
}

// ── State machine (§12) ─────────────────────────────────────────────────
export type ApplicationState =
  | 'DISCOVERED' | 'TAILORING' | 'TAILORED'
  | 'OPENING_BROWSER' | 'ATS_DETECTED' | 'FORM_INSPECTED'
  | 'FIELDS_MAPPED' | 'FILLING' | 'DOCUMENT_UPLOADED'
  | 'VALIDATING' | 'NEEDS_REVIEW' | 'READY_TO_SUBMIT'
  | 'SUBMITTING' | 'SUBMITTED' | 'RECEIPT_CAPTURED'
  | 'CAPTCHA_REQUIRED' | 'MFA_REQUIRED' | 'LOGIN_REQUIRED'
  | 'UNKNOWN_QUESTION' | 'UNKNOWN_FIELD' | 'UPLOAD_FAILED'
  | 'ATS_UNSUPPORTED' | 'RATE_LIMITED' | 'NAVIGATION_FAILED' | 'SUBMIT_FAILED';

// ── Core adapter interface (§6) ─────────────────────────────────────────
export interface ATSAdapter {
  /** Unique ATS id, e.g. 'greenhouse' */
  readonly id: string;

  /** Quick URL + DOM check — is this page this ATS? */
  detect(page: Page): Promise<boolean>;

  /** Extract all form fields + custom questions */
  inspect(page: Page): Promise<ApplicationForm>;

  /** Map profile → field values */
  mapProfile(form: ApplicationForm, profile: CandidateProfile): Promise<FieldMapping[]>;

  /** Fill the page using mappings */
  fill(page: Page, mapping: FieldMapping[]): Promise<FillResult>;

  /** Attach resume/cover letter */
  uploadDocuments(page: Page, documents: ApplicationDocuments): Promise<UploadResult>;

  /** Validate required fields before submit */
  validate(page: Page): Promise<ValidationResult>;

  /** Click submit */
  submit(page: Page): Promise<SubmissionResult>;

  /** Capture receipt after submit */
  getReceipt(page: Page): Promise<ApplicationReceipt>;
}

// ── Question ontology (§11) ─────────────────────────────────────────────
export type QuestionCategory =
  | 'PERSONAL' | 'CONTACT' | 'EDUCATION' | 'WORK_AUTHORIZATION'
  | 'SPONSORSHIP' | 'LOCATION' | 'SALARY' | 'EXPERIENCE'
  | 'SKILL' | 'DOMAIN_EXPERIENCE' | 'WHY_COMPANY' | 'WHY_ROLE'
  | 'NOTICE_PERIOD' | 'AVAILABILITY' | 'DEMOGRAPHIC' | 'LEGAL' | 'UNKNOWN';
