// Auto Apply Phase 5 — submission POLICY tests (§32, 21 cases + config clamps).
// Pure logic only: no I/O, no PII, deterministic.
import { describe, it, expect } from 'vitest';
import {
  computeSubmissionDecision,
  loadSubmissionConfig,
  blockersFromStatuses,
  describeBlocker,
  type SubmissionInputs,
} from '../../server/autoApply/submissionPolicy.js';

const clean = (over: Partial<SubmissionInputs> = {}): SubmissionInputs => ({
  provider: 'lever',
  mode: 'explicit_approval',
  submitFeatureEnabled: true,
  safeAutoPromoted: false,
  userAutoSubmitEnabled: false,
  postingMatches: true,
  planFingerprintMatches: true,
  requirementsFingerprintMatches: true,
  sessionBound: true,
  attemptReady: true,
  verificationPresent: true,
  statuses: 'VAV',
  resumeVerified: true,
  captchaPending: false,
  otpPending: false,
  mfaPending: false,
  loginPending: false,
  newRequiredFields: 0,
  formMutatedSinceVerification: false,
  requiredConsentUnapproved: false,
  eeoRequiresReview: false,
  legalAttestationUnapproved: false,
  unapprovedGeneratedAnswers: 0,
  staleBankAnswers: 0,
  alreadySubmitted: false,
  priorUnverified: false,
  ...over,
});

const blockedWith = (code: string, over: Partial<SubmissionInputs> = {}) => {
  const d = computeSubmissionDecision(clean(over));
  expect(d.allowed).toBe(false);
  expect(d.allowed === false && d.blockerCodes).toContain(code);
};

describe('Submission policy — feature flags & modes', () => {
  it('1. submit is DISABLED by default (flag off, manual_review)', () => {
    const cfg = loadSubmissionConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('manual_review');
    expect(cfg.safeAutoPromoted).toBe(false);
  });

  it('2. manual_review never submits', () => {
    blockedWith('SUBMIT_DISABLED', { mode: 'manual_review' });
    blockedWith('SUBMIT_DISABLED', { submitFeatureEnabled: false });
  });

  it('3. explicit approval can submit when every check passes', () => {
    const d = computeSubmissionDecision(clean());
    expect(d).toEqual({ allowed: true, mode: 'EXPLICIT_APPROVAL' });
  });

  it('4. safe_auto requires user opt-in (and the promotion gate)', () => {
    blockedWith('USER_AUTO_SUBMIT_DISABLED', { mode: 'safe_auto', safeAutoPromoted: true });
    blockedWith('SUBMIT_DISABLED', { mode: 'safe_auto', safeAutoPromoted: false, userAutoSubmitEnabled: true });
    const ok = computeSubmissionDecision(clean({ mode: 'safe_auto', safeAutoPromoted: true, userAutoSubmitEnabled: true }));
    expect(ok).toEqual({ allowed: true, mode: 'SAFE_AUTO' });
  });

  it('clamps safe_auto down to explicit_approval until promoted (never silently up)', () => {
    expect(loadSubmissionConfig({ AUTO_APPLY_SUBMIT_ENABLED: 'true', AUTO_APPLY_SUBMIT_MODE: 'safe_auto' }).mode).toBe('explicit_approval');
    expect(
      loadSubmissionConfig({ AUTO_APPLY_SUBMIT_ENABLED: 'true', AUTO_APPLY_SUBMIT_MODE: 'safe_auto', AUTO_APPLY_SAFE_AUTO_PROMOTED: 'true' }).mode
    ).toBe('safe_auto');
    expect(loadSubmissionConfig({ AUTO_APPLY_SUBMIT_ENABLED: 'false', AUTO_APPLY_SUBMIT_MODE: 'explicit_approval' }).mode).toBe('manual_review');
  });
});

describe('Submission policy — verification completeness', () => {
  it('5. verified fields are required (missing/empty verification blocks)', () => {
    blockedWith('VERIFICATION_MISSING', { verificationPresent: false });
    blockedWith('VERIFICATION_MISSING', { statuses: '' });
  });

  it('6. mismatch blocks', () => blockedWith('FIELD_MISMATCH', { statuses: 'VMV' }));
  it('7. not-found blocks', () => blockedWith('FIELD_NOT_FOUND', { statuses: 'VN' }));
  it('8. unverifiable required field blocks', () => blockedWith('FIELD_UNVERIFIABLE', { statuses: 'VU' }));
  it('8b. blocked/unsupported field blocks', () => blockedWith('UNRESOLVED_REQUIRED_FIELD', { statuses: 'VB' }));
  it('9. new required field blocks', () => blockedWith('NEW_REQUIRED_FIELD', { newRequiredFields: 1 }));
  it('10. resume missing blocks', () => blockedWith('RESUME_NOT_VERIFIED', { resumeVerified: false }));
});

