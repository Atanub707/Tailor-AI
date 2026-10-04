/**
 * Auto Apply Phase 5 — Controlled Auto Submit: orchestration.
 *
 * Flow (explicit_approval):
 *   user clicks [Submit Application]
 *     → beginExplicitSubmission(): decision → final revalidation → CAS to SUBMITTING
 *       → single-use submit order bound to the live companion session
 *     → UI relays TAILOR_SUBMIT over the bridge → SW consumes /sessions/:id/submit-command
 *     → lever.js revalidates, clicks the validated Lever control exactly once
 *     → observer reports SUBMISSION_CONFIRMED / UNCONFIRMED / FAILED
 *     → handleSubmissionOutcome(): receipt + (verified only) job Applied
 *
 * Hard rules enforced here:
 *  - Never submit twice: CAS transition + single-use order + receipt/duplicate checks.
 *  - A click is not success: Applied is set ONLY on a verified confirmation receipt.
 *  - SUBMITTED_UNVERIFIED is terminal-until-reviewed: no blind retry, ever.
 *  - No PII in audit detail; only identifiers, counts, statuses, fingerprints.
 */

import type { Database } from 'better-sqlite3';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { getActiveSessionForAttempt } from '../browserCompanion/companionStore.js';
import { randomToken, sha256Hex } from './crypto.js';
import { getAllJobs, getJobById, updateJobInStorage } from '../storage/fileStorage.js';
import {
  computeSubmissionDecision,
  loadSubmissionConfig,
  describeBlocker,
  type SubmissionBlocker,
  type SubmissionDecision,
  type SubmissionInputs,
  type SubmissionMode,
} from './submissionPolicy.js';
import {
  createSubmitOrder,
  getAutoApplyPreferences,
  getLatestVerificationEvidence,
  getReceiptByAttempt,
  hasVerifiedReceiptForJob,
  logSubmissionEvent,
  saveSubmissionReceipt,
  type AutoApplyPreferences,
  type VerificationEvidence,
} from './submissionStore.js';

const CONFIRMATION_TYPES = new Set(['THANK_YOU_PAGE', 'SUCCESS_MESSAGE', 'CONFIRMATION_ROUTE']);
const ORDER_TTL_MS = 10 * 60 * 1000;

const field = (obj: unknown, ...names: string[]): unknown => {
  const o = obj as Record<string, unknown> | null;
  if (!o) return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
};
const canonUrl = (u: unknown): string =>
  String(u || '').trim().split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
const flag = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const blockersOf = (d: SubmissionDecision): SubmissionBlocker[] => ('blockerCodes' in d ? d.blockerCodes : []);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export interface SubmissionContext {
  userId: string;
  attemptId: string;
  attemptStatus: string;
  provider: string;
  postingId: string;
  jobId: string;
  planFingerprint: string;
  requirementsFingerprint: string;
  packageSnapshotHash: string;
  sessionId: string | null;
  sessionBound: boolean;
  sessionUrl: string;
  resumeHash: string;
  evidence: VerificationEvidence | null;
  mode: SubmissionMode;
}

function loadContext(db: Database, userId: string, attemptId: string): SubmissionContext | null {
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) return null;
  const status = String(field(attempt, 'status') || '');
  const provider = String(field(attempt, 'provider') || '');
  const postingId = String(field(attempt, 'externalJobId', 'external_job_id') || '');
  const planFingerprint = String(field(attempt, 'planFingerprint', 'plan_fingerprint') || '');
  const requirementsFingerprint = String(field(attempt, 'requirementsFingerprint', 'requirements_fingerprint') || '');
  const packageSnapshotHash = String(field(attempt, 'packageSnapshotHash', 'package_snapshot_hash') || '');
  const session = getActiveSessionForAttempt(db, attemptId);
  const evidence = getLatestVerificationEvidence(db, attemptId);
  const jobId = session ? resolveJobId(session.canonicalActionUrl, userId) : '';
  return {
    userId,
    attemptId,
    attemptStatus: status,
    provider,
    postingId,
    jobId,
    planFingerprint,
    requirementsFingerprint,
    packageSnapshotHash,
    sessionId: session ? session.sessionId : null,
    sessionBound: !!session && !session.terminal,
    sessionUrl: session ? session.canonicalActionUrl : '',
    resumeHash: session ? session.resumeArtifactHash : '',
    evidence,
    mode: 'manual_review',
  };
}

