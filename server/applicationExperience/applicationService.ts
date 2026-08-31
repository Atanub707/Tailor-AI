// Application Experience V1 — dashboard service: summaries (no N+1),
// verified provider handoff, manual user confirmation. User-scoped.
import type { Database } from 'better-sqlite3';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import type { ApplicationAttempt } from '../applicationEngine/executionContract.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { getAttempt, getAttemptsByExecutionKey, getApprovalsByPlan, executionKey } from '../applicationEngine/executionStore.js';
import { ensureEventSchema, appendEvent, getEventTypesForAttempt } from './applicationEvents.js';
import { createApproval, prepareExecution } from '../applicationEngine/executionEngine.js';
import {
  availableActions, humanCheckpointFrom, mapApplicationStatus,
} from './applicationStatus.js';
import type { AvailableAction, HumanCheckpoint, UserApplicationStatus } from './applicationStatus.js';

export class ExperienceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExperienceError';
  }
}

export interface ApplicationSummary {
  applicationId: string;
  planId?: string;
  attemptId?: string;
  jobId: string;
  jobTitle: string;
  company: string;
  provider: string;
  userStatus: UserApplicationStatus;
  checkpoint: HumanCheckpoint | null;
  availableActions: AvailableAction[];
  updatedAt: string;
  jobUrl?: string;
}

