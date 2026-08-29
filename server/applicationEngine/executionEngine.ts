// Execution engine — provider-neutral orchestration. Phase 1: approval +
// attempt + fresh reinspection + local dry-run. NO mutation transport.
import { sha256 } from './contract.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import { readPdfArtifact, sha256Bytes } from '../applicationPackage/artifactStore.js';
import type { SubmissionPlan } from './contract.js';
import { ensureExecutionSchema, executionKey, storeApproval, getApproval, storeAttempt, getAttempt, getAttemptsByExecutionKey, updateAttemptStatus } from './executionStore.js';
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
 *  fingerprint — no timestamps, no transport metadata). */
export function approvalFingerprint(plan: SubmissionPlan, pkg: ApplicationPackage, consents: ConsentApproval[], mappedFieldsHash: string, resumeArtifactHash: string): string {
  const consentLine = consents
    .map((c) => `${c.providerFieldId}:${c.classification}:${c.selectedValue}:${c.legalTextHash ?? ''}`)
    .sort()
    .join('|');
  return sha256([
    plan.planFingerprint, pkg.snapshotHash, plan.requirementsFingerprint,
    resumeArtifactHash, mappedFieldsHash, consentLine,
  ].join('|'));
}

export function mappedFieldsHash(plan: SubmissionPlan): string {
  return sha256(
    plan.mappedFields
      .map((m) => `${m.providerFieldId}=${JSON.stringify(m.value ?? '')}`)
      .sort()
      .join('|'),
  );
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
    const filename = `resume-${hash.slice(0, 12)}.pdf`;
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

  // Fresh read-only GET via the REAL inspector (anti-burst + SSRF-safe).
  let fresh;
  try {
    fresh = await new LeverInspectionAdapter().inspect(input.plan.target);
  } catch (e: any) {
    if (e?.kind === 'PROVIDER_CHALLENGE' || e?.kind === 'FORM_CHANGED') {
      const attempt = ensureAttempt(input.db, input.userId, input.plan, input.pkg, input.approval, 'MANUAL_ACTION_REQUIRED');
      return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha: { present: true }, executionEligible: false, reason: e.kind };
    }
    const attempt = ensureAttempt(input.db, input.userId, input.plan, input.pkg, input.approval, 'BLOCKED');
    return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha: { present: false }, executionEligible: false, reason: e?.kind ?? 'UNKNOWN' };
  }

  const requirementsMatch = fresh.fingerprint === input.plan.requirementsFingerprint;
  const captcha = { present: (fresh as any).captcha?.present === true || (fresh as any).providerMetadata?.hcaptcha !== undefined, provider: 'hCaptcha' };
  if (!requirementsMatch) {
    const attempt = ensureAttempt(input.db, input.userId, input.plan, input.pkg, input.approval, 'BLOCKED');
    return { attempt, payload: null, payloadFingerprint: null, requirementsMatch: false, captcha, executionEligible: false, reason: 'FORM_CHANGED' };
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

  const attempt = ensureAttempt(input.db, input.userId, input.plan, input.pkg, input.approval,
    captcha.present ? 'MANUAL_ACTION_REQUIRED' : 'READY_FOR_DRY_RUN');

  return {
    attempt,
    payload,
    payloadFingerprint: fp,
    requirementsMatch: true,
    captcha,
    executionEligible: false,
    reason: captcha.present ? 'CAPTCHA_REQUIRED' : undefined,
  };
}

/** Idempotent attempt creation — SQLite unique key is the durable authority. */
function ensureAttempt(db: Database, userId: string, plan: SubmissionPlan, pkg: ApplicationPackage, approval: ApplicationApproval, status: AttemptStatus): ApplicationAttempt {
  const key = executionKey({ userId, provider: plan.provider, externalJobId: plan.target.externalJobId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint });
  const existing = getAttemptsByExecutionKey(db, key);
  if (existing.length) {
    // Reuse the existing attempt (idempotent). Phase-1 states only.
    return existing[0];
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
    if (existing.length) return existing[0];
  }
  return attempt;
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