// Auto Apply — Candidate Answer Bank types.
// Every record is user-scoped; nothing is ever shared across users.

export type AnswerType = 'TEXT' | 'TEXTAREA' | 'BOOLEAN' | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'NUMBER' | 'DATE';

export type AnswerSourceKind = 'USER_PROVIDED' | 'PROFILE' | 'MASTER_CV' | 'GENERATED_APPROVED' | 'AUTO_COLLECTED';

export type AnswerVerificationStatus = 'VERIFIED' | 'REVIEW_REQUIRED' | 'STALE';

export type AnswerSensitivity = 'NORMAL' | 'PERSONAL' | 'SENSITIVE' | 'LEGAL';

export type AnswerValue = string | number | boolean | string[] | null;

export interface AnswerBankRecord {
  id: string;
  userId: string;
  canonicalKey?: string;
  canonicalQuestion: string;
  normalizedQuestion: string;
  questionCategory?: string;
  answerType: AnswerType;
  answerValue: AnswerValue;
  options?: string[];
  source: AnswerSourceKind;
  verificationStatus: AnswerVerificationStatus;
  sensitivity: AnswerSensitivity;
  reusable: boolean;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usageCount: number;
  provenance?: string;
  expiresAt?: string;
}

export interface AnswerBankUpsert {
  canonicalKey?: string;
  canonicalQuestion: string;
  questionCategory?: string;
  answerType: AnswerType;
  answerValue: AnswerValue;
  options?: string[];
  source?: AnswerSourceKind;
  verificationStatus?: AnswerVerificationStatus;
  sensitivity?: AnswerSensitivity;
  reusable?: boolean;
  aliases?: string[];
  provenance?: string;
  expiresAt?: string;
}

export interface AnswerBankConfig {
  enabled: boolean;
  semanticHigh: number;
  semanticReview: number;
  staleDays: number;
}

/** Question categories whose answers go stale fastest. */
export const TIME_SENSITIVE_CATEGORIES = new Set(['availability', 'compensation', 'work_authorization', 'visa', 'location']);

export function answerBankConfigFromEnv(): AnswerBankConfig {
  const num = (key: string, fallback: number): number => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  };
  const days = Number(process.env.ANSWER_BANK_STALE_DAYS);
  return {
    enabled: (process.env.AUTO_APPLY_ANSWER_BANK_ENABLED ?? 'false') === 'true',
    semanticHigh: num('ANSWER_BANK_SEMANTIC_HIGH_CONFIDENCE', 0.92),
    semanticReview: num('ANSWER_BANK_SEMANTIC_REVIEW_CONFIDENCE', 0.8),
    staleDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 90,
  };
}
