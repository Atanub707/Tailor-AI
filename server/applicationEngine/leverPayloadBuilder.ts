// Lever multipart payload builder — LOCAL DRY-RUN ONLY. Builds the exact
// normalized multipart representation Tailor AI WOULD send. Zero network.
import { sha256 } from './contract.js';
import { classifyConsent } from './executionContract.js';
import type {
  MultipartPayload, MultipartTextPart, MultipartFilePart,
  TransportClassification, ConsentClassification,
} from './executionContract.js';
import type { SubmissionPlan } from './contract.js';
import type { ApplicationRequirements } from './contract.js';

export interface PayloadInput {
  plan: SubmissionPlan;
  targetUrl: string;
  requirements: ApplicationRequirements; // FRESH inspection
  resume: { filename: string; mimeType: string; size: number; sha256: string; artifactReference: string };
  transport: Record<string, string>; // volatile context (accountId/timezone/baseTemplate...)
  marketingOptIn: boolean;            // explicit user choice only
  consentSelections: Record<string, boolean | string>; // approved consent choices (user-explicit)
  omitTracking: boolean;              // Phase-1 default: true
}

const TRACKING_NAMES = ['origin', 'referer', 'source', 'socialReferralKey', 'socialSource'];

function classifyTransport(name: string): TransportClassification {
  if (TRACKING_NAMES.includes(name)) return 'TRACKING';
  if (name === 'accountId' || name === 'timezone' || name === 'selectedLocation' || name.includes('baseTemplate')) return 'REQUIRED';
  return 'OPTIONAL';
}

const STANDARD_NAMES: Array<{ name: string; canonical: string }> = [
  { name: 'name', canonical: 'fullName' },
  { name: 'email', canonical: 'email' },
  { name: 'phone', canonical: 'phone' },
  { name: 'location', canonical: 'currentCity' },
  { name: 'org', canonical: 'currentCompany' },
  { name: 'urls[LinkedIn]', canonical: 'linkedinUrl' },
  { name: 'urls[GitHub]', canonical: 'githubUrl' },
  { name: 'urls[Portfolio]', canonical: 'portfolioUrl' },
  { name: 'urls[Other]', canonical: 'websiteUrl' },
];

export class PayloadBuildError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'PayloadBuildError';
  }
}

/** Deterministic semantic fingerprint of the payload (excludes multipart
 *  boundary, timestamps, cookies, tokens, deliberately-omitted tracking). */
export function payloadFingerprint(payload: MultipartPayload): string {
  const semantic = payload.parts
    .filter((p) => p.kind !== 'TEXT' || p.semantic)
    .map((p) =>
      p.kind === 'TEXT'
        ? `T:${p.name}=${p.value}`
        : `F:${p.name}:${p.filename}:${p.mimeType}:${p.size}:${p.sha256}`,
    )
    .sort();
  return sha256([payload.target, payload.method, ...semantic, `captcha=${payload.captcha.present}`].join('|'));
}

function optionValid(selected: string, options: string[] | undefined): boolean {
  if (!options?.length) return true;
  return options.includes(selected);
}

/** Builds the LOCAL normalized payload. Throws PayloadBuildError on any
 *  invalid state — never returns an executable payload for invalid input. */
