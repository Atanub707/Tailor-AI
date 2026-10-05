// Auto Apply (Experimental) — Lever-only DRY RUN.
//
// WRAPS the existing dormant assisted-apply stack; it does not modify it:
//   job (user-scoped) → provider detection (existing)
//     → ApplicationPackage (existing package engine; Master CV fallback)
//     → SubmissionPlan (existing engine; live read-only Lever inspection)
//     → UI projection (this module only)
//
// HARD BOUNDARIES:
//   * read-only: no approvals, no attempts, no execution, no submission
//   * no LLM, no auto-tailoring, no answer guessing
//   * `submission.enabled` is a constant false — no config can turn it on
//   * zero network in fixture mode (tests); production = one read-only GET
//     through the existing Lever inspector (SSRF-safe, anti-burst, GET-only)

import type { Job } from '../../src/types.js';
import { getCurrentUserId, getJobById, getMasterCv, getMasterCvUpdatedAt } from '../storage/fileStorage.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';
import { ensureJobDescription, JDResolutionError } from '../tailor/jdResolver.js';
import { computeFit } from '../fit/fitEngine.js';
import { fitCacheKeyFor, getCachedFit, storeCachedFit } from '../fit/fitCache.js';
import { buildPackage, computePackageKeys } from '../applicationPackage/packageEngine.js';
import { getLatestPackage, storePackage, packageInputFingerprint } from '../applicationPackage/packageStore.js';
import { artifactExists } from '../applicationPackage/artifactStore.js';
import { createPlan, EngineGateError } from '../applicationEngine/engine.js';
import { targetFromJob, type ApplicationInspectionAdapter } from '../applicationEngine/fixtureAdapter.js';
import { InspectionFailure } from '../applicationEngine/leverInspector.js';
import { resumeAttachmentFilename } from '../applicationEngine/resumeNaming.js';
import { canonicalOption } from '../applicationEngine/leverPayloadBuilder.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { SubmissionPlan } from '../applicationEngine/contract.js';
import type { AutoApplyDryRunResult, AutoApplyResumePreview } from './autoApplyTypes.js';
import {
  emptyDecisionMeta,
  layaConfigFromEnv,
  resolveAnswerFromPackage,
  runDecisionPass,
  type DecisionEngine,
} from './decisionEngine.js';
import { RulesDecisionEngine } from './rulesDecisionEngine.js';
import { LayaDecisionEngine } from './layaDecisionEngine.js';
import {
  buildFactLedger,
  emptyGenerativeMeta,
  generativeConfigFromEnv,
  LlmGenerativeAnswerEngine,
  runGenerativePass,
  type GenerativeAnswerEngine,
} from './generativeAnswerEngine.js';
import { answerBankConfigFromEnv } from './answerBank/answerBankTypes.js';
import { consentBlocksExecution } from '../applicationEngine/executionContract.js';
import { resolveQuestionsFromBank, recordBankUsage } from './answerBank/answerBankService.js';
import { collectPendingQuestions } from './answerBank/answerBankStore.js';
import {
  autoSubmitPreferencesFromEnv,
  browserFillEnabled,
  evaluateSubmissionReadiness,
  executionModeFromEnv,
} from './submissionReadiness.js';

/** Experimental flag — repository env convention; default MUST be false. */
export function autoApplyEnabled(): boolean {
  return (process.env.AUTO_APPLY_ENABLED ?? 'false') === 'true';
}

export type AutoApplyErrorCode =
  | 'AUTO_APPLY_DISABLED'
  | 'UNAUTHENTICATED'
  | 'INVALID_JOB_ID'
  | 'JOB_NOT_FOUND';

export class AutoApplyError extends Error {
  constructor(public readonly code: AutoApplyErrorCode, message: string) {
    super(message);
    this.name = 'AutoApplyError';
  }
}

/** Submission is disabled by construction — this constant is the ONLY value
 *  the API can return. Enabling transport is a future, separate milestone. */
const SUBMISSION_DISABLED = { enabled: false } as const;

export interface AutoApplyDryRunOptions {
  /** Test/dev seam mirroring PlanCreateInput: fixture mode requires an adapter. */
  adapter?: ApplicationInspectionAdapter;
  mode?: 'production' | 'fixture';
  /** Test/dev seam: override the decision engine. Production constructs the
   *  Laya engine from env ONLY when LAYA_ENABLED=true; otherwise none runs. */
  decisionEngine?: DecisionEngine;
  /** Test/dev seam: override the grounded generative engine. Production
   *  constructs the LLM engine ONLY when AUTO_APPLY_GENERATIVE_ENABLED=true. */
  generativeEngine?: GenerativeAnswerEngine;
}

