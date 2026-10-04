// Auto Apply Phase 4G — post-fill validation.
//
// Filling a field successfully is NOT evidence the value landed. This module
// compares EXPECTED vs OBSERVED values (normalized) and produces the
// fill outcome. `submissionPerformed` is a constant false — this phase never
// submits, and nothing here may ever claim it did.

export type FieldFillStatus = 'VERIFIED' | 'ALREADY_CORRECT' | 'MISMATCH' | 'NOT_FOUND' | 'BLOCKED' | 'MANUAL_ONLY' | 'UNVERIFIABLE';

/** Normalize for comparison only — never persisted, never logged. */
export function normalizeForComparison(value: unknown, fieldType?: string): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).sort().join(',');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const raw = String(value);
  const type = String(fieldType || '').toUpperCase();
  if (type === 'PHONE') {
    const digits = raw.replace(/\D/g, '');
    return digits || raw.trim().toLowerCase();
  }
  if (type === 'NUMBER') {
    const n = Number(raw.replace(/,/g, '').trim());
    return Number.isFinite(n) ? String(n) : raw.trim().toLowerCase();
  }
  if (type === 'BOOLEAN' || type === 'SINGLE_SELECT' || type === 'MULTI_SELECT') {
    const t = raw.trim().toLowerCase();
    if (t === 'true' || t === '1') return 'yes';
    if (t === 'false' || t === '0') return 'no';
    return t;
  }
  // TEXT / TEXTAREA / EMAIL / URL / DATE — whitespace + case-insensitive.
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validateFieldOutcome(
  expected: unknown,
  observed: unknown,
  fieldType?: string,
  alreadyCorrect = false
): FieldFillStatus {
  if (observed === null || observed === undefined || String(observed).trim() === '') return 'NOT_FOUND';
  const equal = normalizeForComparison(expected, fieldType) === normalizeForComparison(observed, fieldType);
  if (!equal) return 'MISMATCH';
  return alreadyCorrect ? 'ALREADY_CORRECT' : 'VERIFIED';
}

export interface FillAttemptedField {
  providerFieldId: string;
  canonicalKey?: string;
  source: string;
  expected: unknown;
  observed?: unknown;
  fieldType?: string;
  alreadyCorrect?: boolean;
  /** Precomputed status (browser read-back already compared in-page). */
  status?: FieldFillStatus;
}

export interface FillSkippedField {
  providerFieldId: string;
  reason: string;
}

export interface FillOutcomeInput {
  attemptId: string;
  provider: string;
  attempted: FillAttemptedField[];
  skipped: FillSkippedField[];
  /** Every required field on the form — including any that newly appeared. */
  requiredFieldIds: string[];
  /** Required controls discovered after fill that are not in the plan. */
  newRequiredFieldCount?: number;
  resume: { expectedHash: string; uploaded: boolean; verified: boolean };
  blockers: string[];
}

export interface FillOutcome {
  attemptId: string;
  provider: string;
  filled: Array<{
    providerFieldId: string;
    canonicalKey?: string;
    source: string;
    expected: unknown;
    status: FieldFillStatus;
  }>;
  skipped: FillSkippedField[];
  mismatches: Array<{ providerFieldId: string; status: FieldFillStatus }>;
  resume: { expectedHash: string; uploaded: boolean; verified: boolean };
  blockers: string[];
  readyForUserSubmission: boolean;
  submissionPerformed: false;
}

/** Build the post-fill outcome. `readyForUserSubmission` means the USER may
 *  review and submit — it is never a submission claim. */
export function buildFillOutcome(input: FillOutcomeInput): FillOutcome {
  const filled = input.attempted.map((a) => ({
    providerFieldId: a.providerFieldId,
    canonicalKey: a.canonicalKey,
    source: a.source,
    expected: a.expected,
    status: a.status ?? validateFieldOutcome(a.expected, a.observed, a.fieldType, a.alreadyCorrect),
  }));
  const mismatches = filled
    .filter((f) => f.status === 'MISMATCH' || f.status === 'NOT_FOUND' || f.status === 'BLOCKED' || f.status === 'UNVERIFIABLE')
    .map((f) => ({ providerFieldId: f.providerFieldId, status: f.status }));

  const verifiedIds = new Set(filled.filter((f) => f.status === 'VERIFIED' || f.status === 'ALREADY_CORRECT').map((f) => f.providerFieldId));
  const requiredVerified = input.requiredFieldIds.every((id) => verifiedIds.has(id));
  const resumeVerified = input.resume.uploaded === true && input.resume.verified === true;

  const newRequired = input.newRequiredFieldCount ?? 0;
  const readyForUserSubmission =
    mismatches.length === 0 &&
    requiredVerified &&
    resumeVerified &&
    input.blockers.length === 0 &&
    newRequired === 0;

  return {
    attemptId: input.attemptId,
    provider: input.provider,
    filled,
    skipped: input.skipped,
    mismatches,
    resume: input.resume,
    blockers: input.blockers,
    readyForUserSubmission,
    submissionPerformed: false,
  };
}