/** Best-effort job linkage via the exact application URL the session was minted against. */
function resolveJobId(canonicalActionUrl: string, userId: string): string {
  const target = canonUrl(canonicalActionUrl);
  if (!target) return '';
  try {
    const jobs = getAllJobs() as any[];
    const match = jobs.find(
      (j) => String(j.userId || '') === userId && (canonUrl(j.applyUrl) === target || canonUrl(j.url) === target)
    );
    return match ? String(match.id) : '';
  } catch {
    return '';
  }
}

/** Effective mode: safe_auto requires config gate + user opt-in + promoted flag, else clamp down. */
function effectiveMode(configMode: SubmissionMode, prefs: AutoApplyPreferences): SubmissionMode {
  let mode = configMode;
  if (mode === 'safe_auto') {
    const promoted = loadSubmissionConfig().safeAutoPromoted;
    if (!(promoted && prefs.autoSubmitEnabled && prefs.mode === 'safe_auto')) mode = 'explicit_approval';
  }
  return mode;
}

function buildInputs(db: Database, ctx: SubmissionContext, config = loadSubmissionConfig()): { inputs: SubmissionInputs; prefs: AutoApplyPreferences } {
  const prefs = getAutoApplyPreferences(db, ctx.userId);
  const mode = effectiveMode(config.mode, prefs);
  const ev = ctx.evidence;
  const fingerprintsMatch = (e: string | undefined, a: string): boolean => (e ? e === a : true); // evidence fingerprint optional; READY transition is backend-authoritative
  const inputs: SubmissionInputs = {
    provider: ctx.provider,
    mode,
    submitFeatureEnabled: config.enabled,
    safeAutoPromoted: config.safeAutoPromoted,
    userAutoSubmitEnabled: prefs.autoSubmitEnabled,
    postingMatches: ctx.sessionBound && !!ctx.sessionUrl,
    planFingerprintMatches: fingerprintsMatch(ev?.planFingerprint, ctx.planFingerprint),
    requirementsFingerprintMatches: fingerprintsMatch(ev?.requirementsFingerprint, ctx.requirementsFingerprint),
    sessionBound: ctx.sessionBound,
    attemptReady: ctx.attemptStatus === 'READY_FOR_USER_SUBMISSION',
    verificationPresent: !!ev && ev.statuses.length > 0,
    statuses: ev?.statuses || '',
    resumeVerified: !!ev?.resumeVerified,
    captchaPending: !!ev?.captchaPending,
    otpPending: !!ev?.otpPending,
    mfaPending: !!ev?.mfaPending,
    loginPending: !!ev?.loginPending,
    newRequiredFields: ev?.newRequiredCount || 0,
    formMutatedSinceVerification: !!ev?.formMutated,
    requiredConsentUnapproved: !!ev?.consentUnapproved,
    eeoRequiresReview: !!ev?.eeoReview,
    legalAttestationUnapproved: !!ev?.legalUnapproved,
    unapprovedGeneratedAnswers: ev?.unapprovedAnswers || 0,
    staleBankAnswers: ev?.staleAnswers || 0,
    alreadySubmitted:
      ctx.attemptStatus === 'SUBMITTED' ||
      !!getReceiptByAttempt(db, ctx.attemptId) ||
      (!!ctx.jobId && hasVerifiedReceiptForJob(db, ctx.userId, ctx.jobId)),
    priorUnverified: ctx.attemptStatus === 'SUCCESS_UNCONFIRMED',
  };
  // Package drift is a form-change signal (session hash vs attempt hash).
  if (ev && ev.packageSnapshotHash && ev.packageSnapshotHash !== ctx.packageSnapshotHash) {
    inputs.formMutatedSinceVerification = true;
  }
  return { inputs, prefs };
}

export interface DecisionResult {
  config: ReturnType<typeof loadSubmissionConfig>;
  preferences: AutoApplyPreferences;
  decision: SubmissionDecision;
  attemptStatus: string;
  jobId: string;
  postingId: string;
  sessionBound: boolean;
}

export function createSubmissionDecision(db: Database, userId: string, attemptId: string): DecisionResult | null {
  const ctx = loadContext(db, userId, attemptId);
  if (!ctx) return null;
  const config = loadSubmissionConfig();
  const { inputs, prefs } = buildInputs(db, ctx, config);
  const decision = computeSubmissionDecision(inputs);
  logSubmissionEvent(
    db,
    userId,
    attemptId,
    'SUBMISSION_DECISION_CREATED',
    decision.allowed ? `allowed=${decision.mode}` : `blocked=${blockersOf(decision).join(',')}`
  );
  return {
    config,
    preferences: prefs,
    decision,
    attemptStatus: ctx.attemptStatus,
    jobId: ctx.jobId,
    postingId: ctx.postingId,
    sessionBound: ctx.sessionBound,
  };
}

