// Application Engine V1 — provider-neutral orchestration.
// READY package → gate → target detection → read-only inspection →
// deterministic mapping → immutable SubmissionPlan → validation → dry-run
// preview. ZERO submission.

import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { ApplicationInspectionAdapter } from './fixtureAdapter.js';
import { targetFromJob, FixtureInspectionAdapter } from './fixtureAdapter.js';
import { LeverInspectionAdapter, InspectionFailure } from './leverInspector.js';
import { mapRequirements } from './mapper.js';
import {
  createPlanId, getLatestPlanForPackage, getPlanById, nextPlanRevision, planFingerprint, storePlan,
} from './planStore.js';
import type { PlanStatus, SubmissionPlan } from './contract.js';

export type GateError =
  | 'PACKAGE_NOT_READY' | 'PACKAGE_STALE' | 'PACKAGE_HASH_INVALID'
  | 'RESUME_ARTIFACT_MISSING' | 'RESUME_ARTIFACT_INVALID' | 'PACKAGE_NOT_FOUND';

export interface GateResult {
  ok: boolean;
  error?: GateError;
}

/** Hard gate — plan creation is refused unless the package is READY,
 *  not stale, hash-valid, and its exact PDF artifact is still intact. */
export function gatePackage(pkg: ApplicationPackage | undefined, artifactOk: boolean): GateResult {
  if (!pkg) return { ok: false, error: 'PACKAGE_NOT_FOUND' };
  if (pkg.status === 'STALE') return { ok: false, error: 'PACKAGE_STALE' };
  if (pkg.status !== 'READY') return { ok: false, error: 'PACKAGE_NOT_READY' };
  if (!pkg.snapshotHash) return { ok: false, error: 'PACKAGE_HASH_INVALID' };
  if (!pkg.resumeSnapshot?.pdfHash) return { ok: false, error: 'RESUME_ARTIFACT_MISSING' };
  if (!artifactOk) return { ok: false, error: 'RESUME_ARTIFACT_INVALID' };
  return { ok: true };
}

export interface PlanCreateInput {
  userId: string;
  pkg: ApplicationPackage;
  job: { atsPlatform?: string; applyUrl?: string; jobUrl?: string; url?: string; company?: string; title?: string; externalId?: string };
  adapter?: ApplicationInspectionAdapter;   // explicit injection (tests/dev fixtures)
  mode?: 'production' | 'fixture';          // fixture REQUIRES explicit adapter
  artifactOk: boolean;
}

/**
 * Adapter selection uses the RESOLVED TARGET PROVIDER — never the original
 * index source. Production: Lever target → real Lever inspector; anything
 * else → INSPECTION_NOT_IMPLEMENTED (fixtures are test/dev injection only).
 */
export function resolveAdapter(targetProvider: string, mode: 'production' | 'fixture', injected?: ApplicationInspectionAdapter): ApplicationInspectionAdapter {
  if (mode === 'fixture') {
    if (!injected) throw new InspectionFailure('CONFIGURATION', 'Fixture mode requires an explicit adapter injection.');
    return injected;
  }
  if (targetProvider === 'lever') return new LeverInspectionAdapter();
  throw new InspectionFailure('INSPECTION_NOT_IMPLEMENTED', `Live inspection not implemented for provider: ${targetProvider}`);
}

/** Resolve target + inspect requirements + map + persist plan (or reuse). */
export async function createPlan(input: PlanCreateInput): Promise<{ plan: SubmissionPlan; reused: boolean; gate: GateResult }> {
  const gate = gatePackage(input.pkg, input.artifactOk);
  if (!gate.ok) {
    throw new EngineGateError(gate.error!);
  }

  const target = targetFromJob(input.job);
  const adapter = resolveAdapter(target.provider, input.mode ?? 'production', input.adapter);
  // INVARIANT: plan.provider == adapter.provider == resolved target provider.
  const reqs = await adapterInspect(adapter, target);
  const mapping = mapRequirements(input.pkg, reqs.fields);

  // Deterministic plan fingerprint over frozen submission-relevant content.
  const targetIdentity = `${target.provider}|${target.externalJobId}|${target.applyUrl}`;
  const fp = planFingerprint(
    input.pkg.snapshotHash,
    reqs.provider,
    targetIdentity,
    reqs.fingerprint,
    JSON.stringify(mapping.mapped.map((m) => [m.providerFieldId, String(m.value ?? ''), m.mappingMethod].join('|'))),
    JSON.stringify(mapping.files),
    JSON.stringify(mapping.consent.map((c) => c.providerFieldId)),
    JSON.stringify(mapping.manual.map((m) => m.providerFieldId))
  );

  // Idempotency: identical package + requirements + mapped inputs → reuse.
  const latest = getLatestPlanForPackage(input.userId, input.pkg.id);
  if (latest && latest.planFingerprint === fp) {
    return { plan: latest, reused: true, gate };
  }

  const rev = nextPlanRevision(input.userId, input.pkg.id);
  const now = new Date().toISOString();
  const plan: SubmissionPlan = {
    id: createPlanId(input.userId, input.pkg.id, rev),
    userId: input.userId,
    packageId: input.pkg.id,
    packageSnapshotHash: input.pkg.snapshotHash,
    provider: reqs.provider,
    inspection: {
      adapter: adapter.constructor.name,
      version: (adapter as any).version ?? 'unknown',
      inspectedAt: now,
      url: target.applyUrl,
    },
    target,
    requirementsFingerprint: reqs.fingerprint,
    mappedFields: mapping.mapped,
    files: mapping.files,
    unresolvedFields: mapping.unresolved.filter((u) => u.required).map((u) => u.providerFieldId),
    unresolvedDetails: mapping.unresolved,
    consentFields: mapping.consent,
    manualFields: mapping.manual,
    status: computeStatus(mapping),
    planFingerprint: fp,
    createdAt: now,
    updatedAt: now,
  };
  storePlan(plan);
  return { plan, reused: false, gate };
}

