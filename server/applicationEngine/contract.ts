import { createHash } from 'node:crypto';
// Application Engine V1 — Phase 0 provider-neutral contracts.
// COMPILE-ONLY DESIGN: no operational adapters, no network submission code.

export type Provider = 'greenhouse' | 'lever' | 'ashby' | 'unknown';

export type RedirectKind = 'SUPPORTED_TARGET' | 'REDIRECTED_SUPPORTED_TARGET' | 'UNSUPPORTED_TARGET' | 'MANUAL_ONLY';

export interface ApplicationTarget {
  provider: Provider;
  externalJobId: string;
  applyUrl: string;
  jobUrl?: string;
  company: string;
  title: string;
  hostname: string;
  redirectKind: RedirectKind;
  detectionConfidence?: DetectionResult['confidence'];
  detectionReason?: string;
  targetClassification?: RedirectKind;
}

export interface DetectionResult {
  provider: Provider;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export type FieldType =
  | 'TEXT' | 'TEXTAREA' | 'EMAIL' | 'PHONE' | 'URL' | 'BOOLEAN' | 'NUMBER' | 'DATE'
  | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'FILE' | 'CONSENT' | 'UNKNOWN';

export type FieldCategory =
  | 'IDENTITY' | 'CONTACT' | 'LOCATION' | 'WORK_AUTHORIZATION' | 'SPONSORSHIP' | 'COMPENSATION'
  | 'EXPERIENCE' | 'EDUCATION' | 'RESUME' | 'COVER_LETTER' | 'CUSTOM' | 'CONSENT' | 'EEO' | 'UNKNOWN';

export interface ApplicationField {
  providerFieldId: string;
  normalizedKey?: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  category: FieldCategory;
}

export interface ApplicationRequirements {
  provider: Provider;
  target: ApplicationTarget;
  fields: ApplicationField[];
  discoveredAt: string;
  fingerprint: string;
}

export type MappingMethod = 'EXACT' | 'ALIAS' | 'DETERMINISTIC' | 'USER' | 'AI_SUGGESTED';

export interface MappedField {
  providerFieldId: string;
  canonicalKey?: string;
  label: string;
  type: FieldType;
  required: boolean;
  value?: string | number | boolean | string[] | null;
  source: string;
  mappingConfidence: 'high' | 'medium' | 'low';
  mappingMethod: MappingMethod;
}

export type PlanStatus = 'INSPECTING' | 'NEEDS_INPUT' | 'NEEDS_REVIEW' | 'READY_TO_SUBMIT' | 'UNSUPPORTED';

export interface SubmissionPlan {
  id: string;
  userId: string;
  packageId: string;
  packageSnapshotHash: string;
  provider: Provider;
  target: ApplicationTarget;
  requirementsFingerprint: string;
  mappedFields: MappedField[];
  files: Array<{ kind: 'RESUME' | 'COVER_LETTER' | 'OTHER'; artifactSha?: string }>;
  unresolvedFields: string[];
  unresolvedDetails: Array<{ providerFieldId: string; label: string; required: boolean; reason: string }>;
  consentFields: Array<{ providerFieldId: string; label: string; required: boolean; status: 'REQUIRES_REVIEW' }>;
  manualFields: Array<{ providerFieldId: string; label: string; required: boolean; reason: string }>;
  status: PlanStatus;
  planFingerprint: string;
  inspection?: { adapter: string; version: string; inspectedAt: string; url: string };
  createdAt: string;
  updatedAt: string;
}

export interface PlanValidation {
  status: PlanStatus;
  reviewReasons: string[];
  unresolvedRequired: string[];
  errors: string[];
}

export type ConsentKind = 'INFORMATIONAL' | 'REQUIRED_ACKNOWLEDGEMENT' | 'LEGAL_CONSENT' | 'UNKNOWN';
export type EeoPolicy = 'ASK_USER' | 'DECLINE_TO_ANSWER' | 'MANUAL_ONLY';
export type FailureKind =
  | 'VALIDATION_FAILED' | 'MISSING_REQUIRED_FIELD' | 'REVIEW_REQUIRED' | 'AUTH_REQUIRED'
  | 'CAPTCHA_REQUIRED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'FORM_CHANGED'
  | 'UNSUPPORTED_FIELD' | 'UPLOAD_FAILED' | 'SUBMISSION_REJECTED' | 'SUCCESS_UNCONFIRMED'
  | 'DUPLICATE_APPLICATION' | 'MANUAL_ACTION_REQUIRED' | 'UNKNOWN';

// ── Deterministic helpers (pure; testable) ──────────────────────────────

const HOST_PROVIDERS: Array<{ host: string; provider: Provider }> = [
  { host: 'boards.greenhouse.io', provider: 'greenhouse' },
  { host: 'job-boards.greenhouse.io', provider: 'greenhouse' },
  { host: 'jobs.lever.co', provider: 'lever' },
  { host: 'jobs.ashbyhq.com', provider: 'ashby' },
];

/** Provider detection from hostname + platform signal (confidence-aware). */
export function detectProvider(platform: string | undefined, applyUrl: string | undefined, jobUrl: string | undefined): DetectionResult {
  const hosts = [applyUrl, jobUrl].filter(Boolean).map((u) => String(u).replace(/^https?:\/\//, '').split('/')[0].toLowerCase());
  const hostHits = hosts.map((h) => HOST_PROVIDERS.find((x) => h === x.host || h.endsWith('.' + x.host) || h === x.host.replace(/^www\./, ''))?.provider).filter(Boolean);
  const hostProvider = hostHits[0];
  const platformProvider = (['greenhouse', 'lever', 'ashby'] as const).find((p) => platform?.toLowerCase() === p);
  if (hostProvider && platformProvider && hostProvider === platformProvider) {
    return { provider: hostProvider, confidence: 'high', reason: `host+platform agree on ${hostProvider}` };
  }
  if (hostProvider) {
    return { provider: hostProvider, confidence: platformProvider ? 'medium' : 'high', reason: `hostname signals ${hostProvider}${platformProvider ? ` (platform disagrees: ${platformProvider})` : ''}` };
  }
  if (platformProvider) {
    return { provider: platformProvider, confidence: 'low', reason: `platform signal only (${platformProvider}) — hostname unrecognized; possible redirect target` };
  }
  return { provider: 'unknown', confidence: 'low', reason: 'no provider signal' };
}

/** Redirect classification: does the apply target belong to a supported provider? */
export function classifyTarget(applyUrl: string | undefined, platformProvider: Provider | undefined): RedirectKind {
  const host = String(applyUrl || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  const hostProvider = HOST_PROVIDERS.find((x) => host === x.host || host.endsWith('.' + x.host))?.provider;
  if (!applyUrl) return 'MANUAL_ONLY';
  // Known target host belonging to a DIFFERENT provider than the index
  // platform → redirected to another supported family (never forced).
  if (hostProvider && platformProvider && hostProvider !== platformProvider) return 'REDIRECTED_SUPPORTED_TARGET';
  if (hostProvider) return 'SUPPORTED_TARGET';
  // no platform signal at all → nothing to redirect FROM
  if (platformProvider === undefined || platformProvider === 'unknown') return 'UNSUPPORTED_TARGET';
  // an ATS-indexed job whose applyUrl leaves the ATS family
  return 'REDIRECTED_SUPPORTED_TARGET';
}

// ── Field normalization ladder (exact → alias → deterministic) ──────────

const FIELD_ALIASES: Array<{ aliases: string[]; canonical: string }> = [
  { aliases: ['name'], canonical: 'fullName' },
  { aliases: ['first name', 'given name', 'firstname'], canonical: 'firstName' },
  { aliases: ['last name', 'family name', 'surname', 'lastname'], canonical: 'lastName' },
  { aliases: ['email', 'email address', 'e-mail', 'email address *'], canonical: 'email' },
  { aliases: ['phone', 'phone number', 'telephone', 'mobile number'], canonical: 'phone' },
  { aliases: ['current city', 'city'], canonical: 'currentCity' },
  { aliases: ['country', 'current country'], canonical: 'currentCountry' },
  { aliases: ['linkedin url', 'linkedin profile url', 'linkedin'], canonical: 'linkedinUrl' },
  { aliases: ['github url', 'github'], canonical: 'githubUrl' },
  { aliases: ['portfolio url', 'portfolio'], canonical: 'portfolioUrl' },
  { aliases: ['website', 'personal website', 'website url'], canonical: 'websiteUrl' },
  { aliases: ['are you legally authorized to work in', 'work authorization', 'authorized to work', 'work eligibility', 'work permit'], canonical: 'authorizedToWork' },
  { aliases: ['will you now or in the future require sponsorship', 'requires sponsorship', 'visa sponsorship', 'do you require sponsorship'], canonical: 'requiresSponsorship' },
  { aliases: ['notice period'], canonical: 'noticePeriod' },
  { aliases: ['expected salary', 'salary expectation', 'salary requirements', 'desired salary'], canonical: 'expectedSalary' },
  { aliases: ['resume', 'resume/cv', 'cv', 'upload resume'], canonical: 'resume' },
  { aliases: ['cover letter'], canonical: 'coverLetter' },
];

export function normalizeFieldLabel(label: string): string | undefined {
  const l = String(label || '').toLowerCase().trim().replace(/\s+/g, ' ');
  for (const entry of FIELD_ALIASES) {
    if (entry.aliases.some((a) => l === a || l.startsWith(a) || (a.length > 8 && l.includes(a)))) return entry.canonical;
  }
  if (/\bresume\b/.test(l)) return 'resume';
  if (/\bcover letter\b/.test(l)) return 'coverLetter';
  return undefined;
}

export type FieldConsentKind = ConsentKind;

/** Conservative consent classification — legal phrases never auto-accepted. */
export function classifyConsent(label: string): ConsentKind {
  const l = String(label || '').toLowerCase();
  if (/(privacy policy|terms of use|terms and conditions|candidate agreement|background check|data processing|consent to)/.test(l)) return 'LEGAL_CONSENT';
  if (/(acknowledg|confirm|declare|verify your information)/.test(l)) return 'REQUIRED_ACKNOWLEDGEMENT';
  if (/(information about|learn more|privacy notice)/.test(l)) return 'INFORMATIONAL';
  return 'UNKNOWN';
}

/** Conservative EEO classification — never inferred, never auto-filled. */
export function classifyEeo(label: string): FieldCategory {
  const l = String(label || '').toLowerCase();
  if (/(gender|race|ethnicity|veteran|disability|sexual orientation|demographic)/.test(l)) return 'EEO';
  if (/(work authorization|authorized to work|sponsorship|work eligibility)/.test(l)) return 'WORK_AUTHORIZATION';
  return 'UNKNOWN';
}

export function requirementsFingerprint(provider: Provider, targetHost: string, fields: ApplicationField[]): string {
  const hasher = createHash;
  const stable = JSON.stringify({
    provider,
    host: targetHost,
    fields: fields.map((f) => [f.providerFieldId, f.type, f.required, f.normalizedKey ?? '', String(f.options ?? [])].join('|')),
  });
  return hasher('sha256').update(stable).digest('hex').slice(0, 24);
}