const EMPTY_RESUME: AutoApplyResumePreview = { fileName: null, artifactHash: null, available: false, source: null };

function resumePreview(pkg: ApplicationPackage | undefined): AutoApplyResumePreview {
  if (!pkg?.resumeSnapshot) return { ...EMPTY_RESUME };
  const snap = pkg.resumeSnapshot;
  return {
    fileName: resumeAttachmentFilename(pkg),
    artifactHash: snap.pdfHash ?? null,
    available: Boolean(snap.pdfOk && snap.pdfHash),
    source: snap.source ?? null,
  };
}

function baseResult(job: Job, provider: string, status: AutoApplyDryRunResult['status'], message?: string): AutoApplyDryRunResult {
  return {
    status,
    job: { id: job.id, title: job.title, company: job.company },
    provider,
    targetUrl: job.applyUrl || job.url || null,
    resume: { ...EMPTY_RESUME },
    fields: [],
    unresolvedFields: [],
    consentFields: [],
    sensitiveFields: [],
    aiSuggestions: [],
    decision: emptyDecisionMeta(),
    generative: emptyGenerativeMeta(),
    answerBank: { enabled: false, matched: [] },
    warnings: [],
    submission: SUBMISSION_DISABLED,
    message,
  };
}

function packageNotReady(job: Job, provider: string, message: string, pkg?: ApplicationPackage): AutoApplyDryRunResult {
  const result = baseResult(job, provider, 'PACKAGE_NOT_READY', message);
  result.resume = resumePreview(pkg);
  if (pkg) {
    result.warnings = [
      ...pkg.validation.missingPrerequisites,
      ...pkg.validation.needsInput,
      ...pkg.validation.blockers,
    ].slice(0, 20);
  }
  return result;
}

const INSPECTION_MESSAGES: Record<string, string> = {
  PROVIDER_CHALLENGE: 'The provider presented an anti-automation challenge. Auto Apply cannot continue — no bypass is attempted.',
  RATE_LIMITED: 'The provider rate-limited the read-only inspection. Try again later.',
  TARGET_NOT_FOUND: 'The application page was not found on the provider.',
  PROVIDER_BLOCKED: 'The provider blocked the read-only inspection.',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable right now.',
  INSPECTION_TIMEOUT: 'The read-only inspection timed out.',
  FORM_CHANGED: 'The application form could not be read — it may have changed.',
};

function inspectionFailed(job: Job, kind: string): AutoApplyDryRunResult {
  const result = baseResult(job, 'lever', 'INSPECTION_FAILED', INSPECTION_MESSAGES[kind] ?? 'The application form could not be inspected.');
  result.warnings = [`inspection:${kind}`];
  return result;
}

/**
 * Run the Lever-only dry run for one of the CURRENT user's jobs.
 * READ-ONLY: returns exactly what WOULD be filled; never submits.
 */
