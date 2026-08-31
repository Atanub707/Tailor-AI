// Execution engine — provider-neutral orchestration. Phase 1: approval +
// attempt + fresh reinspection + local dry-run. NO mutation transport.
import { sha256 } from './contract.js';
import { resumeAttachmentFilename } from './resumeNaming.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import { readPdfArtifact, sha256Bytes } from '../applicationPackage/artifactStore.js';
import type { SubmissionPlan } from './contract.js';
import { ensureExecutionSchema, executionKey, storeApproval, getApproval, storeAttempt, getAttempt, getAttemptsByExecutionKey, updateAttemptStatus, updateAttemptFailure } from './executionStore.js';
import { LeverInspectionAdapter } from './leverInspector.js';
import { buildLeverPayload, payloadFingerprint, PayloadBuildError } from './leverPayloadBuilder.js';
import type { MultipartPayload } from './executionContract.js';
import { assertPhase1Transition, canTransition, integrityGate } from './executionContract.js';
import type { ApplicationApproval, ApplicationAttempt, ConsentApproval, ConsentClassification, AttemptStatus } from './executionContract.js';
import type { Database } from 'better-sqlite3';

export class ExecutionError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export interface EligibilityInput {
  plan: SubmissionPlan;
  pkg: ApplicationPackage;
  userId: string;
  jobExternalId: string;
}

/** Deterministic hash over all submission-semantic content (approval
 *  fingerprint — no timestamps, no transport metadata). Canonical JSON
 *  encoding is length-safe: values containing separators/newlines/unicode
 *  cannot collide (no raw concatenation). */
