// Auto Apply — Answer Bank service: resolution for a job's questions and the
// question-learning workflow ("answer once, reuse later").
//
// Resolution order (per phase spec): deterministic/profile answers already ran
// in the mapper; this layer sits between them and the Laya advisory engine:
//   deterministic → VERIFIED ANSWER BANK → Laya → generative → user.

import { getDb } from '../../storage/fileStorage.js';
import { listAnswers, upsertAnswer, recordUsage, getAnswerById, upsertRunAnswer } from './answerBankStore.js';
import { AnswerBankMatcher } from './answerMatcher.js';
import { answerBankConfigFromEnv } from './answerBankTypes.js';
import { canonicalKeyForQuestion } from './answerCanonicalizer.js';
import type { AnswerBankRecord, AnswerType } from './answerBankTypes.js';

export interface BankQuestionInput {
  providerFieldId: string;
  label: string;
  fieldType?: string;
  options?: string[];
  canonicalKey?: string;
}

export interface BankQuestionResolution {
  providerFieldId: string;
  label: string;
  matchStatus: 'EXACT' | 'CANONICAL' | 'SEMANTIC' | 'NONE';
  value: string | number | boolean | string[] | null;
  source: 'ANSWER_BANK' | null;
  confidence: number;
  requiresReview: boolean;
  matchedAnswerId?: string;
  /** Canonical key the match was made under (from the stored answer, or
   *  derived from the question) — the intent harness scopes matches with it. */
  canonicalKey?: string;
  reason?: string;
}

/** Resolve a set of questions against the user's Answer Bank. Pure reads —
 *  usage is recorded by the caller for clean (non-review) matches only.
 *  `extraRecords` lets a run merge its RUN-SCOPED one-shot answers in. */
export function resolveQuestionsFromBank(userId: string, questions: BankQuestionInput[], extraRecords: AnswerBankRecord[] = []): BankQuestionResolution[] {
  const cfg = answerBankConfigFromEnv();
  const records = [...extraRecords, ...listAnswers(userId)];
  const matcher = new AnswerBankMatcher(cfg);
  return questions.map((q) => {
    const match = matcher.match(
      { question: q.label, fieldType: q.fieldType, options: q.options, canonicalKey: q.canonicalKey },
      records
    );
    if (match.matchStatus === 'NONE' || !match.answer) {
      return {
        providerFieldId: q.providerFieldId, label: q.label, matchStatus: 'NONE',
        value: null, source: null, confidence: match.confidence, requiresReview: false,
        canonicalKey: q.canonicalKey,
      };
    }
    return {
      providerFieldId: q.providerFieldId,
      label: q.label,
      matchStatus: match.matchStatus,
      value: match.value ?? null,
      source: 'ANSWER_BANK' as const,
      confidence: match.confidence,
      requiresReview: match.requiresReview,
      matchedAnswerId: match.matchedAnswerId,
      canonicalKey: match.answer.canonicalKey ?? canonicalKeyForQuestion(match.answer.canonicalQuestion),
      reason: match.reason,
    };
  });
}

export function recordBankUsage(userId: string, answerId: string): void {
  recordUsage(userId, answerId);
}

export interface LearnAnswerInput {
  jobId: string;
  question: string;
  answer: string;
  answerType?: AnswerType;
  questionCategory?: string;
  remember: boolean;
}

export interface LearnAnswerResult {
  stored: boolean;
  reason?: string;
  answer?: AnswerBankRecord;
}

/** Question-learning: the user answers a missing question once. Remembered
 *  answers enter the reusable bank; "remember OFF" answers are stored
 *  RUN-SCOPED — used by THIS job's agent loop, never reused elsewhere. */
export function answerQuestionForJob(userId: string, input: LearnAnswerInput): LearnAnswerResult {
  const job = getJobByIdForUser(userId, input.jobId);
  if (!job) return { stored: false, reason: 'JOB_NOT_FOUND' };
  const question = String(input.question || '').trim();
  const answer = String(input.answer || '').trim();
  if (!question || !answer) return { stored: false, reason: 'INVALID_INPUT' };
  if (!input.remember) {
    const record = upsertRunAnswer(userId, input.jobId, {
      canonicalQuestion: question,
      answerType: input.answerType ?? 'TEXTAREA',
      answerValue: answer,
    });
    return { stored: true, reason: 'RUN_ONLY', answer: record };
  }
  const record = upsertAnswer(userId, {
    canonicalQuestion: question,
    canonicalKey: canonicalKeyForQuestion(question),
    questionCategory: input.questionCategory,
    answerType: input.answerType ?? 'TEXTAREA',
    answerValue: answer,
    source: 'USER_PROVIDED',
    verificationStatus: 'VERIFIED',
    reusable: true,
  });
  return { stored: true, answer: record };
}

/** Ownership-scoped job lookup (explicit userId, independent of ALS). */
function getJobByIdForUser(userId: string, jobId: string): { id: string } | undefined {
  const row = getDb().prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { id: string } | undefined;
  return row;
}

/** Re-read a stored answer (used by the API layer). */
export function getBankAnswer(userId: string, id: string): AnswerBankRecord | undefined {
  return getAnswerById(userId, id);
}