export async function runAutoApplyDryRun(
  jobId: string,
  opts: AutoApplyDryRunOptions = {}
): Promise<AutoApplyDryRunResult> {
  if (!autoApplyEnabled()) {
    throw new AutoApplyError('AUTO_APPLY_DISABLED', 'Auto Apply is disabled.');
  }
  const userId = getCurrentUserId();
  if (!userId) throw new AutoApplyError('UNAUTHENTICATED', 'Not signed in.');
  if (!jobId || typeof jobId !== 'string' || jobId.length > 200) {
    throw new AutoApplyError('INVALID_JOB_ID', 'A job id is required.');
  }
  // User-scoped lookup: another user's job is indistinguishable from missing.
  const job = getJobById(jobId);
  if (!job) throw new AutoApplyError('JOB_NOT_FOUND', 'Job not found.');

  // Existing provider detection — Lever + Greenhouse are live; others stay unsupported.
  const target = targetFromJob(job);
  if (target.provider !== 'lever' && target.provider !== 'greenhouse') {
    return baseResult(job, target.provider, 'UNSUPPORTED_ATS', `Auto Apply is not supported for this ATS yet (${target.provider}).`);
  }

  // Existing JD resolver — Lever jobs carry descriptions; a missing one fails
  // honestly instead of fabricating a package input.
  let fullJob: Job;
  try {
    fullJob = await ensureJobDescription(job);
  } catch (err) {
    if (err instanceof JDResolutionError) return packageNotReady(job, target.provider, err.message);
    throw err;
  }

  // Existing package inputs — same orchestration as the canonical package
  // route, MINUS auto-tailoring (a dry run never calls an LLM).
  const profile = getApplicantProfile(userId);
  const masterCv = getMasterCv(userId);
  const jd = fullJob.description || '';
  const fitKey = fitCacheKeyFor(profile.updatedAt, getMasterCvUpdatedAt(userId), jd);
  let fit = getCachedFit(userId, job.id, fitKey);
  if (!fit) {
    fit = computeFit(profile, masterCv, fullJob, jd);
    storeCachedFit(userId, job.id, fitKey, fit);
  }
  const tailoredCv = fullJob.tailoredCv;

  // Existing package engine — reuse a READY package with identical inputs;
  // otherwise build a new immutable version (Master CV fallback included).
  const latest = getLatestPackage(userId, job.id);
  const keys = computePackageKeys({ userId, job: fullJob, jd, profile, masterCv, fit, tailoredCv });
  keys.masterCvUpdatedAt = getMasterCvUpdatedAt(userId);
  const fingerprint = packageInputFingerprint(keys);
  let pkg: ApplicationPackage;
  if (latest && latest.status === 'READY' && latest.inputFingerprint === fingerprint) {
    pkg = latest;
  } else {
    pkg = await buildPackage({ userId, job: fullJob, jd, profile, masterCv, fit, tailoredCv }, keys.masterCvUpdatedAt);
    storePackage(pkg);
  }

  if (pkg.status !== 'READY') {
    return packageNotReady(job, 'lever', 'The application package is not ready yet — review the missing items below.', pkg);
  }
  // Existing immutable artifact check — never regenerate at dry-run time.
  const artifactOk = Boolean(pkg.resumeSnapshot?.pdfHash && artifactExists(pkg.resumeSnapshot.pdfHash));
  if (!artifactOk) {
    return packageNotReady(job, 'lever', 'The exact resume PDF artifact is missing — prepare the application again.', pkg);
  }

  // Existing Application Engine — live READ-ONLY Lever inspection + mapping.
  let plan: SubmissionPlan;
  try {
    ({ plan } = await createPlan({ userId, pkg, job: fullJob, artifactOk, adapter: opts.adapter, mode: opts.mode }));
  } catch (err) {
    if (err instanceof EngineGateError) {
      return packageNotReady(job, 'lever', `The application package was refused by the engine (${err.code}).`, pkg);
    }
    if (err instanceof InspectionFailure) return inspectionFailed(job, err.kind);
    throw err;
  }

  // UI projection over the plan the engine persisted — no re-mapping here.
  const requiredUnresolved = plan.unresolvedDetails.filter((u) => u.required);
  const warnings: string[] = [...pkg.validation.warnings];
  if (pkg.resumeSnapshot?.source === 'MASTER_CV') {
    warnings.push('No tailored CV exists for this job yet — your Master CV PDF will be used.');
  }
  // (the 'needs your input' warning is emitted AFTER bank resolution below — pre-bank counts lied)
  // Consent policy: only LEGAL / REQUIRED_ACKNOWLEDGEMENT / UNKNOWN consent
  // blocks review. Optional marketing/communication opt-ins never block
  // filling and are never auto-accepted.
  const blockingConsent = plan.consentFields.filter((c) => consentBlocksExecution(c.classification));
  const optionalConsentCount = plan.consentFields.length - blockingConsent.length;
  if (blockingConsent.length > 0) {
    warnings.push('This application includes consent/legal steps that always require your explicit review.');
  }
  if (optionalConsentCount > 0) {
    warnings.push(`${optionalConsentCount} optional consent/marketing field(s) are left untouched — never auto-accepted, and they never block filling.`);
  }
  if (plan.manualFields.length > 0) {
    warnings.push('Voluntary/EEO and manual-only fields are never inferred — EEO fills only from your saved, verified answers.');
  }

  // Candidate Answer Bank — resolution order: deterministic (mapper) →
  // VERIFIED ANSWER BANK → Laya. Disabled by default. Review-required matches
  // (stale/sensitive/unverified) are surfaced but never auto-reused, and are
  // still withheld from the classification engine.
  const bankCfg = answerBankConfigFromEnv();
  let bankMatched: AutoApplyDryRunResult['answerBank']['matched'] = [];
  const bankAnswered = new Set<string>();
  if (bankCfg.enabled && plan.unresolvedDetails.length > 0) {
    const resolved = resolveQuestionsFromBank(
      userId,
      plan.unresolvedDetails.map((u) => ({
        providerFieldId: u.providerFieldId,
        label: u.label,
        fieldType: u.type ? String(u.type) : undefined,
        options: u.options,
      }))
    );
    const optionsByField = new Map(
      plan.unresolvedDetails.map((u) => [u.providerFieldId, Array.isArray(u.options) && u.options.length ? u.options : undefined]),
    );
    // A saved answer that no longer matches the form's options must be re-asked,
    // never treated as a clean fill (the payload builder would reject it).
    const valueMatchesOptions = (value: unknown, options: string[] | undefined): boolean => {
      if (!options || options.length === 0) return true;
      const values = Array.isArray(value) ? value : [value];
      return values.every((v) => canonicalOption(String(v), options) !== null);
    };
    bankMatched = resolved
      .filter((r) => r.matchStatus !== 'NONE' && r.value !== null && r.value !== undefined)
      .map((r) => {
        const options = optionsByField.get(r.providerFieldId);
        const optionOk = valueMatchesOptions(r.value, options);
        return {
          providerFieldId: r.providerFieldId,
          label: r.label,
          matchStatus: r.matchStatus as 'EXACT' | 'CANONICAL' | 'SEMANTIC',
          value: r.value,
          source: 'ANSWER_BANK' as const,
          confidence: r.confidence,
          requiresReview: r.requiresReview || !optionOk,
          matchedAnswerId: r.matchedAnswerId,
          reason: optionOk
            ? r.reason
            : `saved answer is not one of the allowed options (${(options || []).join(' | ')})`,
        };
      });
    for (const match of bankMatched) {
      bankAnswered.add(match.providerFieldId);
      if (!match.requiresReview && match.matchedAnswerId) recordBankUsage(userId, match.matchedAnswerId);
    }
  }
  const bankCleanNow = new Set(bankMatched.filter((m) => !m.requiresReview).map((m) => m.providerFieldId));
  const unresolvedAfterBank = requiredUnresolved.filter((u) => !bankCleanNow.has(u.providerFieldId));
  if (unresolvedAfterBank.length > 0) {
    warnings.push(`${unresolvedAfterBank.length} required question(s) need your input — they are never guessed.`);
  }
  // Effective display status: bank-resolved required answers make the plan
  // ready even though the stored inspection-time status says NEEDS_INPUT.
  const effectivePlanStatus = unresolvedAfterBank.length === 0 && plan.status === 'NEEDS_INPUT' ? 'READY_TO_SUBMIT' : plan.status;

  // Advisory decision pass — ONLY for fields neither the deterministic mapper
  // nor the Answer Bank resolved. Disabled by default; never generates
  // answers; failures are a no-op. Deterministic results always win.
  let aiSuggestions: AutoApplyDryRunResult['aiSuggestions'] = [];
  let decision = emptyDecisionMeta();
  const layaCfg = layaConfigFromEnv();
  const decisionEngine: DecisionEngine | null =
    opts.decisionEngine ?? (layaCfg.enabled ? new LayaDecisionEngine(layaCfg) : null);
  if (decisionEngine && plan.unresolvedDetails.length > 0) {
    const pass = await runDecisionPass({
      engine: decisionEngine,
      rules: new RulesDecisionEngine(),
      fields: plan.unresolvedDetails
        .filter((u) => !bankAnswered.has(u.providerFieldId))
        .map((u) => ({
          providerFieldId: u.providerFieldId,
          label: u.label,
          required: u.required,
        })),
      resolveAnswer: (canonicalKey) => resolveAnswerFromPackage(pkg.answers, canonicalKey),
      highConfidence: layaCfg.highConfidence,
      reviewConfidence: layaCfg.reviewConfidence,
      maxFields: layaCfg.maxFields,
      concurrency: layaCfg.concurrency,
    });
    aiSuggestions = pass.suggestions;
    decision = pass.meta;
    if (pass.suggestions.some((s) => s.hardBlocked)) {
      warnings.push('An advisory suggestion touched a sensitive category — it stays review-only and was never auto-resolved.');
    }
    if (decision.failed > 0) {
      warnings.push('The local decision engine was unavailable for some fields — they remain needs-input.');
    }
  }

  // Grounded generative drafts — ONLY for GENERATIVE_REQUIRED suggestions.
  // Disabled by default; the LLM is the repository's existing provider.
  const genCfg = generativeConfigFromEnv();
  const generativeEngine: GenerativeAnswerEngine | null =
    opts.generativeEngine ?? (genCfg.enabled ? new LlmGenerativeAnswerEngine(genCfg) : null);
  let generative = emptyGenerativeMeta();
  if (generativeEngine && aiSuggestions.length > 0) {
    // Only the VERIFIED V2 tailored resume may feed the ledger (never V1).
    const tailoredDraft =
      pkg.resumeSnapshot?.source === 'TAILORED' && pkg.resumeSnapshot.verification?.passed
        ? pkg.resumeSnapshot.structuredResume
        : undefined;
    const ledger = buildFactLedger({ profile, masterCv, job: fullJob, tailoredDraft });
    const pass = await runGenerativePass({
      engine: generativeEngine,
      candidates: aiSuggestions.map((s) => ({
        providerFieldId: s.providerFieldId,
        question: s.label,
        answerSource: s.answerSource,
        category: s.category,
      })),
      ledger,
      job: { title: job.title, company: job.company, description: jd },
      maxQuestions: genCfg.maxQuestions,
    });
    for (const suggestion of aiSuggestions) {
      const draft = pass.drafts.get(suggestion.providerFieldId);
      if (draft) suggestion.generatedDraft = draft;
    }
    generative = pass.meta;
    if (pass.meta.generated > 0) {
      warnings.push('Generated drafts are grounded in your profile and CV, but they are unverified suggestions — review and edit them before any future submission.');
    }
    if (pass.meta.failed > 0) {
      warnings.push('Some answers could not be generated from your verified facts — they remain needs-input.');
    }
  }

  // Submission readiness — a SEPARATE gate from field completion. At dry-run
  // time there is no companion session (companionReady=false), so canFill is
  // false by construction; the companion re-validates at fill time.
  const requiredById = new Map(plan.unresolvedDetails.map((u) => [u.providerFieldId, u.required]));
  const bankResolvedRequiredClean = bankMatched.filter((m) => !m.requiresReview && requiredById.get(m.providerFieldId)).length;
  // A field whose required answer came from the bank (clean) is RESOLVED —
  // it must not also be counted as unresolved (double-count made readiness
  // report NEEDS_INPUT while the panel showed the same rows answered).
  const bankCleanIds = new Set(bankMatched.filter((m) => !m.requiresReview).map((m) => m.providerFieldId));
  const unresolvedRequired = plan.unresolvedDetails
    .filter((u) => u.required && !bankAnswered.has(u.providerFieldId))
    .map((u) => u.label);
  // Only REQUIRED review-required items gate readiness. An optional saved
  // answer that needs review is simply left unfilled (never blocks the run,
  // never guessed) — conditional follow-ups are the common case.
  const reviewRequired = [
    ...bankMatched
      .filter((m) => m.requiresReview && requiredById.get(m.providerFieldId) === true)
      .map((m) => ({ label: m.label, reason: m.reason ?? 'saved answer needs review' })),
    ...aiSuggestions
      .filter((s) => s.generatedDraft && requiredById.get(s.providerFieldId) === true)
      .map((s) => ({ label: s.label, reason: 'generated draft requires your approval' })),
  ];
  const optionalReviewSkipped =
    bankMatched.filter((m) => m.requiresReview && requiredById.get(m.providerFieldId) !== true).length +
    aiSuggestions.filter((s) => s.generatedDraft && requiredById.get(s.providerFieldId) !== true).length;
  if (optionalReviewSkipped > 0) {
    warnings.push(`${optionalReviewSkipped} optional saved answer(s) need your review and were left unfilled.`);
  }
  const mappedRequired = plan.mappedFields.filter((m) => m.required).length;
  const totalRequiredFields =
    mappedRequired +
    plan.unresolvedDetails.filter((u) => u.required && !bankCleanIds.has(u.providerFieldId)).length +
    blockingConsent.filter((c) => c.required).length +
    plan.manualFields.filter((m) => m.required).length;
  const autoSubmitPrefs = autoSubmitPreferencesFromEnv();
  const eeoFields = plan.manualFields.filter((m) => /EEO/i.test(m.reason || '')).map((m) => m.label);
  const manualNonEeoFields = plan.manualFields.filter((m) => !/EEO/i.test(m.reason || '')).map((m) => m.label);
  const readiness = evaluateSubmissionReadiness({
    provider: target.provider,
    planStatus: effectivePlanStatus,
    totalRequiredFields,
    resolvedRequiredFields: mappedRequired + bankResolvedRequiredClean,
    unresolvedRequired,
    reviewRequired,
    manualOnlyFields: manualNonEeoFields,
    consentFields: blockingConsent.map((c) => ({ label: c.label, required: c.required })),
    sensitiveFields: eeoFields,
    captchaPresent: false, // plan-time; the companion re-validates at fill time
    otpRequired: false,
    loginRequired: false,
    unsupportedRequiredUpload: false,
    resumeReady: Boolean(pkg.resumeSnapshot?.pdfOk),
    artifactVerified: artifactOk,
    pageStillMatchesPlan: true, // just inspected read-only
    companionReady: browserFillEnabled(), // server-side capability; pairing/session is checked at fill start
    autoSubmitGlobalEnabled: autoSubmitPrefs.globalEnabled,
    autoSubmitThisApplication: autoSubmitPrefs.thisApplication,
    executionMode: executionModeFromEnv(),
    duplicateRisk: false,
    uncertainSubmissionExists: false,
  });

  // Collect REQUIRED-but-unanswered questions into the Answer Bank as PENDING
  // entries (answer once, reuse later). Never overwrites; never auto-fills.
  try {
    if (answerBankConfigFromEnv().enabled) {
      collectPendingQuestions(
        userId,
        plan.unresolvedDetails.slice(0, 25).map((u) => ({
          question: u.label,
          category: u.category,
          answerType: (['TEXT', 'TEXTAREA', 'SINGLE_SELECT', 'MULTI_SELECT', 'NUMBER', 'DATE', 'BOOLEAN'].includes(String(u.type)) ? String(u.type) : undefined) as any,
          options: u.options,
        }))
      );
    }
  } catch { /* collection must never break the dry run */ }

  return {
    status: 'DRY_RUN_READY',
    job: { id: job.id, title: job.title, company: job.company },
    provider: target.provider,
    targetUrl: plan.target.applyUrl || null,
    resume: resumePreview(pkg),
    fields: plan.mappedFields.map((m) => ({
      providerFieldId: m.providerFieldId,
      label: m.label,
      type: String(m.type),
      required: m.required,
      canonicalKey: m.canonicalKey,
      proposedValue: m.value ?? null,
      source: m.source,
      mappingMethod: m.mappingMethod,
      confidence: m.mappingConfidence,
      requiresUser: false,
    })),
    unresolvedFields: plan.unresolvedDetails.filter((u) => !bankCleanIds.has(u.providerFieldId)).map((u) => ({
      providerFieldId: u.providerFieldId,
      label: u.label,
      type: u.type ? String(u.type) : undefined,
      required: u.required,
      reason: u.reason,
      requiresUser: u.required,
      options: Array.isArray(u.options) && u.options.length ? u.options : undefined,
    })),
    consentFields: plan.consentFields.map((c) => ({
      providerFieldId: c.providerFieldId,
      label: c.label,
      required: c.required,
      classification: c.classification,
      status: 'REQUIRES_REVIEW' as const,
    })),
    sensitiveFields: plan.manualFields.map((m) => ({
      providerFieldId: m.providerFieldId,
      label: m.label,
      required: m.required,
      reason: m.reason,
    })),
    aiSuggestions: aiSuggestions.map((s) => ({
      providerFieldId: s.providerFieldId,
      label: s.label,
      canonicalKey: s.canonicalKey,
      category: String(s.category),
      answerSource: s.answerSource,
      confidence: s.confidence,
      mappingMethod: 'AI_SUGGESTED' as const,
      proposedValue: s.proposedValue,
      valueSource: s.valueSource,
      requiresUser: s.requiresUser,
      hardBlocked: s.hardBlocked,
      reason: s.reason,
      generatedDraft: s.generatedDraft
        ? {
            value: s.generatedDraft.value,
            source: 'GENERATED_FROM_CANDIDATE_FACTS' as const,
            requiresUserReview: true as const,
            supportingFacts: s.generatedDraft.supportingFacts.map((f) => ({ id: f.id, source: String(f.source), summary: f.summary })),
            warnings: s.generatedDraft.warnings,
            questionCategory: s.generatedDraft.questionCategory,
          }
        : undefined,
    })),
    decision,
    generative,
    answerBank: { enabled: bankCfg.enabled, matched: bankMatched },
    readiness,
    execution: {
      planId: plan.id,
      packageId: pkg.id,
      planStatus: effectivePlanStatus,
      mode: executionModeFromEnv(),
      fillEnabled: browserFillEnabled(),
    },
    warnings,
    submission: SUBMISSION_DISABLED,
    planStatus: effectivePlanStatus,
  };
}
