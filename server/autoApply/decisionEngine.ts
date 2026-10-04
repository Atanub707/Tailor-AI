// Auto Apply — Decision Engine boundary.
//
// The rest of Auto Apply depends on THIS interface, never on Laya directly.
// Engines only CLASSIFY; the policy below decides what may be shown, what
// may be resolved from the existing answer catalog, and what always needs
// the user. Hard-block categories (consent/EEO/legal/demographic/OTP/…) can
// never be auto-resolved by any engine at any confidence.
//
// Fallback order (fixed): EXACT → ALIAS → DETERMINISTIC → LAYA → USER.
// The deterministic mapper runs before this pass; RulesDecisionEngine gates
// what is genuinely ambiguous, so an engine is only consulted for those.

import type { FieldCategory } from '../applicationEngine/contract.js';
import { answerByKey } from '../applicationPackage/answers.js';

// ── Vocabulary (reuses the existing engine enums — no parallel vocabulary) ─

export type DecisionMappingMethod = 'EXACT' | 'ALIAS' | 'DETERMINISTIC' | 'AI_SUGGESTED';

export type AnswerSource = 'PROFILE' | 'MASTER_CV' | 'JOB_CONTEXT' | 'GENERATIVE_REQUIRED' | 'USER_REQUIRED';

export const ANSWER_SOURCES: readonly AnswerSource[] = ['PROFILE', 'MASTER_CV', 'JOB_CONTEXT', 'GENERATIVE_REQUIRED', 'USER_REQUIRED'];

const VALID_CATEGORIES: readonly string[] = [
  'IDENTITY', 'CONTACT', 'LOCATION', 'WORK_AUTHORIZATION', 'SPONSORSHIP', 'COMPENSATION',
  'EXPERIENCE', 'EDUCATION', 'RESUME', 'COVER_LETTER', 'CUSTOM', 'CONSENT', 'EEO', 'UNKNOWN',
];

/** Laya's lowercase category vocabulary → the existing FieldCategory enum. */
const LAYA_CATEGORY_MAP: Record<string, FieldCategory> = {
  identity: 'IDENTITY',
  contact: 'CONTACT',
  location: 'LOCATION',
  experience: 'EXPERIENCE',
  education: 'EDUCATION',
  skills: 'EXPERIENCE',
  work_authorization: 'WORK_AUTHORIZATION',
  sponsorship: 'SPONSORSHIP',
  salary: 'COMPENSATION',
  availability: 'CUSTOM',
  motivation: 'CUSTOM',
  consent: 'CONSENT',
  eeo: 'EEO',
  file_upload: 'RESUME',
  unknown: 'UNKNOWN',
};

export function normalizeLayaCategory(raw: unknown): FieldCategory {
  const key = String(raw ?? '').toLowerCase().trim();
  if (LAYA_CATEGORY_MAP[key]) return LAYA_CATEGORY_MAP[key];
  const upper = String(raw ?? '').toUpperCase().trim();
  if (VALID_CATEGORIES.includes(upper)) return upper as FieldCategory;
  return 'UNKNOWN';
}

export function normalizeAnswerSource(raw: unknown): AnswerSource | undefined {
  const upper = String(raw ?? '').toUpperCase().trim();
  return (ANSWER_SOURCES as readonly string[]).includes(upper) ? (upper as AnswerSource) : undefined;
}

// ── Interface ─────────────────────────────────────────────────────────────

export interface FieldClassificationInput {
  label: string;
  type?: string;
  required: boolean;
  options?: string[];
  normalizedKey?: string;
}

export interface FieldClassificationResult {
  canonicalKey?: string;
  category: FieldCategory;
  answerSource?: AnswerSource;
  confidence: number;
  mappingMethod: DecisionMappingMethod;
  /** Engines are conservative: true unless the policy later relaxes it. */
  requiresUser: boolean;
  reason?: string;
}

export interface QuestionClassificationInput {
  question: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

export interface QuestionClassificationResult {
  category: FieldCategory;
  answerSource: AnswerSource;
  confidence: number;
  requiresUser: boolean;
  reason?: string;
}

export interface DecisionEngine {
  readonly name: string;
  classifyField(input: FieldClassificationInput): Promise<FieldClassificationResult | null>;
  classifyQuestion?(input: QuestionClassificationInput): Promise<QuestionClassificationResult | null>;
}

// ── Configuration (env; LAYA DISABLED by default) ────────────────────────

export interface LayaConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
  highConfidence: number;
  reviewConfidence: number;
  maxFields: number;
  concurrency: number;
}

