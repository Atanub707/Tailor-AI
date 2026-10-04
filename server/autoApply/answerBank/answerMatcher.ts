// Auto Apply — Answer Bank matching.
//
// EXACT (normalized question) → CANONICAL (shared canonical key, verified) →
// SEMANTIC (deterministic token-containment similarity, thresholded) → NONE.
// Stale / non-verified / sensitive answers are returned as matches but ALWAYS
// with requiresReview=true — approximate matching never silently reuses them.

import type { AnswerBankConfig, AnswerBankRecord, AnswerValue } from './answerBankTypes.js';
import { TIME_SENSITIVE_CATEGORIES } from './answerBankTypes.js';
import { canonicalKeyForQuestion, normalizeQuestion } from './answerCanonicalizer.js';

export type AnswerMatchStatus = 'EXACT' | 'CANONICAL' | 'SEMANTIC' | 'NONE';

export interface AnswerMatchInput {
  question: string;
  fieldType?: string;
  options?: string[];
  canonicalKey?: string;
  category?: string;
}

export interface AnswerMatchResult {
  matchStatus: AnswerMatchStatus;
  answer?: AnswerBankRecord;
  value?: AnswerValue;
  confidence: number;
  requiresReview: boolean;
  matchedAnswerId?: string;
  reason?: string;
}

const SIMILARITY_STOPWORDS = new Set([
  'do', 'does', 'did', 'you', 'your', 'are', 'is', 'will', 'would', 'can', 'could', 'have', 'has',
  'to', 'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'if', 'when', 'what',
  'which', 'how', 'why', 'any', 'this', 'that', 'it', 'please', 'us', 'we', 'our', 'be', 'been',
]);

function tokenSet(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(' ').filter((t) => t && !SIMILARITY_STOPWORDS.has(t)));
}

/** Deterministic similarity: |intersection| / min(|A|,|B|). No embeddings,
 *  no LLM — conservative by construction (low recall, high precision). */
export function questionSimilarity(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

function isStale(record: AnswerBankRecord, staleDays: number): boolean {
  if (record.verificationStatus === 'STALE') return true;
  if (record.expiresAt && Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) < Date.now()) return true;
  if (record.questionCategory && TIME_SENSITIVE_CATEGORIES.has(record.questionCategory)) {
    const age = Date.now() - Date.parse(record.updatedAt);
    if (Number.isFinite(age) && age > staleDays * 86400e3) return true;
  }
  return false;
}

type MatcherThresholds = Pick<AnswerBankConfig, 'semanticHigh' | 'semanticReview'> & { staleDays?: number };

export class AnswerBankMatcher {
  private readonly thresholds: Required<MatcherThresholds>;

  constructor(thresholds: MatcherThresholds) {
    this.thresholds = { staleDays: 90, ...thresholds };
  }

  match(input: AnswerMatchInput, records: AnswerBankRecord[]): AnswerMatchResult {
    const reusable = records.filter((r) => r.reusable);
    const normalized = normalizeQuestion(input.question);

    const exact = reusable.find((r) => r.normalizedQuestion === normalized);
    if (exact) return this.verdict('EXACT', exact, 1, false);

    const key = input.canonicalKey || canonicalKeyForQuestion(input.question);
    if (key) {
      // Read-time canonicalization: legacy rows without a stored key still
      // match as canonicalizer rules improve (no migration needed).
      const canonical = reusable.find((r) => (r.canonicalKey || canonicalKeyForQuestion(r.canonicalQuestion)) === key);
      if (canonical) return this.verdict('CANONICAL', canonical, 0.99, false);
    }

    let best: AnswerBankRecord | undefined;
    let bestScore = 0;
    for (const record of reusable) {
      const score = questionSimilarity(input.question, record.canonicalQuestion);
      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }
    if (best && bestScore >= this.thresholds.semanticReview) {
      return this.verdict('SEMANTIC', best, bestScore, bestScore < this.thresholds.semanticHigh);
    }
    return { matchStatus: 'NONE', confidence: bestScore, requiresReview: false };
  }

  private verdict(status: AnswerMatchStatus, record: AnswerBankRecord, confidence: number, semanticReview: boolean): AnswerMatchResult {
    const stale = isStale(record, this.thresholds.staleDays);
    const sensitive = record.sensitivity === 'SENSITIVE' || record.sensitivity === 'LEGAL';
    const unverified = record.verificationStatus !== 'VERIFIED';
    // User-provided, verified, EXACT/CANONICAL answers are the explicit approval —
    // they may fill even when sensitive (their own disclosure). Approximate
    // (semantic) sensitive matches still require review; so do generated values.
    const explicitUserAnswer =
      record.source === 'USER_PROVIDED' && record.verificationStatus === 'VERIFIED' && !stale && !semanticReview;
    const requiresReview = stale || unverified || semanticReview || (sensitive && !explicitUserAnswer);
    const reason = stale ? 'saved answer may be out of date — please confirm'
      : sensitive ? 'sensitive answer — explicit review required'
        : semanticReview ? 'similar question — please confirm the saved answer'
          : unverified ? 'answer not verified' : undefined;
    return {
      matchStatus: status,
      answer: record,
      value: record.answerValue,
      confidence,
      requiresReview,
      matchedAnswerId: record.id,
      reason,
    };
  }
}
