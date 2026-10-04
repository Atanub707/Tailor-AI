// Lever question catalog — the questions Lever applications actually ask,
// seeded into the user's Answer Bank as PENDING (answer once, reuse forever).
//
// Policies:
//  - EEO / demographic questions (gender, race, veteran, disability, pronouns)
//    are SENSITIVE: never inferred, never auto-answered — but the user may
//    explicitly answer them here, and their own verified answer then fills.
//  - Option lists are Lever's standard choices. If a board uses different
//    option strings, the fill layer flags a mismatch and pauses for review
//    (safe by design) — it never guesses.
import { collectPendingQuestions } from './answerBankStore.js';
import type { AnswerType, AnswerSensitivity } from './answerBankTypes.js';

export interface LeverCatalogQuestion {
  key: string;
  question: string;
  category: string;
  answerType: AnswerType;
  options?: string[];
  sensitivity: AnswerSensitivity;
}

const YES_NO = ['Yes', 'No'];
const DECLINE = 'Decline To Self Identify';

export const LEVER_COMMON_QUESTIONS: LeverCatalogQuestion[] = [
  // ── Eligibility & logistics ──────────────────────────────────────────────
  { key: 'work_authorization', question: 'Are you legally authorized to work in your country of residence?', category: 'ELIGIBILITY', answerType: 'SINGLE_SELECT', options: YES_NO, sensitivity: 'NORMAL' },
  { key: 'sponsorship', question: 'Will you now or in the future require sponsorship for employment visa status?', category: 'ELIGIBILITY', answerType: 'SINGLE_SELECT', options: YES_NO, sensitivity: 'NORMAL' },
  { key: 'current_location', question: 'What is your current location?', category: 'LOGISTICS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'relocate', question: 'Are you willing to relocate?', category: 'LOGISTICS', answerType: 'SINGLE_SELECT', options: YES_NO, sensitivity: 'NORMAL' },
  { key: 'travel', question: 'Are you willing to travel?', category: 'LOGISTICS', answerType: 'SINGLE_SELECT', options: YES_NO, sensitivity: 'NORMAL' },
  { key: 'work_mode', question: 'What is your preferred work mode?', category: 'LOGISTICS', answerType: 'SINGLE_SELECT', options: ['Remote', 'Hybrid', 'On-site', 'Flexible'], sensitivity: 'NORMAL' },
  { key: 'notice_period', question: 'What is your notice period?', category: 'LOGISTICS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'start_date', question: 'What is your earliest available start date?', category: 'LOGISTICS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'expected_compensation', question: 'What is your expected compensation?', category: 'COMPENSATION', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'experience_years', question: 'How many years of relevant experience do you have?', category: 'EXPERIENCE', answerType: 'NUMBER', sensitivity: 'NORMAL' },
  { key: 'current_company', question: 'What is your current (or most recent) company?', category: 'EXPERIENCE', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'hear_about', question: 'How did you hear about this job?', category: 'SOURCE', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'linkedin_url', question: 'LinkedIn profile URL', category: 'LINKS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'github_url', question: 'GitHub profile URL', category: 'LINKS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  { key: 'portfolio_url', question: 'Portfolio URL', category: 'LINKS', answerType: 'TEXT', sensitivity: 'NORMAL' },
  // ── Written answers ──────────────────────────────────────────────────────
  { key: 'why_change', question: 'Why are you looking for a change?', category: 'MOTIVATION', answerType: 'TEXTAREA', sensitivity: 'NORMAL' },
  { key: 'why_role', question: 'Why are you interested in this role?', category: 'MOTIVATION', answerType: 'TEXTAREA', sensitivity: 'NORMAL' },
  { key: 'additional_info', question: 'Additional information', category: 'OPEN', answerType: 'TEXTAREA', sensitivity: 'NORMAL' },
  { key: 'anything_else', question: 'Is there anything else we should know?', category: 'OPEN', answerType: 'TEXTAREA', sensitivity: 'NORMAL' },
  // ── Voluntary demographic (SENSITIVE — user-provided answers only) ───────
  { key: 'gender', question: 'Gender', category: 'EEO', answerType: 'SINGLE_SELECT', options: ['Male', 'Female', DECLINE], sensitivity: 'SENSITIVE' },
  { key: 'race', question: 'Race / Ethnicity', category: 'EEO', answerType: 'SINGLE_SELECT', options: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races', DECLINE], sensitivity: 'SENSITIVE' },
  { key: 'veteran_status', question: 'Veteran status', category: 'EEO', answerType: 'SINGLE_SELECT', options: ['I am a protected veteran', 'I am not a protected veteran', DECLINE], sensitivity: 'SENSITIVE' },
  { key: 'disability_status', question: 'Disability status', category: 'EEO', answerType: 'SINGLE_SELECT', options: ['Yes, I have a disability, or have had one in the past', "No, I don't have a disability, or have had one in the past", 'I do not want to answer'], sensitivity: 'SENSITIVE' },
  { key: 'pronouns', question: 'What are your pronouns?', category: 'EEO', answerType: 'TEXT', sensitivity: 'SENSITIVE' },
];

/**
 * Seed the user's bank with every catalog question not already present.
 * Idempotent; creates PENDING (non-reusable, review-required) entries only —
 * nothing can be filled until the user answers it.
 */
export function seedLeverCatalog(userId: string): { created: number; skipped: number } {
  return collectPendingQuestions(
    userId,
    LEVER_COMMON_QUESTIONS.map((q) => ({
      question: q.question,
      category: q.category,
      answerType: q.answerType,
      options: q.options,
      sensitivity: q.sensitivity,
    }))
  );
}
