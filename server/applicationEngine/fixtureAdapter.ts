// Application Engine V1 — fixture inspection adapter.
//
// PROOF that the engine is provider-neutral: requirements are normalized
// from sanitized fixtures (designed from Phase-0 Lever findings) through the
// SAME contract a future real adapter will implement. Zero network.
// Fixtures contain NO real applicant data, tokens, cookies, CSRF or
// session values.

import type { ApplicationField, ApplicationRequirements, ApplicationTarget, DetectionResult, Provider } from './contract.js';
import { classifyTarget, detectProvider, normalizeFieldLabel, requirementsFingerprint, type FieldCategory, type FieldType } from './contract.js';

export interface ApplicationInspectionAdapter {
  readonly provider: Provider;
  detect(target: ApplicationTarget): DetectionResult;
  inspect(target: ApplicationTarget): Promise<ApplicationRequirements>;
}

function field(providerFieldId: string, label: string, type: FieldType, required: boolean, category: FieldCategory, options?: string[]): ApplicationField {
  return { providerFieldId, label, type, required, options, category, normalizedKey: normalizeFieldLabel(label) };
}

// ── Sanitized fixtures (Lever-flavored, per Phase-0 research) ────────────

const FIXTURE_A_SIMPLE: ApplicationField[] = [
  field('name', 'Name', 'TEXT', true, 'IDENTITY'),
  field('email', 'Email', 'EMAIL', true, 'CONTACT'),
  field('phone', 'Phone', 'PHONE', false, 'CONTACT'),
  field('resume', 'Resume', 'FILE', true, 'RESUME'),
];

const FIXTURE_B_CUSTOM: ApplicationField[] = [
  field('name', 'Name', 'TEXT', true, 'IDENTITY'),
  field('email', 'Email', 'EMAIL', true, 'CONTACT'),
  field('authorization', 'Are you legally authorized to work in the United States?', 'SINGLE_SELECT', true, 'WORK_AUTHORIZATION', ['Yes', 'No']),
  field('sponsorship', 'Will you now or in the future require sponsorship for employment?', 'SINGLE_SELECT', true, 'SPONSORSHIP', ['Yes', 'No']),
  field('why_interested', 'Why are you interested in this role?', 'TEXTAREA', true, 'CUSTOM'),
  field('location_pref', 'Preferred location', 'SINGLE_SELECT', false, 'LOCATION', ['Remote', 'Hybrid', 'On-site']),
  field('resume', 'Resume', 'FILE', true, 'RESUME'),
];

const FIXTURE_C_COMPLEX: ApplicationField[] = [
  field('name', 'Name', 'TEXT', true, 'IDENTITY'),
  field('email', 'Email', 'EMAIL', true, 'CONTACT'),
  field('resume', 'Resume/CV', 'FILE', true, 'RESUME'),
  field('clearance', 'Do you hold an active security clearance?', 'SINGLE_SELECT', true, 'CUSTOM', ['Yes', 'No']),
  field('gender', 'Gender (voluntary)', 'SINGLE_SELECT', false, 'EEO', ['Female', 'Male', 'Non-binary', 'Decline to answer']),
  field('veteran', 'Veteran status (voluntary)', 'SINGLE_SELECT', false, 'EEO', ['Yes', 'No', 'Decline to answer']),
  field('privacy_consent', 'I consent to the processing of my application data per the privacy policy.', 'CONSENT', true, 'CONSENT'),
  field('custom_blob', 'Please describe your experience with orchestration.', 'TEXTAREA', true, 'CUSTOM'),
  field('mystery', 'Optional portfolio link', 'UNKNOWN', false, 'UNKNOWN'),
];

const FIXTURE_D_CHANGED: ApplicationField[] = [
  field('name', 'Name', 'TEXT', true, 'IDENTITY'),
  field('email', 'Email', 'EMAIL', true, 'CONTACT'),
  field('authorization', 'Are you legally authorized to work in the United States?', 'SINGLE_SELECT', true, 'WORK_AUTHORIZATION', ['Yes', 'No']),
  field('sponsorship', 'Will you now or in the future require sponsorship for employment?', 'SINGLE_SELECT', true, 'SPONSORSHIP', ['Yes', 'No']),
  field('why_interested', 'Why are you interested in this role?', 'TEXTAREA', true, 'CUSTOM'),
  field('new_field', 'New required question introduced by the form update', 'TEXT', true, 'CUSTOM'),
  field('resume', 'Resume', 'FILE', true, 'RESUME'),
];

export const LEVER_FIXTURES: Record<string, ApplicationField[]> = {
  'fixture-a-simple': FIXTURE_A_SIMPLE,
  'fixture-b-custom': FIXTURE_B_CUSTOM,
  'fixture-c-complex': FIXTURE_C_COMPLEX,
  'fixture-d-changed': FIXTURE_D_CHANGED,
};

/** Fixture inspection adapter — a future real Lever adapter implements the
 *  SAME contract. inspect() is strictly read-only. */
export class FixtureInspectionAdapter implements ApplicationInspectionAdapter {
  readonly provider: Provider = 'lever';
  constructor(private readonly fixtureKey = 'fixture-b-custom') {}

  detect(target: ApplicationTarget): DetectionResult {
    const d = detectProvider(undefined, target.applyUrl, target.jobUrl);
    return d;
  }

  async inspect(target: ApplicationTarget): Promise<ApplicationRequirements> {
    const fields = LEVER_FIXTURES[this.fixtureKey] ?? FIXTURE_B_CUSTOM;
    const fp = requirementsFingerprint(this.provider, target.hostname, fields);
    return { provider: this.provider, target, fields: fields.map((f) => ({ ...f })), discoveredAt: new Date().toISOString(), fingerprint: fp };
  }
}

export function targetFromJob(job: { atsPlatform?: string; applyUrl?: string; jobUrl?: string; url?: string; company?: string; title?: string; externalId?: string }): ApplicationTarget {
  const applyUrl = job.applyUrl || job.url || '';
  const jobUrl = job.jobUrl || job.url || '';
  const hostname = String(applyUrl || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  const detected = detectProvider(job.atsPlatform, applyUrl, jobUrl);
  return {
    provider: detected.provider,
    externalJobId: job.externalId || '',
    applyUrl,
    jobUrl,
    company: job.company || '',
    title: job.title || '',
    hostname,
    redirectKind: classifyTarget(applyUrl, job.atsPlatform as Provider | undefined),
    detectionConfidence: detected.confidence,
    detectionReason: detected.reason,
    targetClassification: classifyTarget(applyUrl, job.atsPlatform as Provider | undefined),
  } as ApplicationTarget;
}