export interface BeginSubmissionResult {
  ok: boolean;
  mode?: 'EXPLICIT_APPROVAL' | 'SAFE_AUTO';
  blockerCodes?: SubmissionBlocker[];
  message?: string;
  sessionId?: string;
  attemptId?: string;
}

/**
 * Explicit approval: the user has clicked [Submit Application].
 * Final revalidation → CAS to SUBMITTING → single-use order for the live session.
 */
export function beginExplicitSubmission(db: Database, userId: string, attemptId: string): BeginSubmissionResult {
  const config = loadSubmissionConfig();
  if (!config.enabled || config.mode === 'manual_review') {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_BLOCKED', 'SUBMIT_DISABLED');
    return { ok: false, blockerCodes: ['SUBMIT_DISABLED'], message: describeBlocker('SUBMIT_DISABLED') };
  }

  const first = createSubmissionDecision(db, userId, attemptId);
  if (!first) return { ok: false, blockerCodes: ['ATTEMPT_NOT_READY'], message: 'Unknown attempt.' };
  if (!first.decision.allowed) {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_BLOCKED', blockersOf(first.decision).join(','));
    return {
      ok: false,
      blockerCodes: blockersOf(first.decision),
      message: describeBlocker(blockersOf(first.decision)[0]),
    };
  }

  // ---- FINAL PRE-SUBMIT REVALIDATION (§9): never trust the earlier verdict blindly. ----
  logSubmissionEvent(db, userId, attemptId, 'FINAL_REVALIDATION_STARTED');
  const ctx = loadContext(db, userId, attemptId);
  if (!ctx) return { ok: false, blockerCodes: ['ATTEMPT_NOT_READY'], message: 'Unknown attempt.' };
  const { inputs } = buildInputs(db, ctx, config);
  const fresh = computeSubmissionDecision(inputs);
  if (!fresh.allowed) {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_BLOCKED', `revalidation=${blockersOf(fresh).join(',')}`);
    return { ok: false, blockerCodes: blockersOf(fresh), message: describeBlocker(blockersOf(fresh)[0]) };
  }
  const session = getActiveSessionForAttempt(db, attemptId);
  if (!session || session.terminal) {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_BLOCKED', 'SESSION_STALE');
    return { ok: false, blockerCodes: ['SESSION_STALE'], message: describeBlocker('SESSION_STALE') };
  }
  const orderPayload = {
    v: 1,
    attemptId,
    sessionId: session.sessionId,
    provider: ctx.provider,
    postingId: ctx.postingId,
    planFingerprint: ctx.planFingerprint,
    requirementsFingerprint: ctx.requirementsFingerprint,
    packageSnapshotHash: ctx.packageSnapshotHash,
    url: session.canonicalActionUrl,
    expiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
  };
  logSubmissionEvent(db, userId, attemptId, 'FINAL_REVALIDATION_PASSED');

  // ---- Idempotency anchor: compare-and-swap READY → SUBMITTING exactly once. ----
  const nowIso = new Date().toISOString();
  const cas = db
    .prepare(
      `UPDATE application_attempts SET status = 'SUBMITTING', updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'READY_FOR_USER_SUBMISSION'`
    )
    .run(nowIso, attemptId, userId);
  if (cas.changes !== 1) {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_BLOCKED', 'ATTEMPT_NOT_READY_OR_IN_FLIGHT');
    return { ok: false, blockerCodes: ['ATTEMPT_NOT_READY'], message: 'Submission is not available for this attempt.' };
  }

  createSubmitOrder(db, { id: `sub-${randomToken().slice(0, 24)}`, sessionId: session.sessionId, attemptId, userId, payload: orderPayload });
  logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_STARTED', `mode=${first.decision.mode}`);
  return { ok: true, mode: first.decision.mode, sessionId: session.sessionId, attemptId };
}

/**
 * Outcome intake. Called AFTER companionService has applied its authoritative
 * attempt transition, so `attempt.status` is already the post-event status.
 */
