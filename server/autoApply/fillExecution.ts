// Auto Apply Phase 4F — Lever Browser Companion FILL-ONLY execution.
//
// FILLING IS NOT SUBMITTING. This module:
//   readiness READY + canFill → freeze the exact approved fill inputs
//   → existing ApplicationApproval + ApplicationAttempt (same state machine)
//   → existing Browser Companion session (secure pairing/TTL/bindings)
//   → extension fills the live Lever page and attaches the exact resume.
// It never clicks Submit, never enables submission transport, and never marks
// the job Applied. `SUBMISSION_TRANSPORT_ENABLED` is a frozen constant.

import { getCurrentUserId, getDb } from '../storage/fileStorage.js';
import { artifactExists } from '../applicationPackage/artifactStore.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { getPlanById, computeStatus } from '../applicationEngine/engine.js';
import { createApproval, prepareExecution } from '../applicationEngine/executionEngine.js';
import { planFingerprint, storePlan } from '../applicationEngine/planStore.js';
import { createCompanionSession } from '../browserCompanion/companionService.js';
import { executionModeFromEnv, type ExecutionMode } from './submissionReadiness.js';
import { canonicalKeyForQuestion } from './answerBank/answerCanonicalizer.js';
import { runAutoApplyDryRun, AutoApplyError } from './autoApplyService.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { MappedField, SubmissionPlan } from '../applicationEngine/contract.js';
import type { ReadinessResult } from './submissionReadiness.js';
import type { AutoApplyBankMatch, AutoApplyDryRunResult } from './autoApplyTypes.js';

/** Frozen invariant: no submission transport exists in this phase. */
export const SUBMISSION_TRANSPORT_ENABLED = false;

export interface FillFeatureState {
  enabled: boolean;
  mode: ExecutionMode;
  /** Fill only ever runs in fill_only mode (auto_submit is NOT activated). */
  fillOnlyActive: boolean;
}

export function fillFeatureState(): FillFeatureState {
  const enabled = (process.env.AUTO_APPLY_BROWSER_FILL_ENABLED ?? 'false') === 'true';
  const mode = executionModeFromEnv();
  return { enabled, mode, fillOnlyActive: enabled && mode === 'fill_only' };
}

// ── Plan freezing (Section 5) ────────────────────────────────────────────

export interface FreezeFillInput {
  plan: SubmissionPlan;
  pkg: ApplicationPackage;
  /** Answer-bank matches that resolved cleanly (requiresReview=false). */
  bankMatched: AutoApplyBankMatch[];
}

export interface FrozenFillPlan {
  plan: SubmissionPlan;
  addedFields: number;
}

/** Freeze the exact fill inputs: append clean bank values (including
 *  user-approved GENERATED_APPROVED records) as USER-method mapped fields,
 *  drop them from unresolved, recompute status + fingerprint, persist.
 *  Unapproved drafts, stale/sensitive answers, consent and EEO fields are
 *  never added. */
export function freezeFillPlan(input: FreezeFillInput): FrozenFillPlan {
  const clean = input.bankMatched.filter((m) => !m.requiresReview && m.value !== null && m.value !== undefined);
  if (clean.length === 0) return { plan: input.plan, addedFields: 0 };

  const addedIds = new Set(clean.map((m) => m.providerFieldId));
  const detailById = new Map(input.plan.unresolvedDetails.map((d) => [d.providerFieldId, d]));
  const appended: MappedField[] = clean.map((m) => {
    const detail = detailById.get(m.providerFieldId);
    return {
      providerFieldId: m.providerFieldId,
      canonicalKey: canonicalKeyForQuestion(m.label),
      label: m.label,
      type: (detail?.type ?? 'TEXT') as MappedField['type'],
      required: detail?.required ?? true,
      value: m.value,
      source: 'ANSWER_BANK',
      mappingConfidence: m.matchStatus === 'SEMANTIC' ? 'medium' : 'high',
      mappingMethod: 'USER',
    };
  });

  const mappedFields = [...input.plan.mappedFields, ...appended];
  const unresolvedDetails = input.plan.unresolvedDetails.filter((d) => !addedIds.has(d.providerFieldId));
  const unresolvedFields = unresolvedDetails.filter((d) => d.required).map((d) => d.providerFieldId);
  const status = computeStatus({ unresolved: unresolvedDetails, consent: input.plan.consentFields, manual: input.plan.manualFields });
  const targetIdentity = `${input.plan.target.provider}|${input.plan.target.externalJobId}|${input.plan.target.applyUrl}`;
  const fingerprint = planFingerprint(
    input.pkg.snapshotHash,
    input.plan.provider,
    targetIdentity,
    input.plan.requirementsFingerprint,
    JSON.stringify(mappedFields.map((m) => [m.providerFieldId, String(m.value ?? ''), m.mappingMethod].join('|'))),
    JSON.stringify(input.plan.files),
    JSON.stringify(input.plan.consentFields.map((c) => c.providerFieldId)),
    JSON.stringify(input.plan.manualFields.map((m) => m.providerFieldId))
  );

  const frozen: SubmissionPlan = {
    ...input.plan,
    mappedFields,
    unresolvedDetails,
    unresolvedFields,
    status,
    planFingerprint: fingerprint,
    updatedAt: new Date().toISOString(),
  };
  storePlan(frozen);
  return { plan: frozen, addedFields: appended.length };
}

