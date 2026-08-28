// Lever Execution Phase 0 — design-contract tests (pure logic only; no
// network, no mutations, no DB).
import { describe, it, expect } from 'vitest';
import {
  canTransition, isTerminal, recoverFromCrash, retryClass, isApprovalValid,
  consentCovers, integrityGate,
} from '../../server/applicationEngine/executionContract.js';
import type { ApplicationApproval, ConsentApproval } from '../../server/applicationEngine/executionContract.js';

const H64 = 'a'.repeat(64);

const approval: ApplicationApproval = {
  id: 'ap1', planId: 'p1', planFingerprint: 'pf1', packageSnapshotHash: 'sh1',
  requirementsFingerprint: 'rf1', resumeArtifactHash: 'rh1', mappedFieldsHash: 'mf1',
  consents: [{ fieldId: 'consent[marketing]', legalText: 'Yes, contact me', legalTextHash: H64, approvedByUser: true, approvedAt: '2026-01-01' }],
  approvedAt: '2026-01-01',
};

describe('Execution state machine', () => {
  it('happy path transitions allowed', () => {
    expect(canTransition('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'SUBMITTING')).toBe(true);
    expect(canTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
  });

  it('SUCCESS_UNCONFIRMED → SUBMITTING is FORBIDDEN (no auto-retry after ambiguity)', () => {
    expect(canTransition('SUCCESS_UNCONFIRMED', 'SUBMITTING')).toBe(false);
    expect(isTerminal('SUCCESS_UNCONFIRMED')).toBe(true);
  });

  it('SUBMITTED is terminal; never returns to SUBMITTING', () => {
    expect(canTransition('SUBMITTED', 'SUBMITTING')).toBe(false);
    expect(isTerminal('SUBMITTED')).toBe(true);
  });

  it('SUBMITTING → ambiguous outcomes only', () => {
    expect(canTransition('SUBMITTING', 'SUCCESS_UNCONFIRMED')).toBe(true);
    expect(canTransition('SUBMITTING', 'FAILED')).toBe(true);
    expect(canTransition('SUBMITTING', 'MANUAL_ACTION_REQUIRED')).toBe(true);
  });

  it('crash during SUBMITTING recovers to SUCCESS_UNCONFIRMED — never FAILED, never resubmit', () => {
    expect(recoverFromCrash('SUBMITTING')).toBe('SUCCESS_UNCONFIRMED');
    expect(recoverFromCrash('PREPARING')).toBe('PREPARING');
  });
});

describe('Retry classification', () => {
  it('only pre-send transport failures are SAFE_RETRY', () => {
    expect(retryClass('TRANSPORT_FAILED_PRE_SEND')).toBe('SAFE_RETRY');
    expect(retryClass('PROVIDER_CHALLENGE')).toBe('MANUAL_ONLY');
    expect(retryClass('CAPTCHA_REQUIRED')).toBe('MANUAL_ONLY');
    expect(retryClass('SUCCESS_UNCONFIRMED')).toBe('NEVER_AUTO_RETRY');
    expect(retryClass('UPLOAD_FAILED')).toBe('NEVER_AUTO_RETRY');
    expect(retryClass('PROVIDER_REJECTED')).toBe('NEVER_AUTO_RETRY');
    expect(retryClass('RATE_LIMITED')).toBe('REQUIRES_REINSPECTION');
    expect(retryClass('FORM_CHANGED')).toBe('REQUIRES_REINSPECTION');
  });

  it('post-send ambiguity is NEVER_AUTO_RETRY across the board', () => {
    for (const k of ['SUCCESS_UNCONFIRMED', 'VERIFICATION_FAILED', 'DUPLICATE_BLOCKED', 'UNKNOWN'] as const) {
      expect(retryClass(k)).toBe('NEVER_AUTO_RETRY');
    }
  });
});

describe('Approval binding', () => {
  const current = {
    planId: 'p1', planFingerprint: 'pf1', packageSnapshotHash: 'sh1',
    requirementsFingerprint: 'rf1', resumeArtifactHash: 'rh1', mappedFieldsHash: 'mf1',
  };

  it('valid when every bound fingerprint matches', () => {
    expect(isApprovalValid(approval, current)).toBe(true);
  });

  it('any single drift invalidates the approval', () => {
    const cases = [
      { ...current, planFingerprint: 'changed' },
      { ...current, packageSnapshotHash: 'changed' },
      { ...current, requirementsFingerprint: 'changed' },
      { ...current, resumeArtifactHash: 'changed' },
      { ...current, mappedFieldsHash: 'changed' },
      { ...current, planId: 'other' },
    ];
    for (const c of cases) expect(isApprovalValid(approval, c)).toBe(false);
  });

  it('consent approval binds to exact legal text hash', () => {
    const c: ConsentApproval = { fieldId: 'consent[marketing]', legalText: 'Yes, contact me', legalTextHash: H64, approvedByUser: true, approvedAt: '2026-01-01' };
    expect(consentCovers(c, 'consent[marketing]', H64)).toBe(true);
    expect(consentCovers(c, 'consent[marketing]', 'b'.repeat(64))).toBe(false); // text changed
    expect(consentCovers(c, 'other-field', H64)).toBe(false);
    expect(consentCovers({ ...c, approvedByUser: false }, 'consent[marketing]', H64)).toBe(false);
  });
});

describe('Integrity gate', () => {
  const ok = { userIdMatches: true, packageBelongs: true, snapshotHash: true, planFingerprint: true, requirementsFingerprint: true, approvalValid: true, resumeArtifactVerified: true, targetMatches: true, adapterMatches: true };
  it('all green → ok', () => {
    expect(integrityGate(ok)).toEqual({ ok: true });
  });
  it('any mismatch → NO POST with a specific reason', () => {
    expect(integrityGate({ ...ok, snapshotHash: false })).toEqual({ ok: false, reason: 'PACKAGE_STALE' });
    expect(integrityGate({ ...ok, planFingerprint: false })).toEqual({ ok: false, reason: 'PLAN_CHANGED' });
    expect(integrityGate({ ...ok, requirementsFingerprint: false })).toEqual({ ok: false, reason: 'FORM_CHANGED' });
    expect(integrityGate({ ...ok, approvalValid: false })).toEqual({ ok: false, reason: 'APPROVAL_STALE' });
    expect(integrityGate({ ...ok, resumeArtifactVerified: false })).toEqual({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(integrityGate({ ...ok, userIdMatches: false })).toEqual({ ok: false, reason: 'PLAN_NOT_READY' });
  });
});