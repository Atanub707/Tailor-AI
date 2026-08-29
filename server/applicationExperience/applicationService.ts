// Application Experience V1 — dashboard service: summaries (no N+1),
// verified provider handoff, manual user confirmation. User-scoped.
import type { Database } from 'better-sqlite3';
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import type { ApplicationAttempt } from '../applicationEngine/executionContract.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { getAttempt, getAttemptsByExecutionKey } from '../applicationEngine/executionStore.js';
import { ensureEventSchema, appendEvent, getEventTypesForAttempt } from './applicationEvents.js';
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
  applicationId: string;   // package id
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
  plan: SubmissionPlan;
  attempt?: ApplicationAttempt;
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

  const rows: Row[] = [];
  for (const p of pkgRows) {
    const pkg = JSON.parse(p.data);
    const plan = planByPackage.get(pkg.id);
    if (!plan) continue; // packages without a plan are preparation-only
    const attempt = attemptByPlan.get(plan.id);
    const eventTypes = attempt ? eventsByAttempt.get(attempt.id) ?? new Set<string>() : new Set<string>();
    rows.push({ plan, attempt, eventTypes });
  }
  return rows.map((r) => buildSummary(r));
}

function buildSummary(r: Row): ApplicationSummary {
  const plan = r.plan;
  const attempt = r.attempt;
  const hasHandoff = r.eventTypes.has('PROVIDER_HANDOFF');
  const hasUserConfirmed = r.eventTypes.has('USER_CONFIRMED_SUBMITTED');
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
  };
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