// ── Fill execution (Section 4 + 6 + 7) ───────────────────────────────────

export type FillStartStatus =
  | 'FILL_STARTED'
  | 'FILL_DISABLED'
  | 'FILL_NOT_ELIGIBLE'
  | 'USER_ACTION_REQUIRED'
  | 'FORM_CHANGED'
  | 'FAILED';

export interface FillDeps {
  /** Test seam: replaces the live-GET prepare step (defaults to the engine). */
  prepareExecutionFn?: typeof prepareExecution;
  /** Test seam: replaces companion session creation. */
  createSessionFn?: typeof createCompanionSession;
  /** Test seam: fixture adapter/mode for the resolution dry run. */
  dryRunOptions?: Parameters<typeof runAutoApplyDryRun>[1];
}

export interface FillStartResult {
  status: FillStartStatus;
  attemptId?: string;
  sessionId?: string;
  expiresAt?: string;
  planId?: string;
  packageId?: string;
  frozenFieldCount?: number;
  blockers: string[];
  readiness?: ReadinessResult;
  message?: string;
  submissionTransportEnabled: false;
  submissionPerformed: false;
}

const noSubmission = { submissionTransportEnabled: false as const, submissionPerformed: false as const };

/** Start fill-only execution for the CURRENT user's Lever job. Callers must
 *  run inside the authenticated request context (same as the dry run). */