export function buildLeverPayload(input: PayloadInput): MultipartPayload {
  const { plan, requirements, resume } = input;
  const parts: (MultipartTextPart | MultipartFilePart)[] = [];
  const omittedTracking: string[] = [];
  const mappedByProvider = new Map(plan.mappedFields.map((m) => [m.providerFieldId, m]));

  // Standard fields — only if present in the CURRENT form requirements.
  for (const s of STANDARD_NAMES) {
    const field = requirements.fields.find((f) => f.providerFieldId === s.name);
    if (!field) continue;
    const mapped = mappedByProvider.get(s.name);
    if (!mapped) {
      if (field.required) throw new PayloadBuildError('VALIDATION_FAILED', `Required field ${s.name} has no mapped answer.`);
      continue; // optional unanswered → omit
    }
    const value = String(mapped.value ?? '').trim();
    if (value === '') {
      if (field.required) throw new PayloadBuildError('VALIDATION_FAILED', `Required field ${s.name} is empty.`);
      continue;
    }
    parts.push({ kind: 'TEXT', name: s.name, value, classification: 'REQUIRED', semantic: true });
  }

  // Custom questions (cards) — from the FRESH form field ids only.
  for (const f of requirements.fields) {
    if (!f.providerFieldId.startsWith('cards[')) continue;
    if (f.providerFieldId.endsWith('baseTemplate]')) continue;
    if (f.category === 'CONSENT') continue;
    if (f.category === 'EEO') continue;
    const mapped = mappedByProvider.get(f.providerFieldId);
    if (!mapped) {
      if (f.required) throw new PayloadBuildError('VALIDATION_FAILED', `Required question ${f.label} unanswered.`);
      continue; // optional unanswered → omit
    }
    const v = mapped.value;
    if (Array.isArray(v)) {
      // MULTI_SELECT → repeated key, deterministic order (provider order).
      if (f.required && v.length === 0) throw new PayloadBuildError('VALIDATION_FAILED', `Required multi-select ${f.label} empty.`);
      for (const item of v) {
        const text = String(item);
        if (!optionValid(text, f.options)) throw new PayloadBuildError('VALIDATION_FAILED', `Option "${text}" not valid for ${f.label}.`);
        parts.push({ kind: 'TEXT', name: f.providerFieldId, value: text, classification: 'REQUIRED', semantic: true });
      }
      continue;
    }
    if (typeof v === 'boolean') {
      const text = v ? 'Yes' : 'No';
      if (!optionValid(text, f.options)) throw new PayloadBuildError('VALIDATION_FAILED', `Boolean value "${text}" not valid for ${f.label}.`);
      parts.push({ kind: 'TEXT', name: f.providerFieldId, value: text, classification: 'REQUIRED', semantic: true });
      continue;
    }
    const text = String(v);
    if (!optionValid(text, f.options)) throw new PayloadBuildError('VALIDATION_FAILED', `Value "${text}" not valid for ${f.label}.`);
    parts.push({ kind: 'TEXT', name: f.providerFieldId, value: text, classification: 'REQUIRED', semantic: true });
  }

  // Consent: marketing opt-in only with an EXPLICIT user choice; legal/unknown
  // consent blocks unless approved with the exact text hash.
  for (const c of plan.consentFields) {
    if (c.classification === 'OPTIONAL_MARKETING' || c.classification === 'OPTIONAL_COMMUNICATION') {
      const chosen = input.marketingOptIn;
      if (chosen) {
        parts.push({ kind: 'TEXT', name: c.providerFieldId, value: '1', classification: 'OPTIONAL', semantic: true });
      }
      continue; // default: omitted — never auto opt-in
    }
    // LEGAL_CONSENT / REQUIRED_ACKNOWLEDGEMENT / UNKNOWN_CONSENT
    const selection = input.consentSelections[c.providerFieldId];
    if (selection === undefined || selection === false) {
      throw new PayloadBuildError('CONSENT_REQUIRED', `Consent ${c.label} requires explicit user approval.`);
    }
    parts.push({ kind: 'TEXT', name: c.providerFieldId, value: String(selection), classification: 'REQUIRED', semantic: true });
  }

  // Resume — exact immutable package PDF artifact.
  const resumeField = requirements.fields.find((f) => f.providerFieldId === 'resume');
  if (resumeField && resumeField.required) {
    parts.push({
      kind: 'FILE', name: 'resume', filename: resume.filename, mimeType: resume.mimeType,
      size: resume.size, sha256: resume.sha256, artifactReference: resume.artifactReference,
    });
  }

  // Transport metadata (opaque, from the fresh context).
  for (const [name, value] of Object.entries(input.transport)) {
    const cls = classifyTransport(name);
    if (cls === 'TRACKING' && input.omitTracking) {
      omittedTracking.push(name);
      continue;
    }
    parts.push({ kind: 'TEXT', name, value, classification: cls, semantic: name === 'accountId' || name.includes('baseTemplate') });
  }

  // baseTemplate must come from the fresh context, never reconstructed.
  const hasBaseTemplate = Object.keys(input.transport).some((k) => k.includes('baseTemplate'));
  if (!hasBaseTemplate && requirements.fields.some((f) => f.providerFieldId.endsWith('baseTemplate]'))) {
    throw new PayloadBuildError('VALIDATION_FAILED', 'baseTemplate transport metadata missing from fresh execution context.');
  }

  const captchaPresent = (requirements as any).captcha?.present === true || input.transport['hcaptcha'] !== undefined;

  return {
    target: input.targetUrl,
    method: 'POST',
    parts,
    captcha: { present: captchaPresent, provider: captchaPresent ? 'hCaptcha' : undefined, requiredForSubmission: captchaPresent },
    omittedTracking,
    executionEligible: false, // Phase 1: NEVER eligible — set by the engine
  };
}