function envFloat(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

export function layaConfigFromEnv(): LayaConfig {
  return {
    enabled: (process.env.LAYA_ENABLED ?? 'false') === 'true',
    url: process.env.LAYA_URL ?? 'http://127.0.0.1:8765',
    timeoutMs: Number.isFinite(Number(process.env.LAYA_REQUEST_TIMEOUT_MS)) && Number(process.env.LAYA_REQUEST_TIMEOUT_MS) > 0
      ? Number(process.env.LAYA_REQUEST_TIMEOUT_MS)
      : 5000,
    highConfidence: envFloat('LAYA_HIGH_CONFIDENCE', 0.9),
    reviewConfidence: envFloat('LAYA_REVIEW_CONFIDENCE', 0.7),
    maxFields: Number.isFinite(Number(process.env.LAYA_MAX_FIELDS)) && Number(process.env.LAYA_MAX_FIELDS) > 0
      ? Math.min(Number(process.env.LAYA_MAX_FIELDS), 50)
      : 20,
    concurrency: 4,
  };
}

// ── Hard blocks (never auto-resolved by ANY engine, at ANY confidence) ───

const HARD_BLOCK_KEYS = new Set([
  'gender', 'raceEthnicity', 'veteranStatus', 'disabilityStatus', 'accessibilityNeeds',
]);

const HARD_BLOCK_LABEL_RE = new RegExp(
  [
    'captcha',
    'recaptcha',
    'hcaptcha',
    'one[- ]?time (password|code)',
    '\\botp\\b',
    '\\bmfa\\b',
    'two[- ]factor',
    'verification code',
    'password',
    'background[- ]check',
    'criminal (record|history)',
    'drug (test|screening)',
    'legal declaration',
    'terms of (use|service)',
    'privacy (policy|notice)',
    'candidate agreement',
    '\\bconsent\\b',
    '\\bdeclare\\b',
    '\\bgender\\b',
    '\\brace\\b',
    '\\bethnicity\\b',
    '\\bveteran\\b',
    '\\bdisability\\b',
    '\\bdemographic\\b',
    'sexual orientation',
    'accessibility',
  ].join('|'),
  'i'
);

/** Sensitive-but-answerable keys: a value may be shown from the configured
 *  profile, but the user ALWAYS reviews it (never silently resolved). */
const REVIEW_KEYS = new Set([
  'authorizedToWork', 'requiresSponsorship', 'visaType',
  'willingToRelocate', 'remotePreference',
  'noticePeriod', 'earliestStartDate',
  'currentSalary', 'minimumSalary', 'targetSalary', 'salaryCurrency', 'salaryPeriod',
  'hasReferralsAtCompany', 'onsiteAvailability',
]);

export function isHardBlockedField(result: FieldClassificationResult, label = ''): boolean {
  if (result.category === 'CONSENT' || result.category === 'EEO') return true;
  if (result.canonicalKey && HARD_BLOCK_KEYS.has(result.canonicalKey)) return true;
  return HARD_BLOCK_LABEL_RE.test(String(label || ''));
}

// ── Policy: classification → suggestion (pure) ───────────────────────────

export interface SuggestionInput {
  providerFieldId: string;
  label: string;
  required: boolean;
}

export interface ResolvedValue {
  value: string | number | boolean | string[];
  source: string;
}

export interface FieldSuggestion {
  providerFieldId: string;
  label: string;
  canonicalKey?: string;
  category: FieldCategory;
  answerSource?: AnswerSource;
  confidence: number;
  mappingMethod: 'AI_SUGGESTED';
  proposedValue: string | number | boolean | string[] | null;
  valueSource?: string;
  requiresUser: boolean;
  hardBlocked: boolean;
  reason?: string;
}

/** Resolve a value from the EXISTING package answer catalog — never generated.
 *  Uses the canonical answer resolver (`answerByKey`) with the same
 *  resolved/non-empty rule the mapper applies. */
export function resolveAnswerFromPackage(
  answers: Parameters<typeof answerByKey>[0],
  canonicalKey: string
): ResolvedValue | undefined {
  const a = answerByKey(answers, canonicalKey);
  if (!a || a.status !== 'RESOLVED' || a.value === null || a.value === undefined) return undefined;
  return { value: a.value as string | number | boolean | string[], source: a.source };
}

/**
 * Apply hard blocks + confidence thresholds to one classification.
 * Returns null when the suggestion must be dropped entirely (low confidence).
 */
export function decideFieldSuggestion(
  input: SuggestionInput,
  result: FieldClassificationResult,
  resolveAnswer: (canonicalKey: string) => ResolvedValue | undefined,
  thresholds: { highConfidence: number; reviewConfidence: number } = layaConfigFromEnv()
): FieldSuggestion | null {
  if (!Number.isFinite(result.confidence) || result.confidence < thresholds.reviewConfidence) return null;

  const base = {
    providerFieldId: input.providerFieldId,
    label: input.label,
    canonicalKey: result.canonicalKey,
    category: result.category,
    answerSource: result.answerSource,
    confidence: result.confidence,
    mappingMethod: 'AI_SUGGESTED' as const,
  };

  // HARD BLOCK: advisory only, never a value, always the user.
  if (isHardBlockedField(result, input.label)) {
    return {
      ...base,
      proposedValue: null,
      requiresUser: true,
      hardBlocked: true,
      reason: result.reason ?? 'Hard-blocked category — manual review only (never auto-answered)',
    };
  }

  // Value may ONLY come from the existing answer catalog.
  let proposedValue: FieldSuggestion['proposedValue'] = null;
  let valueSource: string | undefined;
  if (result.canonicalKey && !HARD_BLOCK_KEYS.has(result.canonicalKey)) {
    const resolved = resolveAnswer(result.canonicalKey);
    if (resolved) {
      proposedValue = resolved.value;
      valueSource = resolved.source;
    }
  }

  const sensitive = Boolean(result.canonicalKey && REVIEW_KEYS.has(result.canonicalKey));
  const requiresUser = sensitive || result.confidence < thresholds.highConfidence || proposedValue === null;

  return {
    ...base,
    proposedValue,
    valueSource,
    requiresUser,
    hardBlocked: false,
    reason: result.reason ?? (proposedValue === null ? 'No configured answer for the suggested key — needs your input' : undefined),
  };
}

// ── Orchestration: rules gate → engine → policy (with circuit breaker) ───

export interface DecisionMeta {
  engine: string;
  enabled: boolean;
  evaluated: number;
  suggested: number;
  requiresUser: number;
  failed: number;
  durationMs: number;
}

export function emptyDecisionMeta(): DecisionMeta {
  return { engine: 'none', enabled: false, evaluated: 0, suggested: 0, requiresUser: 0, failed: 0, durationMs: 0 };
}

export interface DecisionPassInput {
  engine: DecisionEngine;
  /** Deterministic gate — runs FIRST and is free. */
  rules: DecisionEngine;
  fields: SuggestionInput[];
  resolveAnswer: (canonicalKey: string) => ResolvedValue | undefined;
  highConfidence: number;
  reviewConfidence: number;
  maxFields: number;
  concurrency: number;
}

export interface DecisionPassResult {
  suggestions: FieldSuggestion[];
  meta: DecisionMeta;
}

/**
 * Fallback order enforced here: a field is sent to the engine ONLY when the
 * deterministic rules cannot classify it. First engine failure (transport,
 * timeout, malformed, unavailable) stops further calls for this run — the
 * dry run always continues.
 */
export async function runDecisionPass(input: DecisionPassInput): Promise<DecisionPassResult> {
  const started = Date.now();
  const capped = input.fields.slice(0, input.maxFields);

  const ambiguous: SuggestionInput[] = [];
  for (const field of capped) {
    const rulesResult = await input.rules.classifyField({
      label: field.label,
      required: field.required,
    });
    if (!rulesResult) ambiguous.push(field); // deterministically classified → engine never sees it
  }

  const suggestions: FieldSuggestion[] = [];
  let failed = 0;
  let stopped = false;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = cursor++;
      if (index >= ambiguous.length) return;
      const field = ambiguous[index];
      let result: FieldClassificationResult | null = null;
      try {
        result = await input.engine.classifyField({ label: field.label, required: field.required });
      } catch {
        result = null; // engines never throw by contract; belt & braces
      }
      if (result === null) {
        failed += 1;
        stopped = true; // circuit breaker: runtime is unhealthy — stop calling
        continue;
      }
      const suggestion = decideFieldSuggestion(field, result, input.resolveAnswer, {
        highConfidence: input.highConfidence,
        reviewConfidence: input.reviewConfidence,
      });
      if (suggestion) suggestions.push(suggestion);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(input.concurrency, ambiguous.length)) }, () => worker())
  );

  return {
    suggestions,
    meta: {
      engine: input.engine.name,
      enabled: true,
      evaluated: ambiguous.length,
      suggested: suggestions.length,
      requiresUser: suggestions.filter((s) => s.requiresUser).length,
      failed,
      durationMs: Date.now() - started,
    },
  };
}
