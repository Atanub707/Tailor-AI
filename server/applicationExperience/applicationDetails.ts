// Application Experience V1 — application details (approved content for the
// user: answers to copy + exact package resume link). User-scoped.
import type { Database } from 'better-sqlite3';
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { getEventsForAttempt } from './applicationEvents.js';

export interface ApplicationDetails {
  applicationId: string;
  jobTitle: string;
  company: string;
  provider: string;
  userConfirmed?: { confirmedAt: string; source: 'USER' };
  answeredFields: Array<{ label: string; value: string }>;
  optionalOmittedCount: number;
  consentReviewCount: number;
  resume: { artifactHash: string; downloadUrl: string } | null;
  lastUpdated: string;
}

export function applicationDetails(db: Database, userId: string, applicationId: string): ApplicationDetails | null {
  const pkg = getPackageById(userId, applicationId);
  if (!pkg) return null;
  // Latest plan for the package
  const planRows = db.prepare('SELECT data FROM submission_plans WHERE user_id = ? AND package_id = ? ORDER BY created_at DESC LIMIT 1').all(userId, applicationId) as any[];
  const plan: SubmissionPlan | undefined = planRows.length ? JSON.parse(planRows[0].data) : undefined;
  const attempt = plan ? getAttempt(db, userId, getLatestAttemptId(db, userId, plan.id) ?? '') : undefined;
  const events = plan && attempt ? getEventsForAttempt(db, userId, attempt.id) : [];
  const confirmed = events.find((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED');
  const answeredFields = plan
    ? plan.mappedFields
        .filter((m) => m.value !== null && m.value !== undefined)
        .map((m) => ({ label: m.label || m.canonicalKey || m.providerFieldId, value: Array.isArray(m.value) ? m.value.join(', ') : String(m.value) }))
    : [];
  return {
    applicationId,
    jobTitle: plan?.target.title ?? pkg.jobSnapshot.title,
    company: plan?.target.company ?? pkg.jobSnapshot.company,
    provider: plan?.provider ?? pkg.jobSnapshot.platform ?? 'unknown',
    userConfirmed: confirmed
      ? { confirmedAt: confirmed.metadata.confirmedAt ?? confirmed.createdAt, source: 'USER' }
      : undefined,
    answeredFields,
    optionalOmittedCount: plan?.unresolvedDetails.filter((d) => !d.required).length ?? 0,
    consentReviewCount: plan?.consentFields.filter((c) => ['LEGAL_CONSENT', 'REQUIRED_ACKNOWLEDGEMENT', 'UNKNOWN_CONSENT'].includes(c.classification as string)).length ?? 0,
    resume: pkg.resumeSnapshot?.pdfHash
      ? { artifactHash: pkg.resumeSnapshot.pdfHash, downloadUrl: `/api/application-packages/${pkg.id}/resume.pdf` }
      : null,
    lastUpdated: attempt?.updatedAt ?? plan?.updatedAt ?? pkg.updatedAt,
  };
}

function getLatestAttemptId(db: Database, userId: string, planId: string): string | undefined {
  const row = db.prepare('SELECT id FROM application_attempts WHERE user_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 1').get(userId, planId) as any;
  return row?.id;
}