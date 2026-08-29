// Application Experience V1 — application details (approved content for the
// user: answers to copy + exact package resume link). User-scoped.
import type { Database } from 'better-sqlite3';
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import { getAttempt, getApprovalsByPlan } from '../applicationEngine/executionStore.js';
import { getEventsForAttempt } from './applicationEvents.js';

export interface ApplicationDetails {
  applicationId: string;
  jobTitle: string;
  company: string;
  provider: string;
  userConfirmed?: { confirmedAt: string; source: 'USER' };
  answeredFields: Array<{ label: string; value: string }>;
  planId?: string;
  requiredQuestions: Array<{ providerFieldId: string; label: string; required: boolean; type: string; options: string[]; reason: string }>;
  optionalOmittedCount: number;
  consentReviewCount: number;
  consentFields: Array<{ providerFieldId: string; label: string; classification: string }>;
  reviewGroups: Array<{ title: string; items: Array<{ label: string; value: string; source: string }> }>;
  needsApproval: boolean;
  resume: { artifactHash: string; downloadUrl: string } | null;
  lastUpdated: string;
  events: Array<{ eventType: string; reasonCode?: string | null; createdAt: string; metadata: Record<string, string> }>;
}

export function applicationDetails(db: Database, userId: string, applicationId: string): ApplicationDetails | null {
  const pkg = getPackageById(userId, applicationId);
  if (!pkg) return null;
  // Latest plan for the package
  const planRows = db.prepare('SELECT data FROM submission_plans WHERE user_id = ? AND package_id = ? ORDER BY created_at DESC LIMIT 1').all(userId, applicationId) as any[];
  const plan: SubmissionPlan | undefined = planRows.length ? JSON.parse(planRows[0].data) : undefined;
  const attempt = plan ? getAttempt(db, userId, getLatestAttemptId(db, userId, plan.id) ?? '') : undefined;
  const events = plan && attempt ? getEventsForAttempt(db, userId, attempt.id) : [];
  const manualEvents = getEventsForAttempt(db, userId, `manual-${applicationId}`);
  const confirmed = events.find((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED') ?? manualEvents.find((e) => e.eventType === 'USER_CONFIRMED_SUBMITTED');
  const allEvents = [...events, ...manualEvents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const answeredFields = plan
    ? plan.mappedFields
        .filter((m) => m.value !== null && m.value !== undefined)
        .map((m) => ({ label: m.label || m.canonicalKey || m.providerFieldId, value: Array.isArray(m.value) ? m.value.join(', ') : String(m.value) }))
    : [];
  const requiredQuestions = (plan?.unresolvedDetails || [])
    .filter((d) => d.required && d.category !== 'EEO' && d.category !== 'CONSENT' && d.type !== 'FILE')
    .map((d) => ({ providerFieldId: d.providerFieldId, label: d.label, required: d.required, type: d.type || 'TEXT', options: d.options || [], reason: d.reason }));
  const optionalOmitted = (plan?.unresolvedDetails || []).filter((d) => !d.required);
  const mappedForReview = (plan?.mappedFields || [])
    .filter((m) => m.value !== null && m.value !== undefined)
    .map((m) => ({ label: m.label || m.canonicalKey || m.providerFieldId, value: Array.isArray(m.value) ? m.value.join(', ') : String(m.value), source: m.source }));
  const KEY_GROUP: Array<[string, string, string]> = [
    ['firstName', 'Personal', 'firstNam'], ['lastName', 'Personal', 'lastNam'], ['fullName', 'Personal', 'fullNam'], ['preferredName', 'Personal', 'preferredNam'],
    ['email', 'Contact', 'email'], ['phone', 'Contact', 'phone'],
    ['location', 'Location', 'location'], ['city', 'Location', 'city'], ['country', 'Location', 'country'],
    ['workAuthorization', 'Work authorization', 'authoriz'], ['requiresSponsorship', 'Sponsorship', 'sponsor'], ['visaType', 'Work authorization', 'visa'],
    ['noticePeriod', 'Availability', 'notice'], ['earliestStartDate', 'Availability', 'earliest'], ['availableFrom', 'Availability', 'available'],
    ['minimumSalary', 'Compensation', 'salary'], ['targetSalary', 'Compensation', 'targetSal'], ['salaryCurrency', 'Compensation', 'currency'],
    ['linkedinUrl', 'Professional', 'linkedin'], ['githubUrl', 'Professional', 'github'], ['portfolioUrl', 'Professional', 'portfolio'], ['websiteUrl', 'Professional', 'website'],
    ['university', 'Professional', 'university'], ['institution', 'Professional', 'institution'], ['currentRole', 'Professional', 'role'], ['currentCompany', 'Professional', 'company'],
  ];
  const reviewGroups: Array<{ title: string; items: Array<{ label: string; value: string; source: string }> }> = [];
  for (const m of mappedForReview) {
    const key = (m as any).canonicalKey || m.label;
    let title = 'Application Questions';
    for (const [k, t] of KEY_GROUP) {
      if (String(m.label).toLowerCase().includes(k) || String(key).toLowerCase().includes(k)) { title = t; break; }
    }
    let g = reviewGroups.find((x) => x.title === title);
    if (!g) { g = { title, items: [] }; reviewGroups.push(g); }
    g.items.push(m);
  }
  const planId = plan?.id;
  const consentFields = (plan?.consentFields || []).map((c) => ({ providerFieldId: c.providerFieldId, label: c.label, classification: c.classification }));
  return {
    applicationId,
    jobTitle: plan?.target.title ?? pkg.jobSnapshot.title,
    company: plan?.target.company ?? pkg.jobSnapshot.company,
    provider: plan?.provider ?? pkg.jobSnapshot.platform ?? 'unknown',
    planId,
    requiredQuestions,
    optionalOmittedCount: optionalOmitted.length,
    reviewGroups,
    consentFields,
    needsApproval: plan && plan.status === 'READY_TO_SUBMIT' ? !getApprovalsByPlan(db, userId, plan.id).some((a) => a.status === 'ACTIVE') : false,
    userConfirmed: confirmed
      ? { confirmedAt: confirmed.metadata.confirmedAt ?? confirmed.createdAt, source: 'USER' }
      : undefined,
    answeredFields,
    consentReviewCount: plan?.consentFields.filter((c) => ['LEGAL_CONSENT', 'REQUIRED_ACKNOWLEDGEMENT', 'UNKNOWN_CONSENT'].includes(c.classification as string)).length ?? 0,
    resume: pkg.resumeSnapshot?.pdfHash
      ? { artifactHash: pkg.resumeSnapshot.pdfHash, downloadUrl: `/api/application-packages/${pkg.id}/resume.pdf` }
      : null,
    lastUpdated: attempt?.updatedAt ?? plan?.updatedAt ?? pkg.updatedAt,
    events: allEvents.slice(0, 8).map((e) => ({ eventType: e.eventType, reasonCode: e.reasonCode, createdAt: e.createdAt, metadata: e.metadata ?? {} })),
  };
}

function getLatestAttemptId(db: Database, userId: string, planId: string): string | undefined {
  const row = db.prepare('SELECT id FROM application_attempts WHERE user_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 1').get(userId, planId) as any;
  return row?.id;
}