export function handleSubmissionOutcome(
  db: Database,
  userId: string,
  attemptId: string,
  eventType: string,
  metadata: Record<string, string>
): void {
  const existing = getReceiptByAttempt(db, attemptId);
  if (eventType === 'SUBMISSION_CONFIRMED') {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_CONFIRMATION_DETECTED', `evidence=${String(metadata.confirmationEvidenceType || '').slice(0, 32)}`);
    if (existing) {
      logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_VERIFIED', 'receipt=existing');
      return;
    }
    const ctx = loadContext(db, userId, attemptId);
    const submittedAt = new Date().toISOString();
    const rawFp = String(metadata.confirmationFingerprint || '');
    const confirmationFingerprint = /^[0-9a-f]{8,64}$/i.test(rawFp) ? rawFp.toLowerCase() : sha256Hex(`${attemptId}:${submittedAt}`);
    const confirmationType = CONFIRMATION_TYPES.has(String(metadata.confirmationType || ''))
      ? (String(metadata.confirmationType) as 'THANK_YOU_PAGE' | 'SUCCESS_MESSAGE' | 'CONFIRMATION_ROUTE')
      : String(metadata.confirmationEvidenceType || '') === 'SUCCESS_TEXT'
        ? 'SUCCESS_MESSAGE'
        : 'THANK_YOU_PAGE';
    const jobId = ctx?.jobId || '';
    saveSubmissionReceipt(db, {
      id: `rcpt-${randomToken().slice(0, 24)}`,
      attemptId,
      userId,
      jobId,
      provider: ctx?.provider || 'lever',
      postingId: ctx?.postingId || '',
      submittedAt,
      confirmationType,
      confirmationFingerprint,
      resumeHash: ctx?.resumeHash || '',
      submissionVerified: true,
      createdAt: submittedAt,
    });
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_VERIFIED', `type=${confirmationType};job=${jobId ? 'linked' : 'unlinked'}`);
    // Job → Applied ONLY here: verified provider confirmation + persisted receipt.
    if (jobId) {
      try {
        const job = getJobById(jobId) as any;
        if (job && String(job.state || '') !== 'applied') updateJobInStorage({ ...job, state: 'applied' } as any);
      } catch {
        logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_VERIFIED', 'job_update_failed');
      }
    }
    return;
  }
  if (eventType === 'SUBMISSION_UNCONFIRMED') {
    // Click happened (or may have happened) but success is unproven. NO retry. No receipt.
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_UNVERIFIED', `reason=${String(metadata.failureCategory || 'UNKNOWN').slice(0, 48)}`);
    return;
  }
  if (eventType === 'SUBMISSION_FAILED') {
    logSubmissionEvent(db, userId, attemptId, 'SUBMISSION_FAILED', `reason=${String(metadata.failureCategory || 'UNKNOWN').slice(0, 48)}`);
  }
}

export interface SubmissionStatus {
  state: 'NOT_SUBMITTED' | 'SUBMITTING' | 'SUBMITTED' | 'SUBMITTED_UNVERIFIED' | 'FAILED';
  receipt: { confirmationType: string; submittedAt: string; submissionVerified: true; postingId: string } | null;
  attemptStatus: string;
}

export function submissionStatusFor(db: Database, userId: string, attemptId: string): SubmissionStatus | null {
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) return null;
  const status = String(field(attempt, 'status') || '');
  const receipt = getReceiptByAttempt(db, attemptId);
  let state: SubmissionStatus['state'] = 'NOT_SUBMITTED';
  if (status === 'SUBMITTING') state = 'SUBMITTING';
  else if (status === 'SUBMITTED') state = receipt && receipt.submissionVerified ? 'SUBMITTED' : 'SUBMITTED_UNVERIFIED';
  else if (status === 'SUCCESS_UNCONFIRMED') state = 'SUBMITTED_UNVERIFIED';
  else if (status === 'FAILED') state = 'FAILED';
  return {
    state,
    receipt: receipt
      ? { confirmationType: receipt.confirmationType, submittedAt: receipt.submittedAt, submissionVerified: true, postingId: receipt.postingId }
      : null,
    attemptStatus: status,
  };
}

/** Map raw metadata (strings from the extension) into compact evidence. Used by the events hook. */
export function evidenceFromMetadata(metadata: Record<string, string>): { statuses: string } & Record<string, unknown> {
  return {
    statuses: String(metadata.statuses || ''),
    resumeVerified: flag(metadata.resumeVerified),
    captchaPending: flag(metadata.captchaPending),
    otpPending: flag(metadata.otpPending),
    mfaPending: flag(metadata.mfaPending),
    loginPending: flag(metadata.loginPending),
    newRequiredCount: num(metadata.newRequiredCount),
    formMutated: flag(metadata.formMutated),
    consentUnapproved: flag(metadata.consentUnapproved),
    eeoReview: flag(metadata.eeoReview),
    legalUnapproved: flag(metadata.legalUnapproved),
    unapprovedAnswers: num(metadata.unapprovedAnswers),
    staleAnswers: num(metadata.staleAnswers),
    planFingerprint: String(metadata.planFingerprint || ''),
    requirementsFingerprint: String(metadata.requirementsFingerprint || ''),
    packageSnapshotHash: String(metadata.packageSnapshotHash || ''),
  };
}
