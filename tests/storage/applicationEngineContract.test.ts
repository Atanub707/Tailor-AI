// Application Engine V1 — Phase 0 contract helpers: provider detection,
// redirect classification, field normalization, consent/EEO classification,
// fingerprints. All deterministic; zero network.
import { describe, it, expect } from 'vitest';
import {
  detectProvider, classifyTarget, normalizeFieldLabel, classifyConsent, classifyEeo,
  requirementsFingerprint,
} from '../../server/applicationEngine/contract.js';

describe('Application Engine V1 — Phase 0 contracts', () => {
  it('provider detection: host+platform agreement → high confidence', () => {
    const d = detectProvider('greenhouse', 'https://job-boards.greenhouse.io/backblaze/jobs/1', 'https://boards.greenhouse.io/backblaze/1');
    expect(d.provider).toBe('greenhouse');
    expect(d.confidence).toBe('high');
    expect(detectProvider('lever', 'https://jobs.lever.co/veo/x', undefined).provider).toBe('lever');
    expect(detectProvider('ashby', 'https://jobs.ashbyhq.com/co/x/application', undefined).provider).toBe('ashby');
  });

  it('provider detection: redirect target wins over platform signal (medium/low confidence)', () => {
    const d = detectProvider('greenhouse', 'https://careers.workday.com/company/x/jobs/1', undefined);
    // hostname is NOT a supported family → platform signal only, low confidence
    expect(d.provider).toBe('greenhouse');
    expect(d.confidence).toBe('low');
    expect(d.reason).toContain('redirect');
    const d2 = detectProvider(undefined, 'https://boards.greenhouse.io/other/jobs/9', undefined);
    expect(d2.provider).toBe('greenhouse');
    expect(d2.confidence).toBe('high');
    expect(d2.reason).toContain('hostname signals');
  });

  it('redirect classification: ATS applyUrl → supported; foreign host → redirected/unsupported; none → manual', () => {
    expect(classifyTarget('https://jobs.lever.co/veo/x', 'lever')).toBe('SUPPORTED_TARGET');
    expect(classifyTarget('https://careers.company.com/apply/1', 'greenhouse')).toBe('REDIRECTED_SUPPORTED_TARGET');
    expect(classifyTarget('https://careers.company.com/apply/1', undefined)).toBe('UNSUPPORTED_TARGET');
    expect(classifyTarget(undefined, 'ashby')).toBe('MANUAL_ONLY');
  });

  it('field normalization: exact labels + common aliases → canonical keys', () => {
    expect(normalizeFieldLabel('First Name')).toBe('firstName');
    expect(normalizeFieldLabel('Given Name')).toBe('firstName');
    expect(normalizeFieldLabel('Are you legally authorized to work in the United States?')).toBe('authorizedToWork');
    expect(normalizeFieldLabel('Will you now or in the future require sponsorship for employment?')).toBe('requiresSponsorship');
    expect(normalizeFieldLabel('LinkedIn URL')).toBe('linkedinUrl');
    expect(normalizeFieldLabel('Upload your resume (PDF)')).toBe('resume');
    expect(normalizeFieldLabel('What is your favorite color?')).toBeUndefined();
  });

  it('consent classification: legal phrases never auto-accepted', () => {
    expect(classifyConsent('I agree to the privacy policy and terms of use.')).toBe('LEGAL_CONSENT');
    expect(classifyConsent('Consent to background check')).toBe('LEGAL_CONSENT');
    expect(classifyConsent('I confirm the information provided is accurate.')).toBe('REQUIRED_ACKNOWLEDGEMENT');
    expect(classifyConsent('Would you like more information about our company?')).toBe('INFORMATIONAL');
  });

  it('EEO classification: demographic fields isolated', () => {
    expect(classifyEeo('What is your gender?')).toBe('EEO');
    expect(classifyEeo('Veteran status')).toBe('EEO');
    expect(classifyEeo('Are you authorized to work?')).toBe('WORK_AUTHORIZATION');
    expect(classifyEeo('How many years of experience?')).toBe('UNKNOWN');
  });

  it('requirement fingerprint: deterministic; changes with fields/provider/host', () => {
    const fields = [
      { providerFieldId: 'name', label: 'Name', type: 'TEXT' as const, required: true, category: 'IDENTITY' as const },
      { providerFieldId: 'email', label: 'Email', type: 'EMAIL' as const, required: true, category: 'CONTACT' as const },
    ];
    const f1 = requirementsFingerprint('lever', 'jobs.lever.co', fields);
    const f2 = requirementsFingerprint('lever', 'jobs.lever.co', fields);
    const f3 = requirementsFingerprint('greenhouse', 'job-boards.greenhouse.io', fields);
    const f4 = requirementsFingerprint('lever', 'jobs.lever.co', [...fields, { providerFieldId: 'phone', label: 'Phone', type: 'PHONE' as const, required: false, category: 'CONTACT' as const }]);
    expect(f2).toBe(f1); // deterministic 10x-style stability
    for (let i = 0; i < 8; i++) expect(requirementsFingerprint('lever', 'jobs.lever.co', fields)).toBe(f1);
    expect(f3).not.toBe(f1); // provider/host changes fingerprint
    expect(f4).not.toBe(f1); // field set changes fingerprint
  });

  it('statuses and failure taxonomy are closed sets (compile-level contract)', () => {
    const statuses = ['INSPECTING', 'NEEDS_INPUT', 'NEEDS_REVIEW', 'READY_TO_SUBMIT', 'UNSUPPORTED'];
    const failures = ['VALIDATION_FAILED', 'MISSING_REQUIRED_FIELD', 'REVIEW_REQUIRED', 'CAPTCHA_REQUIRED', 'SUCCESS_UNCONFIRMED', 'DUPLICATE_APPLICATION', 'MANUAL_ACTION_REQUIRED'];
    expect(statuses.length).toBe(5);
    expect(failures.length).toBeGreaterThanOrEqual(7);
  });
});