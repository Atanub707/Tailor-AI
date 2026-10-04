// Auto Apply Phase 4H — browser read-back verification mapping tests.
// Pure/offline: no DOM, no network. The extension compares values in-page;
// these tests pin the compact snapshot contract and the outcome mapping.
import { describe, it, expect } from 'vitest';
import {
  buildVerificationOutcome, latestVerificationEvent, parseVerificationMetadata,
  plannedFillFields, summarizeVerification,
} from '../../server/autoApply/fillVerification.js';
import type { SubmissionPlan } from '../../server/applicationEngine/contract.js';

const plan = (): SubmissionPlan => ({
  id: 'plan-1', userId: 'u1', packageId: 'pkg-1', packageSnapshotHash: 'h',
  provider: 'lever',
  target: { provider: 'lever', externalJobId: 'e1', applyUrl: 'https://jobs.lever.co/veo/e1', company: 'Veo', title: 'PE', hostname: 'jobs.lever.co', redirectKind: 'SUPPORTED_TARGET' },
  requirementsFingerprint: 'rf',
  mappedFields: [
    { providerFieldId: 'name', canonicalKey: 'fullName', label: 'Name', type: 'TEXT', required: true, value: 'Ravi Kumar', source: 'MASTER_CV', mappingConfidence: 'high', mappingMethod: 'EXACT' },
    { providerFieldId: 'email', canonicalKey: 'email', label: 'Email', type: 'EMAIL', required: true, value: 'ravi@example.com', source: 'PROFILE', mappingConfidence: 'high', mappingMethod: 'EXACT' },
    { providerFieldId: 'resume', canonicalKey: 'resume', label: 'Resume', type: 'FILE', required: true, value: null, source: 'PACKAGE', mappingConfidence: 'high', mappingMethod: 'EXACT' },
    { providerFieldId: 'why_interested', label: 'Why are you interested in this role?', type: 'TEXTAREA', required: true, value: 'Because platform work.', source: 'ANSWER_BANK', mappingConfidence: 'high', mappingMethod: 'USER' },
  ],
  unresolvedFields: [], unresolvedDetails: [], consentFields: [], manualFields: [], files: [],
  status: 'READY_TO_SUBMIT', planFingerprint: 'fp', createdAt: '', updatedAt: '',
} as unknown as SubmissionPlan);

const meta = (over: Record<string, string> = {}) => ({
  statuses: 'VVA', resumeStatus: 'VERIFIED', newRequiredFieldCount: '0', blockers: 'NONE', ...over,
});

const build = (over: Record<string, string> = {}, attemptStatus = 'READY_FOR_USER_SUBMISSION') =>
  buildVerificationOutcome({ attemptId: 'a1', plan: plan(), metadata: meta(over), resumeExpectedHash: 'abc', attemptStatus });

describe('Read-back snapshot parsing', () => {
  it('accepts the compact value-free contract', () => {
    const parsed = parseVerificationMetadata(meta());
    expect(parsed).toEqual({ statuses: 'VVA', resumeStatus: 'VERIFIED', newRequiredFieldCount: 0, blockers: [] });
  });

  it('rejects malformed snapshots (never trusted)', () => {
    expect(parseVerificationMetadata(undefined)).toBeNull();
    expect(parseVerificationMetadata(meta({ statuses: 'VX' }))).toBeNull();
    expect(parseVerificationMetadata(meta({ statuses: 'V'.repeat(200) }))).toBeNull();
    expect(parseVerificationMetadata(meta({ resumeStatus: 'MAYBE' }))).toBeNull();
    expect(parseVerificationMetadata(meta({ newRequiredFieldCount: '-1' }))).toBeNull();
    expect(parseVerificationMetadata(meta({ blockers: '<script>' }))).toBeNull();
  });

  it('maps only planned non-null fields, in plan order (resume excluded)', () => {
    const planned = plannedFillFields(plan());
    expect(planned.map((m) => m.providerFieldId)).toEqual(['name', 'email', 'why_interested']);
  });
});

describe('Verification outcome mapping', () => {
  it('clean snapshot + companion ready state → ready for the USER, never submitted', () => {
    const outcome = build()!;
    expect(outcome.filled.map((f) => f.status)).toEqual(['VERIFIED', 'VERIFIED', 'ALREADY_CORRECT']);
    expect(outcome.mismatches).toEqual([]);
    expect(outcome.readyForUserSubmission).toBe(true);
    expect(outcome.submissionPerformed).toBe(false);
    expect(outcome.resume.verified).toBe(true);
  });

  it('mismatch / not-found / unverifiable / short snapshot → not ready', () => {
    expect(build({ statuses: 'VVM' })!.readyForUserSubmission).toBe(false);
    expect(build({ statuses: 'VVN' })!.readyForUserSubmission).toBe(false);
    expect(build({ statuses: 'VVU' })!.readyForUserSubmission).toBe(false);
    expect(build({ statuses: 'VV' })!.readyForUserSubmission).toBe(false); // shorter than plan → UNVERIFIABLE
    expect(build({ statuses: 'VVB' })!.readyForUserSubmission).toBe(false);
  });

  it('resume missing or failed → not ready', () => {
    expect(build({ resumeStatus: 'MISSING' })!.readyForUserSubmission).toBe(false);
    expect(build({ resumeStatus: 'FAILED' })!.readyForUserSubmission).toBe(false);
  });

  it('newly appeared required field → not ready (re-resolution required)', () => {
    const outcome = build({ newRequiredFieldCount: '1', blockers: 'NEW_REQUIRED_FIELD' })!;
    expect(outcome.readyForUserSubmission).toBe(false);
    expect(outcome.blockers).toContain('NEW_REQUIRED_FIELD');
  });

  it('clean snapshot but attempt not in the companion ready state → not ready (binding gate)', () => {
    expect(build({}, 'READY_FOR_DRY_RUN')!.readyForUserSubmission).toBe(false);
    expect(build({}, 'MANUAL_ACTION_REQUIRED')!.readyForUserSubmission).toBe(false);
  });

  it('malformed snapshot → null outcome', () => {
    expect(buildVerificationOutcome({ attemptId: 'a1', plan: plan(), metadata: { statuses: '???' }, resumeExpectedHash: 'abc' })).toBeNull();
  });

  it('latest snapshot wins deterministically (repeated events replace, never conflict)', () => {
    const events: Array<{ eventType: string; metadata: Record<string, string> }> = [
      { eventType: 'FILL_VERIFICATION_COMPLETED', metadata: meta({ statuses: 'VVM' }) },
      { eventType: 'READY_FOR_USER_SUBMISSION', metadata: {} },
      { eventType: 'FILL_VERIFICATION_COMPLETED', metadata: meta({ statuses: 'VVA' }) },
    ];
    const latest = latestVerificationEvent(events)!;
    expect(latest.metadata.statuses).toBe('VVA');
  });

  it('summarizes counts for the status API without values', () => {
    const summary = summarizeVerification(build({ statuses: 'VAM' })!);
    expect(summary).toMatchObject({ totalFields: 3, verified: 1, alreadyCorrect: 1, mismatch: 1, notFound: 0, resumeVerified: true });
    expect(JSON.stringify(summary)).not.toContain('Ravi');
    expect(JSON.stringify(summary)).not.toContain('ravi@example.com');
  });
});