/** Canonical Lever application URL validation (server-side, allowlisted). */
export function verifiedLeverActionUrl(applyUrl: string | undefined, externalJobId?: string): string | null {
  if (!applyUrl) return null;
  let u: URL;
  try {
    u = new URL(applyUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'jobs.lever.co' && !host.endsWith('.jobs.lever.co')) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  // Canonical application URL = the /apply page. Indexed jobs may store the
  // job-page URL — normalize deterministically to the apply page.
  let path = u.pathname;
  if (seg[seg.length - 1] !== 'apply') {
    if (seg.length !== 2) return null; // only /{site}/{postingId} job pages normalize
    path = `${u.pathname.replace(/\/+$/, '')}/apply`;
  }
  const urlJobId = seg[seg.length - 1] === 'apply' ? seg[seg.length - 2] : seg[seg.length - 1];
  // The local index prefixes external ids with the provider slug (lev-…).
  const normalizedExternal = String(externalJobId || '').replace(/^(lev|gh|ashby)-/, '');
  if (externalJobId && normalizedExternal && urlJobId !== normalizedExternal) return null;
  return `${u.protocol}//${u.host}${path}`;
}

interface Row {
  pkg: ApplicationPackage;
  plan: SubmissionPlan | undefined;
  attempt: ApplicationAttempt | undefined;
  eventTypes: Set<string>;
}

/** Dashboard summaries — derived from canonical entities (packages + plans +
 *  attempts + events); no new application table. Batched queries, no N+1. */
export function applicationSummaries(db: Database, userId: string): ApplicationSummary[] {
  ensureEventSchema(db);
  const pkgRows = db.prepare('SELECT data FROM application_packages WHERE user_id = ? ORDER BY rowid DESC').all(userId) as any[];
  if (!pkgRows.length) return [];
  const pkgIds = pkgRows.map((r) => JSON.parse(r.data).id);
  const placeholders = pkgIds.map(() => '?').join(',');
  const planRows = db.prepare(`SELECT data FROM submission_plans WHERE user_id = ? AND package_id IN (${placeholders})`).all(userId, ...pkgIds) as any[];
  const planByPackage = new Map<string, SubmissionPlan>();
  for (const r of planRows) {
    const plan = JSON.parse(r.data) as SubmissionPlan;
    const existing = planByPackage.get(plan.packageId);
    if (!existing || plan.createdAt > existing.createdAt) planByPackage.set(plan.packageId, plan);
  }
  const planIds = [...planByPackage.values()].map((p) => p.id);
  const planPlaceholders = planIds.map(() => '?').join(',');
  const attemptRows = planIds.length
    ? db.prepare(`SELECT * FROM application_attempts WHERE user_id = ? AND plan_id IN (${planPlaceholders})`).all(userId, ...planIds) as any[]
    : [];
  const attemptByPlan = new Map<string, ApplicationAttempt>();
  for (const r of attemptRows) {
    const a = attemptFromRow(r);
    const existing = attemptByPlan.get(a.planId);
    if (!existing || a.createdAt > existing.createdAt) attemptByPlan.set(a.planId, a);
  }
  const eventRows = attemptRows.length
    ? db.prepare(`SELECT * FROM application_events WHERE user_id = ? AND attempt_id IN (${attemptRows.map(() => '?').join(',')})`).all(userId, ...attemptRows.map((r) => r.id)) as any[]
    : [];
  const eventsByAttempt = new Map<string, Set<string>>();
  for (const r of eventRows) {
    if (!eventsByAttempt.has(r.attempt_id)) eventsByAttempt.set(r.attempt_id, new Set());
    eventsByAttempt.get(r.attempt_id)!.add(r.event_type);
  }
  // Manual "I applied" records live under synthetic attempt ids (manual-<pkgId>)
  // so plan-less / unsupported-provider applications stay trackable.
  const manualRows = db.prepare(`SELECT attempt_id, event_type FROM application_events WHERE user_id = ? AND attempt_id LIKE 'manual-%'`).all(userId) as any[];
  const manualByPackage = new Map<string, Set<string>>();
  for (const r of manualRows) {
    const pkgId = r.attempt_id.replace('manual-', '');
    if (!manualByPackage.has(pkgId)) manualByPackage.set(pkgId, new Set());
    manualByPackage.get(pkgId)!.add(r.event_type);
  }

  const rows: Row[] = [];
  for (const p of pkgRows) {
    const pkg = JSON.parse(p.data);
    const plan = planByPackage.get(pkg.id);
    const attempt = plan ? attemptByPlan.get(plan.id) : undefined;
    const eventTypes = attempt ? eventsByAttempt.get(attempt.id) ?? new Set<string>() : new Set<string>();
    const manual = manualByPackage.get(pkg.id);
    if (manual) for (const t of manual) eventTypes.add(t);
    rows.push({ pkg, plan, attempt, eventTypes });
  }
  return rows.map((r) => buildSummary(r));
}

function buildSummary(r: Row): ApplicationSummary {
  const pkg = r.pkg;
  const plan = r.plan;
  const attempt = r.attempt;
  const hasHandoff = r.eventTypes.has('PROVIDER_HANDOFF');
  const hasUserConfirmed = r.eventTypes.has('USER_CONFIRMED_SUBMITTED');
  const job = pkg.jobSnapshot ?? {} as any;
  const jobUrl = (job as any).applyUrl || (job as any).jobUrl || (plan?.target as any)?.jobUrl || '';
  if (!plan) {
    // Package prepared but not yet started — the Apply handoff target.
    // A manual "I applied" record (USER_CONFIRMED_SUBMITTED under the
    // synthetic manual-<pkgId> attempt) upgrades it to APPLIED so the
    // 3-second Applied toggle flows into a real tracker row.
    const manualConfirmed = r.eventTypes.has('USER_CONFIRMED_SUBMITTED');
    return {
      applicationId: pkg.id,
      planId: undefined,
      attemptId: undefined,
      jobId: String((job as any).externalJobId || pkg.jobId),
      jobTitle: String((job as any).title || 'Job'),
      company: String((job as any).company || ''),
      provider: String((job as any).platform || (job as any).source || 'Unknown'),
      userStatus: manualConfirmed ? 'APPLIED' : 'PREPARING',
      checkpoint: null,
      availableActions: manualConfirmed ? [] : ['START_APPLICATION'],
      updatedAt: pkg.updatedAt,
      jobUrl,
    };
  }
  const status = mapApplicationStatus({ plan, attempt, hasHandoffEvent: hasHandoff, hasUserConfirmedEvent: hasUserConfirmed });
  const reason = attempt?.failure?.kind ?? (plan.status === 'NEEDS_REVIEW' ? (plan.consentFields.length ? 'CONSENT_REQUIRED' : 'REQUIRED_QUESTION') : undefined);
  const checkpoint = status === 'ACTION_REQUIRED' || status === 'WAITING_FOR_YOU' ? humanCheckpointFrom(reason, plan.provider, plan) : null;
  return {
    applicationId: plan.packageId,
    planId: plan.id,
    attemptId: attempt?.id,
    jobId: plan.target.externalJobId || plan.target.jobUrl || plan.packageId,
    jobTitle: plan.target.title,
    company: plan.target.company,
    provider: plan.provider,
    userStatus: status,
    checkpoint,
    availableActions: availableActions(status, checkpoint?.type),
    updatedAt: attempt?.updatedAt ?? plan.updatedAt,
    jobUrl: jobUrl || plan.target.jobUrl || plan.target.applyUrl || '',
  };
}

export interface StartResult {
  summary: ApplicationSummary;
  started: boolean;
  reason?: string;
}

/** PRODUCT command: orchestrates approval + fresh reinspection + execution
 *  preparation from ONE user action. Idempotent: repeated/concurrent starts
 *  reuse the durable attempt (SQLite unique execution key) and never make
 *  unnecessary provider calls. Never bypasses consent/EEO/manual review —
 *  non-READY plans return their existing state without an attempt. */
export async function startApplication(db: Database, userId: string, applicationId: string): Promise<StartResult> {
  ensureEventSchema(db);
  const pkg = getPackageById(userId, applicationId);
  if (!pkg) throw new ExperienceError('NOT_FOUND', 'Application not found.');
  const planRows = db.prepare('SELECT data FROM submission_plans WHERE user_id = ? AND package_id = ? ORDER BY created_at DESC LIMIT 1').all(userId, applicationId) as any[];
  const plan: SubmissionPlan | undefined = planRows.length ? JSON.parse(planRows[0].data) : undefined;
  if (!plan) throw new ExperienceError('NEEDS_PREPARATION', 'This application needs to be prepared first.');
  // Human review boundaries are NEVER bypassed: non-READY plans return their
  // authoritative state (Preparing / Action Required) without approval or
  // attempt creation.
  if (plan.status !== 'READY_TO_SUBMIT') {
    return { summary: applicationSummaries(db, userId).find((x) => x.applicationId === applicationId)!, started: false, reason: 'PLAN_NOT_READY' };
  }
  // Idempotency: an existing attempt for this execution identity wins.
  const existingAttempts = getAttemptsByExecutionKey(db, executionKey({ userId, provider: plan.provider, externalJobId: plan.target.externalJobId, packageSnapshotHash: pkg.snapshotHash, planFingerprint: plan.planFingerprint }));
  if (existingAttempts.length) {
    return { summary: applicationSummaries(db, userId).find((x) => x.applicationId === applicationId)!, started: false, reason: 'ALREADY_STARTED' };
  }
  // Approval semantics preserved: reuse an existing ACTIVE approval for this
  // plan (never a blanket new approval); consent decisions come only from the
  // plan's explicit fields — marketing defaults to omitted, legal/unknown
  // consent would have kept the plan out of READY (never auto-accepted).
  const existingApproval = getApprovalsByPlan(db, userId, plan.id).find((a) => a.status === 'ACTIVE');
  const consents = plan.consentFields
    .filter((c) => c.classification === 'OPTIONAL_MARKETING' || c.classification === 'OPTIONAL_COMMUNICATION')
    .map((c) => ({ providerFieldId: c.providerFieldId, classification: c.classification, selectedValue: false, approvedAt: '' }));
  const approval = existingApproval ?? createApproval({ db, userId, plan, pkg, consents, marketingOptIn: false });
  // fresh read-only reinspection + local preparation (single GET, existing engine)
  let reason: string | undefined;
  try {
    const prepared = await prepareExecution({ db, userId, plan, pkg, approval, marketingOptIn: false, omitTracking: true });
    reason = prepared.reason;
    appendEvent(db, { userId, attemptId: prepared.attempt.id, eventType: 'APPLICATION_STARTED', reasonCode: reason, metadata: { provider: plan.provider, externalJobId: plan.target.externalJobId, applicationId }, idempotencyId: `start-${prepared.attempt.id}` });
  } catch (e: any) {
    reason = e?.kind ?? 'UNKNOWN';
  }
  return { summary: applicationSummaries(db, userId).find((x) => x.applicationId === applicationId)!, started: true, reason };
}

/** Record a user-intended provider handoff and return the VERIFIED canonical
 *  action URL. Never marks the application as applied. Idempotent. */
export function recordHandoff(db: Database, userId: string, attemptId: string): { url: string; summary: ApplicationSummary } {
  ensureEventSchema(db);
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) throw new ExperienceError('NOT_FOUND', 'Application attempt not found.');
  const plan = getPlanById(userId, attempt.planId);
  if (!plan) throw new ExperienceError('NOT_FOUND', 'Plan not found.');
  if (plan.userId !== userId) throw new ExperienceError('FORBIDDEN', 'Not your application.');
  const url = verifiedLeverActionUrl(plan.target.applyUrl, plan.target.externalJobId);
  if (!url) throw new ExperienceError('INVALID_TARGET', 'Application target is not a verified Lever URL.');
  appendEvent(db, {
    userId,
    attemptId,
    eventType: 'PROVIDER_HANDOFF',
    reasonCode: attempt.failure?.kind,
    metadata: { provider: attempt.provider, externalJobId: attempt.externalJobId, handoffAt: new Date().toISOString() },
    idempotencyId: `${attempt.id}-handoff`,
  });
  return { url, summary: applicationSummaries(db, userId).find((s) => s.attemptId === attemptId)! };
}