export class EngineGateError extends Error {
  constructor(public readonly code: GateError) {
    super(`Package gate refused: ${code}`);
    this.name = 'EngineGateError';
  }
}

async function adapterInspect(adapter: ApplicationInspectionAdapter, target: ReturnType<typeof targetFromJob>): Promise<Awaited<ReturnType<ApplicationInspectionAdapter['inspect']>>> {
  return adapter.inspect(target);
}

/** Deterministic plan status with precedence UNSUPPORTED > NEEDS_REVIEW >
 *  NEEDS_INPUT > READY_TO_SUBMIT. */
export function computeStatus(mapping: { unresolved: Array<{ required: boolean }>; consent: unknown[]; manual: unknown[] }): PlanStatus {
  const requiredUnresolved = mapping.unresolved.filter((u) => u.required);
  if (mapping.manual.length > 0 || mapping.consent.length > 0) return 'NEEDS_REVIEW';
  if (requiredUnresolved.length > 0) return 'NEEDS_INPUT';
  return 'READY_TO_SUBMIT';
}

export interface DryRunPreview {
  provider: string;
  targetProvider: string;
  targetClassification: string;
  company: string;
  role: string;
  packageId: string;
  packageSnapshotHash: string;
  resume: { version?: number; artifactHash?: string; verified?: boolean } | null;
  mappedFields: Array<{ providerFieldId: string; label: string; value: string | number | boolean | string[] | null; source: string; mappingMethod: string; mappingConfidence: string }>;
  unresolved: Array<{ providerFieldId: string; label: string; required: boolean }>;
  consent: Array<{ providerFieldId: string; label: string; status: string }>;
  eeoManual: Array<{ providerFieldId: string; label: string }>;
  status: PlanStatus;
  planId: string;
  inspection: { adapter: string; version: string; inspectedAt: string; url: string } | null;
  fieldCount: number;
  requiredCount: number;
  resumeRequired: boolean;
  eeoPresent: boolean;
  consentPresent: boolean;
}

/** PURE preview — renders the persisted plan only. No network, no LLM,
 *  no mutations. */
export function buildPreview(plan: SubmissionPlan, pkg: ApplicationPackage): DryRunPreview {
  return {
    provider: plan.provider,
    targetProvider: plan.target.provider,
    targetClassification: plan.target.targetClassification ?? plan.target.redirectKind,
    company: plan.target.company,
    role: plan.target.title,
    packageId: plan.packageId,
    packageSnapshotHash: plan.packageSnapshotHash,
    resume: pkg.resumeSnapshot
      ? { version: pkg.resumeSnapshot.version, artifactHash: pkg.resumeSnapshot.pdfHash, verified: pkg.resumeSnapshot.pdfOk }
      : null,
    mappedFields: plan.mappedFields.map((m) => ({
      providerFieldId: m.providerFieldId, label: m.label, value: m.value ?? null, source: m.source,
      mappingMethod: m.mappingMethod, mappingConfidence: m.mappingConfidence,
    })),
    unresolved: plan.unresolvedDetails.map((u) => ({ providerFieldId: u.providerFieldId, label: u.label, required: u.required })),
    consent: plan.consentFields.map((c) => ({ providerFieldId: c.providerFieldId, label: c.label, status: c.status })),
    eeoManual: plan.manualFields.map((m) => ({ providerFieldId: m.providerFieldId, label: m.label })),
    status: plan.status,
    planId: plan.id,
    inspection: plan.inspection
      ? { adapter: plan.inspection.adapter, version: plan.inspection.version, inspectedAt: plan.inspection.inspectedAt, url: plan.inspection.url }
      : null,
    fieldCount: plan.mappedFields.length + plan.unresolvedDetails.length + plan.consentFields.length + plan.manualFields.length + plan.files.length,
    requiredCount: plan.mappedFields.filter((m) => m.required).length + plan.unresolvedDetails.filter((u) => u.required).length + plan.consentFields.filter((c) => c.required).length + plan.manualFields.filter((m) => m.required).length,
    resumeRequired: plan.files.some((f) => f.kind === 'RESUME'),
    eeoPresent: plan.manualFields.some((m) => /EEO|manual|review/i.test(m.reason || '')),
    consentPresent: plan.consentFields.length > 0,
  };
}

export { getPlanById };