export function approvalFingerprint(plan: SubmissionPlan, pkg: ApplicationPackage, consents: ConsentApproval[], mappedFieldsHash: string, resumeArtifactHash: string): string {
  return sha256(JSON.stringify([
    plan.planFingerprint, pkg.snapshotHash, plan.requirementsFingerprint,
    resumeArtifactHash, mappedFieldsHash,
    consents
      .map((c) => ({ field: c.providerFieldId, cls: c.classification, val: c.selectedValue, hash: c.legalTextHash ?? '' }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  ]));
}

/** Canonical mapped-answers hash: sorted by providerFieldId, values via
 *  JSON.stringify (multi-select arrays keep their semantic order). */
export function mappedFieldsHash(plan: SubmissionPlan): string {
  return sha256(JSON.stringify(
    plan.mappedFields
      .map((m) => ({ field: m.providerFieldId, value: m.value ?? '' }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  ));
}

/** Execution eligibility gate — hard, structured, NO attempt otherwise. */
export function gateExecution(input: EligibilityInput): { ok: true } | { ok: false; reason: string } {
  const { plan, pkg, userId, jobExternalId } = input;
  if (!plan) return { ok: false, reason: 'PLAN_NOT_READY' };
  if (plan.userId !== userId) return { ok: false, reason: 'PLAN_NOT_READY' };
  if (plan.status !== 'READY_TO_SUBMIT') return { ok: false, reason: 'PLAN_NOT_READY' };
  if (plan.provider !== 'lever') return { ok: false, reason: 'PROVIDER_MISMATCH' };
  if (!pkg) return { ok: false, reason: 'PLAN_NOT_READY' };
  if (pkg.userId !== userId) return { ok: false, reason: 'PLAN_NOT_READY' };
  if (pkg.status !== 'READY') return { ok: false, reason: 'PACKAGE_STALE' };
  if (pkg.snapshotHash !== plan.packageSnapshotHash) return { ok: false, reason: 'PACKAGE_HASH_INVALID' };
  if (!plan.planFingerprint || !plan.requirementsFingerprint) return { ok: false, reason: 'PLAN_CHANGED' };
  const t = plan.target;
  if (!t.applyUrl || !t.applyUrl.startsWith('https://jobs.lever.co/')) return { ok: false, reason: 'TARGET_MISMATCH' };
  if (jobExternalId && t.externalJobId && jobExternalId !== t.externalJobId) return { ok: false, reason: 'TARGET_MISMATCH' };
  return { ok: true };
}

/** Verify the exact immutable PDF artifact (re-read + hash + size + MIME). */
export function verifyResumeArtifact(pkg: ApplicationPackage): { ok: true; resume: { filename: string; mimeType: string; size: number; sha256: string; artifactReference: string } } | { ok: false; reason: string } {
  const hash = pkg.resumeSnapshot?.pdfHash;
  if (!hash) return { ok: false, reason: 'RESUME_ARTIFACT_INVALID' };
  try {
    const bytes = readPdfArtifact(hash);
    if (!bytes.length) return { ok: false, reason: 'RESUME_ARTIFACT_INVALID' };
    const actual = sha256Bytes(bytes);
    if (actual !== hash) return { ok: false, reason: 'RESUME_ARTIFACT_INVALID' };
    const head = bytes.subarray(0, 5).toString('ascii');
    if (!head.startsWith('%PDF')) return { ok: false, reason: 'RESUME_ARTIFACT_INVALID' };
    // Human-readable, recruiter-friendly attachment name — never the hash.
    const filename = resumeAttachmentFilename(pkg);
    return { ok: true, resume: { filename, mimeType: 'application/pdf', size: bytes.length, sha256: actual, artifactReference: `artifact:${hash}` } };
  } catch {
    return { ok: false, reason: 'RESUME_ARTIFACT_INVALID' };
  }
}

export interface CreateApprovalInput {
  db: Database;
  userId: string;
  plan: SubmissionPlan;
  pkg: ApplicationPackage;
  consents: ConsentApproval[];
  marketingOptIn: boolean;
}

/** Creates the hash-bound approval. Content-bound: any drift invalidates. */
export function createApproval(input: CreateApprovalInput): ApplicationApproval {
  const gate = gateExecution({ plan: input.plan, pkg: input.pkg, userId: input.userId, jobExternalId: input.plan.target.externalJobId });
  if (!gate.ok) throw new ExecutionError((gate as any).reason, `Execution gate failed: ${(gate as any).reason}`);
  const mh = mappedFieldsHash(input.plan);
  const rh = input.pkg.resumeSnapshot?.pdfHash ?? '';
  const consentSelections = input.consents.map((c) => ({ ...c, approvedAt: new Date().toISOString() }));
  const approval: ApplicationApproval = {
    id: `appr-${input.userId.slice(-6)}-${Date.now().toString(36)}`,
    userId: input.userId,
    planId: input.plan.id,
    packageId: input.pkg.id,
    planFingerprint: input.plan.planFingerprint,
    packageSnapshotHash: input.pkg.snapshotHash,
    requirementsFingerprint: input.plan.requirementsFingerprint,
    resumeArtifactHash: rh,
    mappedFieldsHash: mh,
    consents: consentSelections,
    status: 'ACTIVE',
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  approvalFingerprint(input.plan, input.pkg, consentSelections, mh, rh); // validate determinism by construction
  ensureExecutionSchema(input.db);
  storeApproval(input.db, approval);
  return approval;
}

export interface PrepareExecutionInput {
  db: Database;
  userId: string;
  plan: SubmissionPlan;
  pkg: ApplicationPackage;
  approval: ApplicationApproval;
  marketingOptIn: boolean;
  omitTracking?: boolean;
}

export interface DryRunResult {
  attempt: ApplicationAttempt;
  payload: MultipartPayload | null;
  payloadFingerprint: string | null;
  requirementsMatch: boolean;
  captcha: { present: boolean; provider?: string };
  dryRunAvailable: boolean;
  /** Can this provider form theoretically be automated under current
   *  constraints (no CAPTCHA, valid form, all required resolved)? */
  formAutomationEligible: boolean;
  /** Does Tailor AI currently have mutation transport enabled? Phase 1:
   *  ALWAYS false — no submission transport exists. */
  submissionTransportEnabled: boolean;
  /** formAutomationEligible AND submissionTransportEnabled AND all gates.
   *  Phase 1: ALWAYS false (invariant). */
  executionEligible: boolean;
  reason?: string;
}

/** Fresh read-only reinspection + requirements comparison + local payload
 *  build. NEVER sends a mutation. Single-flight via the shared inspector. */
export async function prepareExecution(input: PrepareExecutionInput): Promise<DryRunResult> {
  ensureExecutionSchema(input.db);
  const gate = gateExecution({ plan: input.plan, pkg: input.pkg, userId: input.userId, jobExternalId: input.plan.target.externalJobId });
  if (!gate.ok) throw new ExecutionError((gate as any).reason, `Execution gate failed: ${(gate as any).reason}`);
  const resumeCheck = verifyResumeArtifact(input.pkg);
  if (!resumeCheck.ok) throw new ExecutionError((resumeCheck as any).reason, 'Resume artifact verification failed.');

  // Auditability: create the attempt FIRST (PREPARING), then record the
  // durable outcome via the central transition validator.
  const attemptEntry = ensureAttempt(input.db, input.userId, input.plan, input.pkg, input.approval, 'PREPARING');
  const attemptCreated = attemptEntry.created;

  // Fresh read-only GET via the REAL inspector (anti-burst + SSRF-safe).
  let fresh;
  try {
    fresh = await new LeverInspectionAdapter().inspect(input.plan.target);
  } catch (e: any) {
    if (e?.kind === 'PROVIDER_CHALLENGE' || e?.kind === 'FORM_CHANGED') {
      if (attemptCreated) {
        updateAttemptFailure(input.db, input.userId, attemptEntry.attempt.id, { kind: e.kind });
        transitionAttempt(input.db, input.userId, attemptEntry.attempt.id, 'MANUAL_ACTION_REQUIRED');
      }
      const attempt = getAttempt(input.db, input.userId, attemptEntry.attempt.id) ?? attemptEntry.attempt;
      return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha: { present: true }, dryRunAvailable: false, formAutomationEligible: false, submissionTransportEnabled: false, executionEligible: false, reason: e.kind };
    }
    if (attemptCreated) {
      updateAttemptFailure(input.db, input.userId, attemptEntry.attempt.id, { kind: e?.kind ?? 'UNKNOWN' });
      transitionAttempt(input.db, input.userId, attemptEntry.attempt.id, 'BLOCKED');
    }
    const attempt = getAttempt(input.db, input.userId, attemptEntry.attempt.id) ?? attemptEntry.attempt;
    return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha: { present: false }, dryRunAvailable: false, formAutomationEligible: false, submissionTransportEnabled: false, executionEligible: false, reason: e?.kind ?? 'UNKNOWN' };
  }

  const requirementsMatch = fresh.fingerprint === input.plan.requirementsFingerprint;
  const captcha = { present: (fresh as any).captcha?.present === true || (fresh as any).providerMetadata?.hcaptcha !== undefined, provider: 'hCaptcha' };
  if (!requirementsMatch) {
    if (attemptCreated) {
      updateAttemptFailure(input.db, input.userId, attemptEntry.attempt.id, { kind: 'FORM_CHANGED' });
      transitionAttempt(input.db, input.userId, attemptEntry.attempt.id, 'BLOCKED');
    }
    const attempt = getAttempt(input.db, input.userId, attemptEntry.attempt.id) ?? attemptEntry.attempt;
    return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha, dryRunAvailable: false, formAutomationEligible: false, submissionTransportEnabled: false, executionEligible: false, reason: 'FORM_CHANGED' };
  }

  // Build the LOCAL payload (never sent).
  const transport = { ...(fresh as any).providerMetadata ?? {}, hcaptcha: captcha.present ? 'hCaptcha' : undefined } as Record<string, string>;
  const consentSelections: Record<string, boolean | string> = {};
  for (const c of input.approval.consents) consentSelections[c.providerFieldId] = c.selectedValue;
  const payload = buildLeverPayload({
    plan: input.plan,
    targetUrl: input.plan.target.applyUrl,
    requirements: fresh,
    resume: resumeCheck.resume,
    transport,
    marketingOptIn: input.marketingOptIn,
    consentSelections,
    omitTracking: input.omitTracking ?? true,
  });
  const fp = payloadFingerprint(payload);
  payload.executionEligible = false; // Phase 1: never executable

  const finalStatus = captcha.present ? 'MANUAL_ACTION_REQUIRED' : 'READY_FOR_DRY_RUN';
  if (attemptCreated) {
    if (captcha.present) updateAttemptFailure(input.db, input.userId, attemptEntry.attempt.id, { kind: 'CAPTCHA_REQUIRED' });
    transitionAttempt(input.db, input.userId, attemptEntry.attempt.id, finalStatus);
  }
  const attempt = getAttempt(input.db, input.userId, attemptEntry.attempt.id) ?? attemptEntry.attempt;

  // Phase-1 invariant: submission transport does not exist → ALWAYS false.
  const submissionTransportEnabled = false;
  const formAutomationEligible = !captcha.present && requirementsMatch;
  return {
    attempt,
    payload,
    payloadFingerprint: fp,
    requirementsMatch: true,
    captcha,
    dryRunAvailable: payload !== null,
    formAutomationEligible,
    submissionTransportEnabled,
    executionEligible: formAutomationEligible && submissionTransportEnabled && false,
    reason: captcha.present ? 'CAPTCHA_REQUIRED' : undefined,
  };
}

/** Idempotent attempt creation — SQLite unique key is the durable authority.
 *  Returns whether THIS call created the attempt (reused attempts are never
 *  re-transitioned: a BLOCKED attempt does not magically become executable). */
function ensureAttempt(db: Database, userId: string, plan: SubmissionPlan, pkg: ApplicationPackage, approval: ApplicationApproval, status: AttemptStatus): { attempt: ApplicationAttempt; created: boolean } {
  const key = executionKey({ userId, provider: plan.provider, externalJobId: plan.target.externalJobId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
  const existing = getAttemptsByExecutionKey(db, key);
  if (existing.length) {
    return { attempt: existing[0], created: false };
  }
  assertPhase1Transition('PENDING_APPROVAL', status);
  const now = new Date().toISOString();
  const attempt: ApplicationAttempt = {
    id: `attempt-${userId.slice(-6)}-${Date.now().toString(36)}`,
    userId, planId: plan.id, packageId: pkg.id, approvalId: approval.id,
    provider: plan.provider, externalJobId: plan.target.externalJobId,
    executionKey: key,
    planFingerprint: plan.planFingerprint,
    packageSnapshotHash: pkg.snapshotHash,
    requirementsFingerprint: plan.requirementsFingerprint,
    status, transportAttemptCount: 0,
    startedAt: now, createdAt: now, updatedAt: now,
  };
  const res = storeAttempt(db, attempt);
  if (res.duplicate) {
    const existing = getAttemptsByExecutionKey(db, key);
    if (existing.length) return { attempt: existing[0], created: false };
  }
  return { attempt, created: true };
}

export function transitionAttempt(db: Database, userId: string, attemptId: string, to: AttemptStatus): ApplicationAttempt | null {
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) return null;
  if (!canTransition(attempt.status, to)) throw new ExecutionError('ILLEGAL_TRANSITION', `Cannot transition ${attempt.status} → ${to}.`);
  assertPhase1Transition(attempt.status, to);
  updateAttemptStatus(db, userId, attemptId, to);
  return getAttempt(db, userId, attemptId);
}

export { integrityGate };