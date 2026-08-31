// Application Engine V1 — SubmissionPlan persistence.
// Immutable plans: READY_TO_SUBMIT plans are frozen; revisions create new
// plan rows. SQLite, same patterns as application_packages.

import { getDb } from '../storage/fileStorage.js';
import { createHash } from 'node:crypto';
import type { PlanStatus, Provider, SubmissionPlan } from './contract.js';

export function ensurePlanSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS submission_plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      package_snapshot_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      requirements_fingerprint TEXT NOT NULL,
      plan_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_user_pkg ON submission_plans (user_id, package_id);
    CREATE INDEX IF NOT EXISTS idx_plans_user_status ON submission_plans (user_id, status);
  `);
}

/** SHA-256 over stable, submission-relevant frozen content only. */
export function planFingerprint(pkgSnapshotHash: string, provider: Provider, targetIdentity: string, requirementsFingerprint: string, mapped: string, files: string, consent: string, manual: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ pkgSnapshotHash, provider, targetIdentity, requirementsFingerprint, mapped, files, consent, manual }))
    .digest('hex');
}

export function nextPlanRevision(userId: string, packageId: string): number {
  ensurePlanSchema();
  const row = getDb().prepare('SELECT COUNT(*) c FROM submission_plans WHERE user_id = ? AND package_id = ?').get(userId, packageId) as { c: number };
  return (row?.c ?? 0) + 1;
}

export function storePlan(plan: SubmissionPlan): SubmissionPlan {
  ensurePlanSchema();
  // UPSERT: repeated answer saves re-persist the same plan id (idempotent);
  // a plain INSERT would raise UNIQUE constraint failures on updates.
  getDb().prepare(`
    INSERT INTO submission_plans (
      id, user_id, package_id, package_snapshot_hash, provider,
      requirements_fingerprint, plan_fingerprint, status, data, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      package_snapshot_hash = excluded.package_snapshot_hash,
      provider = excluded.provider,
      requirements_fingerprint = excluded.requirements_fingerprint,
      plan_fingerprint = excluded.plan_fingerprint,
      status = excluded.status,
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(plan.id, plan.userId, plan.packageId, plan.packageSnapshotHash, plan.provider, plan.requirementsFingerprint, plan.planFingerprint, plan.status, JSON.stringify(plan), plan.createdAt, plan.updatedAt);
  return plan;
}

export function getPlanById(userId: string, planId: string): SubmissionPlan | undefined {
  ensurePlanSchema();
  const row = getDb().prepare('SELECT data FROM submission_plans WHERE user_id = ? AND id = ?').get(userId, planId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as SubmissionPlan) : undefined;
}

export function getLatestPlanForPackage(userId: string, packageId: string): SubmissionPlan | undefined {
  ensurePlanSchema();
  const row = getDb().prepare('SELECT data FROM submission_plans WHERE user_id = ? AND package_id = ? ORDER BY rowid DESC LIMIT 1').get(userId, packageId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as SubmissionPlan) : undefined;
}

export function createPlanId(userId: string, packageId: string, rev: number): string {
  return `plan-${userId.slice(-6)}-${packageId.slice(-10)}-r${rev}`;
}

export type { PlanStatus, SubmissionPlan };