export async function startFillExecution(
  jobId: string,
  deps: FillDeps = {}
): Promise<FillStartResult> {
  const feature = fillFeatureState();
  if (!feature.enabled) {
    return { ...noSubmission, status: 'FILL_DISABLED', blockers: [], message: 'Browser fill is disabled (AUTO_APPLY_BROWSER_FILL_ENABLED=false).' };
  }
  if (feature.mode !== 'fill_only') {
    return { ...noSubmission, status: 'FILL_DISABLED', blockers: [], message: `Execution mode "${feature.mode}" does not allow filling.` };
  }
  const userId = getCurrentUserId();
  if (!userId) throw new AutoApplyError('UNAUTHENTICATED', 'Not signed in.');

  // 1. Resolve exactly like the dry run (deterministic → Answer Bank → Laya).
  const dry: AutoApplyDryRunResult = await runAutoApplyDryRun(jobId, deps.dryRunOptions);

  // 2. Fill eligibility: READY + canFill + explicit blockers empty.
  const readiness = dry.readiness;
  if (dry.status !== 'DRY_RUN_READY' || !readiness) {
    return { ...noSubmission, status: 'FILL_NOT_ELIGIBLE', blockers: [dry.status], readiness, message: dry.message };
  }
  if (readiness.status !== 'READY' || !readiness.canFill) {
    return {
      ...noSubmission,
      status: 'FILL_NOT_ELIGIBLE',
      blockers: readiness.blockers.length ? readiness.blockers : [`READINESS_${readiness.status}`],
      readiness,
      planId: dry.execution?.planId,
      packageId: dry.execution?.packageId,
    };
  }

  const planId = dry.execution?.planId;
  const packageId = dry.execution?.packageId;
  if (!planId || !packageId) return { ...noSubmission, status: 'FAILED', blockers: ['MISSING_BINDINGS'], readiness };
  const pkg = getPackageById(userId, packageId);
  const plan = getPlanById(userId, planId);
  if (!pkg || !plan) return { ...noSubmission, status: 'FAILED', blockers: ['BINDINGS_MISSING'], readiness, planId, packageId };
  if (!pkg.resumeSnapshot?.pdfHash || !artifactExists(pkg.resumeSnapshot.pdfHash)) {
    return { ...noSubmission, status: 'FILL_NOT_ELIGIBLE', blockers: ['RESUME_ARTIFACT_MISSING'], readiness, planId, packageId };
  }

  // 3. Freeze the exact approved inputs (bank values included; never drafts).
  const frozen = freezeFillPlan({ plan, pkg, bankMatched: dry.answerBank.matched.filter((m) => !m.requiresReview) });
  if (frozen.plan.status !== 'READY_TO_SUBMIT') {
    return { ...noSubmission, status: 'FILL_NOT_ELIGIBLE', blockers: [`PLAN_${frozen.plan.status}`], readiness, planId, packageId };
  }

  // 4. Existing approval + attempt (same execution state machine).
  let approval;
  let prepared;
  try {
    approval = createApproval({ db: getDb(), userId, plan: frozen.plan, pkg, consents: [], marketingOptIn: false });
    const prepare = deps.prepareExecutionFn ?? prepareExecution;
    prepared = await prepare({
      db: getDb(),
      userId,
      plan: frozen.plan,
      pkg,
      approval,
      marketingOptIn: false,
      omitTracking: true,
    });
  } catch (err: any) {
    if (err?.name === 'ExecutionError') {
      return { ...noSubmission, status: 'FILL_NOT_ELIGIBLE', blockers: [err.kind ?? 'EXECUTION_REFUSED'], readiness, planId, packageId };
    }
    if (err?.name === 'PayloadBuildError') {
      // The page REJECTED an approved value (e.g. a saved answer that isn't one
      // of the form's options). Surface it precisely so it is fixable.
      const msg = String(err?.message || '').slice(0, 300);
      console.error('[AutoApply] payload rejected:', msg);
      return { ...noSubmission, status: 'FILL_NOT_ELIGIBLE', blockers: ['SAVED_ANSWER_NOT_AN_OPTION'], readiness, planId, packageId, message: msg };
    }
    // Never swallow the real reason — this masked a live defect once.
    console.error('[AutoApply] prepare failed:', String(err?.stack || err?.message || err).slice(0, 400));
    return { ...noSubmission, status: 'FAILED', blockers: ['PREPARE_FAILED'], readiness, planId, packageId };
  }

  // 5. Human checkpoints pause (never bypassed) — but the companion session
  // is still created so the DESIGNED handoff can run: the extension fills the
  // safe fields + attaches the resume, pauses at the checkpoint, and resumes
  // once the user clears it on the page (checkpoint continuation).
  if (!prepared.requirementsMatch) {
    return {
      ...noSubmission, status: 'FORM_CHANGED', blockers: ['FORM_CHANGED'],
      attemptId: prepared.attempt.id, readiness, planId, packageId,
      message: 'The application form changed since inspection — re-inspect before filling.',
    };
  }
  const checkpoint: 'CAPTCHA_REQUIRED' | 'MANUAL_ACTION_REQUIRED' | null =
    prepared.captcha?.present ? 'CAPTCHA_REQUIRED'
      : prepared.attempt.status === 'MANUAL_ACTION_REQUIRED' ? 'MANUAL_ACTION_REQUIRED'
        : null;

  // 6. Existing secure companion session (binding + TTL preserved). Sessions
  // are allowed for MANUAL_ACTION_REQUIRED attempts (the checkpoint handoff).
  try {
    const createSession = deps.createSessionFn ?? createCompanionSession;
    const session = createSession(getDb(), userId, prepared.attempt.id);
    if (checkpoint) {
      return {
        ...noSubmission,
        status: 'USER_ACTION_REQUIRED',
        blockers: [checkpoint],
        attemptId: prepared.attempt.id,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        planId,
        packageId,
        readiness,
        message: checkpoint === 'CAPTCHA_REQUIRED'
          ? 'Safe fields and your resume will fill first — complete the human verification in the opened page to continue.'
          : 'Complete the required step in the opened page to continue.',
      };
    }
    return {
      ...noSubmission,
      status: 'FILL_STARTED',
      attemptId: prepared.attempt.id,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      planId,
      packageId,
      frozenFieldCount: frozen.plan.mappedFields.length,
      blockers: [],
      readiness,
    };
  } catch (err: any) {
    return {
      ...noSubmission, status: 'FAILED', blockers: [err?.code ?? 'SESSION_FAILED'],
      attemptId: prepared.attempt.id, readiness, planId, packageId,
    };
  }
}