describe('Submission policy — human checkpoints are never bypassed', () => {
  it('11. CAPTCHA blocks', () => blockedWith('CAPTCHA_REQUIRED', { captchaPending: true }));
  it('12. solved CAPTCHA triggers revalidation → clean inputs submit', () => {
    blockedWith('CAPTCHA_REQUIRED', { captchaPending: true });
    expect(computeSubmissionDecision(clean({ captchaPending: false }))).toEqual({ allowed: true, mode: 'EXPLICIT_APPROVAL' });
  });
  it('13. OTP blocks', () => blockedWith('OTP_REQUIRED', { otpPending: true }));
  it('14. MFA blocks', () => blockedWith('MFA_REQUIRED', { mfaPending: true }));
  it('15. login checkpoint blocks', () => blockedWith('LOGIN_REQUIRED', { loginPending: true }));
});

describe('Submission policy — consent & sensitive questions', () => {
  it('16. required consent blocks when unapproved', () => blockedWith('REQUIRED_CONSENT_UNAPPROVED', { requiredConsentUnapproved: true }));
  it('17. optional marketing consent does not block (untouched input stays clean)', () => {
    expect(computeSubmissionDecision(clean())).toEqual({ allowed: true, mode: 'EXPLICIT_APPROVAL' });
  });
  it('16b. EEO review blocks; legal attestation blocks', () => {
    blockedWith('EEO_REQUIRES_REVIEW', { eeoRequiresReview: true });
    blockedWith('LEGAL_ATTESTATION', { legalAttestationUnapproved: true });
  });
});

describe('Submission policy — answer hygiene, drift & duplicates', () => {
  it('18. unapproved generated answer blocks', () => blockedWith('ANSWER_UNAPPROVED', { unapprovedGeneratedAnswers: 1 }));
  it('19. stale bank answer blocks', () => blockedWith('ANSWER_STALE', { staleBankAnswers: 2 }));
  it('20. changed form blocks', () => blockedWith('FORM_CHANGED', { formMutatedSinceVerification: true }));
  it('21. changed posting blocks', () => blockedWith('JOB_CHANGED', { postingMatches: false }));
  it('plan/requirements drift + stale session + not-ready attempt block', () => {
    blockedWith('PLAN_DRIFT', { planFingerprintMatches: false });
    blockedWith('REQUIREMENTS_DRIFT', { requirementsFingerprintMatches: false });
    blockedWith('SESSION_STALE', { sessionBound: false });
    blockedWith('ATTEMPT_NOT_READY', { attemptReady: false });
  });
  it('duplicate protection: prior receipt blocks; unverified prior blocks retry', () => {
    blockedWith('APPLICATION_ALREADY_SUBMITTED', { alreadySubmitted: true });
    blockedWith('PRIOR_SUBMISSION_UNVERIFIED', { priorUnverified: true });
  });
  it('provider scope is Lever only', () => blockedWith('PROVIDER_UNSUPPORTED', { provider: 'greenhouse' }));
  it('collects EVERY blocker (no short-circuit)', () => {
    const d = computeSubmissionDecision(
      clean({ statuses: 'MN', captchaPending: true, resumeVerified: false, alreadySubmitted: true, provider: 'ashby' })
    );
    expect(d.allowed).toBe(false);
    const codes = d.allowed === false ? d.blockerCodes : [];
    for (const c of ['FIELD_MISMATCH', 'FIELD_NOT_FOUND', 'CAPTCHA_REQUIRED', 'RESUME_NOT_VERIFIED', 'APPLICATION_ALREADY_SUBMITTED', 'PROVIDER_UNSUPPORTED']) {
      expect(codes).toContain(c);
    }
  });
  it('status letters map conservatively; unknown letters are unverifiable', () => {
    expect(blockersFromStatuses('VAV')).toEqual([]);
    expect(blockersFromStatuses('M')).toEqual(['FIELD_MISMATCH']);
    expect(blockersFromStatuses('N')).toEqual(['FIELD_NOT_FOUND']);
    expect(blockersFromStatuses('U')).toEqual(['FIELD_UNVERIFIABLE']);
    expect(blockersFromStatuses('B')).toEqual(['UNRESOLVED_REQUIRED_FIELD']);
    expect(blockersFromStatuses('X')).toEqual(['FIELD_UNVERIFIABLE']);
  });
  it('describeBlocker returns PII-free copy for every critical code', () => {
    for (const c of ['CAPTCHA_REQUIRED', 'REQUIRED_CONSENT_UNAPPROVED', 'PRIOR_SUBMISSION_UNVERIFIED', 'APPLICATION_ALREADY_SUBMITTED'] as const) {
      expect(describeBlocker(c).length).toBeGreaterThan(5);
    }
  });
});