/** Manual user confirmation — USER_CONFIRMED provenance, never a provider
 *  receipt. Requires a prior handoff; idempotent; cross-user blocked. */
/** Manual "I applied" record for applications with no attempt (plan-less or
 *  unsupported-provider packages). Durable via the events table with a
 *  synthetic attempt id; never fabricates provider evidence. */
export function markAppliedManually(db: Database, userId: string, applicationId: string): ApplicationSummary {
  ensureEventSchema(db);
  const pkg = getPackageById(userId, applicationId);
  if (!pkg) throw new ExperienceError('NOT_FOUND', 'Application not found.');
  appendEvent(db, {
    userId,
    attemptId: `manual-${applicationId}`,
    eventType: 'USER_CONFIRMED_SUBMITTED',
    reasonCode: 'USER_CONFIRMED',
    metadata: { provider: String(pkg.jobSnapshot?.platform || pkg.jobSnapshot?.source || ''), externalJobId: String(pkg.jobSnapshot?.externalJobId || ''), confirmationSource: 'USER_MANUAL', confirmedAt: new Date().toISOString() },
    idempotencyId: `manual-${applicationId}-user-confirmed`,
  });
  return applicationSummaries(db, userId).find((s) => s.applicationId === applicationId)!;
}

export function confirmUserSubmitted(db: Database, userId: string, attemptId: string): ApplicationSummary {
  ensureEventSchema(db);
  const attempt = getAttempt(db, userId, attemptId);
  if (!attempt) throw new ExperienceError('NOT_FOUND', 'Application attempt not found.');
  const types = getEventTypesForAttempt(db, userId, attemptId);
  if (!types.has('PROVIDER_HANDOFF')) {
    throw new ExperienceError('NOT_HANDED_OFF', 'This application has not been handed off to the provider yet.');
  }
  appendEvent(db, {
    userId,
    attemptId,
    eventType: 'USER_CONFIRMED_SUBMITTED',
    reasonCode: 'USER_CONFIRMED',
    metadata: { provider: attempt.provider, externalJobId: attempt.externalJobId, confirmationSource: 'USER', confirmedAt: new Date().toISOString() },
    idempotencyId: `${attempt.id}-user-confirmed`,
  });
  return applicationSummaries(db, userId).find((s) => s.attemptId === attemptId)!;
}

export function attemptFromRow(row: any): ApplicationAttempt {
  return {
    id: row.id, userId: row.user_id, planId: row.plan_id, packageId: row.package_id,
    approvalId: row.approval_id, provider: row.provider, externalJobId: row.external_job_id,
    executionKey: row.execution_key, planFingerprint: row.plan_fingerprint,
    packageSnapshotHash: row.package_snapshot_hash, requirementsFingerprint: row.requirements_fingerprint,
    status: row.status, transportAttemptCount: row.transport_attempt_count,
    verification: row.verification_json ? JSON.parse(row.verification_json) : undefined,
    failure: row.failure_json ? JSON.parse(row.failure_json) : undefined,
    startedAt: row.started_at, finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

