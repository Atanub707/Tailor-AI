// Auto Apply Phase 4H — browser read-back verification mapping.
//
// The extension compares the live DOM against the approved plan INSIDE the
// page and sends only compact, value-free statuses (one char per planned
// field, in plan order). This module parses that snapshot, maps it back to
// the frozen plan by INDEX (deterministic — never fuzzy matching), and builds
// the existing Section-22 outcome via buildFillOutcome. No parallel state
// machine, no raw values, no submission.

import { buildFillOutcome, type FieldFillStatus, type FillOutcome } from './fillValidation.js';
import type { SubmissionPlan } from '../applicationEngine/contract.js';

/** Browser status char → server status. */
export const STATUS_CHAR: Record<string, FieldFillStatus> = {
  V: 'VERIFIED',
  A: 'ALREADY_CORRECT',
  M: 'MISMATCH',
  N: 'NOT_FOUND',
  B: 'BLOCKED',
  U: 'UNVERIFIABLE',
};

export type ResumeVerificationStatus = 'VERIFIED' | 'MISSING' | 'FAILED';

export interface VerificationEventMeta {
  statuses: string;
  resumeStatus: ResumeVerificationStatus;
  newRequiredFieldCount: number;
  blockers: string[];
}

/** Strict parse of the FILL_VERIFICATION_COMPLETED metadata. Malformed → null. */
export function parseVerificationMetadata(metadata: Record<string, string> | undefined): VerificationEventMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const statuses = String(metadata.statuses ?? '');
  if (!/^[VAMNBU]{0,120}$/.test(statuses)) return null;
  const resumeStatus = String(metadata.resumeStatus ?? '');
  if (!['VERIFIED', 'MISSING', 'FAILED'].includes(resumeStatus)) return null;
  const n = Number(metadata.newRequiredFieldCount ?? '0');
  if (!Number.isFinite(n) || n < 0) return null;
  const rawBlockers = String(metadata.blockers ?? 'NONE');
  if (!/^[A-Za-z0-9_|.-]{0,120}$/.test(rawBlockers)) return null;
  return {
    statuses,
    resumeStatus: resumeStatus as ResumeVerificationStatus,
    newRequiredFieldCount: Math.floor(n),
    blockers: rawBlockers === 'NONE' ? [] : rawBlockers.split('|').filter(Boolean),
  };
}

/** The exact fields the companion was asked to fill — SAME filter and order
 *  as the companion session payload (`value !== null`). */
export function plannedFillFields(plan: SubmissionPlan) {
  return plan.mappedFields.filter((m) => m.value !== null && m.value !== undefined);
}

export interface VerificationOutcomeInput {
  attemptId: string;
  plan: SubmissionPlan;
  metadata: Record<string, string> | undefined;
  resumeExpectedHash: string;
  /** Attempt status — readiness additionally requires the companion's own
   *  READY_FOR_USER_SUBMISSION state (bindings must still agree). */
  attemptStatus?: string;
}

/** Map the browser snapshot onto the plan and build the fill outcome. */
export function buildVerificationOutcome(input: VerificationOutcomeInput): FillOutcome | null {
  const meta = parseVerificationMetadata(input.metadata);
  if (!meta) return null;
  const planned = plannedFillFields(input.plan);
  const chars = meta.statuses.split('');

  const attempted = planned.map((m, i) => ({
    providerFieldId: m.providerFieldId,
    canonicalKey: m.canonicalKey,
    source: m.source,
    expected: m.value,
    fieldType: String(m.type),
    // Missing characters (snapshot shorter than the plan) are never trusted.
    status: STATUS_CHAR[chars[i]] ?? ('UNVERIFIABLE' as FieldFillStatus),
  }));
  const requiredFieldIds = planned.filter((m) => m.required).map((m) => m.providerFieldId);

  const outcome = buildFillOutcome({
    attemptId: input.attemptId,
    provider: 'lever',
    attempted,
    skipped: [],
    requiredFieldIds,
    newRequiredFieldCount: meta.newRequiredFieldCount,
    resume: {
      expectedHash: input.resumeExpectedHash,
      uploaded: meta.resumeStatus !== 'MISSING',
      verified: meta.resumeStatus === 'VERIFIED',
    },
    blockers: meta.blockers,
  });

  // Bindings: a clean read-back alone is not "ready" unless the companion
  // reached its user-submission state for this attempt.
  if (outcome.readyForUserSubmission && input.attemptStatus && input.attemptStatus !== 'READY_FOR_USER_SUBMISSION') {
    return { ...outcome, readyForUserSubmission: false };
  }
  return outcome;
}

export interface VerificationSummary {
  totalFields: number;
  verified: number;
  alreadyCorrect: number;
  mismatch: number;
  notFound: number;
  unverifiable: number;
  blocked: number;
  newRequiredFields: number;
  resumeVerified: boolean;
}

export function summarizeVerification(outcome: FillOutcome, newRequiredFieldCount = 0): VerificationSummary {
  const count = (status: FieldFillStatus) => outcome.filled.filter((f) => f.status === status).length;
  return {
    totalFields: outcome.filled.length,
    verified: count('VERIFIED'),
    alreadyCorrect: count('ALREADY_CORRECT'),
    mismatch: count('MISMATCH'),
    notFound: count('NOT_FOUND'),
    unverifiable: count('UNVERIFIABLE'),
    blocked: count('BLOCKED'),
    newRequiredFields: newRequiredFieldCount,
    resumeVerified: outcome.resume.verified === true,
  };
}

/** Latest snapshot wins (deterministic replacement); older events are ignored. */
export function latestVerificationEvent<T extends { eventType: string }>(events: T[]): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === 'FILL_VERIFICATION_COMPLETED') return events[i];
  }
  return undefined;
}
