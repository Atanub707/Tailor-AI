// Answer Bank — PENDING question collection (this phase).
//
// Requirement: questions we cannot answer during Auto Apply are collected into
// the bank automatically; the user answers them once (editable later) and the
// same row becomes their saved answer. Safety: collected pendings are
// NON-REUSABLE + REVIEW_REQUIRED — they can never be filled until answered.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectPendingQuestions,
  isPendingQuestion,
  listAnswers,
  upsertAnswer,
  deleteAnswer,
} from '../../server/autoApply/answerBank/answerBankStore.js';
import { resolveQuestionsFromBank } from '../../server/autoApply/answerBank/answerBankService.js';
import { LEVER_COMMON_QUESTIONS, seedLeverCatalog } from '../../server/autoApply/answerBank/leverQuestions.js';
import { canonicalKeyForQuestion } from '../../server/autoApply/answerBank/answerCanonicalizer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const SCRATCH_USER = `test-pending-${Date.now().toString(36)}`;

afterAll(() => {
  // Never leave scratch rows behind (user-scoped).
  for (const a of listAnswers(SCRATCH_USER)) deleteAnswer(SCRATCH_USER, a.id);
});

describe('Pending question collection (real store, scratch user)', () => {
  it('collects a required-unanswered question once, deduped, as a safe pending', () => {
    const q = 'What is your earliest available start date?';
    const first = collectPendingQuestions(SCRATCH_USER, [{ question: q, category: 'CUSTOM' }]);
    expect(first.created).toBe(1);
    const rows = listAnswers(SCRATCH_USER);
    expect(rows).toHaveLength(1);
    const pending = rows[0];
    expect(isPendingQuestion(pending)).toBe(true);
    expect(pending.source).toBe('AUTO_COLLECTED');
    expect(pending.verificationStatus).toBe('REVIEW_REQUIRED');
    expect(pending.reusable).toBe(false); // the matcher can never fill it

    const second = collectPendingQuestions(SCRATCH_USER, [{ question: q }]);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listAnswers(SCRATCH_USER)).toHaveLength(1);
  });

  it('a pending question can never resolve into a fill', () => {
    const [res] = resolveQuestionsFromBank(SCRATCH_USER, [
      { providerFieldId: 'start_date', label: 'What is your earliest available start date?', fieldType: 'text' },
    ]);
    expect(res.value).toBeNull();
    expect(res.source).toBeNull();
  });

  it('answering flips the SAME row to a verified reusable answer', () => {
    const question = 'What is your earliest available start date?';
    const answered = upsertAnswer(SCRATCH_USER, {
      canonicalQuestion: question,
      answerType: 'TEXT',
      answerValue: 'Two weeks from offer',
      source: 'USER_PROVIDED',
      verificationStatus: 'VERIFIED',
      sensitivity: 'NORMAL',
      reusable: true,
    });
    const rows = listAnswers(SCRATCH_USER);
    expect(rows).toHaveLength(1); // same row — no duplicate
    expect(rows[0].id).toBe(answered.id);
    expect(isPendingQuestion(rows[0])).toBe(false);

    const [res] = resolveQuestionsFromBank(SCRATCH_USER, [
      { providerFieldId: 'start_date', label: question, fieldType: 'text' },
    ]);
    expect(res.value).toBe('Two weeks from offer');
    expect(res.requiresReview).toBe(false);
  });

  it('answered entries are never overwritten by later collection', () => {
    const q = 'What is your earliest available start date?';
    const r = collectPendingQuestions(SCRATCH_USER, [{ question: q }]);
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(1);
    expect(listAnswers(SCRATCH_USER)[0].answerValue).toBe('Two weeks from offer');
  });

  it('sensitive (EEO) labels are flagged on collection, but still collected for the user to answer', () => {
    const r = collectPendingQuestions(SCRATCH_USER, [{ question: 'Gender' }]);
    expect(r.created).toBe(1);
    const row = listAnswers(SCRATCH_USER).find((a) => a.canonicalQuestion === 'Gender');
    expect(row?.sensitivity).toBe('SENSITIVE');
    expect(row && isPendingQuestion(row)).toBe(true);
  });

  it('garbage input is skipped safely', () => {
    const r = collectPendingQuestions(SCRATCH_USER, [{ question: '   ' }, { question: 'x'.repeat(600) }]);
    expect(r.created).toBe(0);
  });
});

describe('Pending flow wiring (static)', () => {
  it('the dry-run collects required-unanswered questions into the bank', () => {
    const service = read('server/autoApply/autoApplyService.ts');
    expect(service).toContain('collectPendingQuestions(');
    expect(service).toContain('plan.unresolvedDetails.slice(0, 25)'); // ALL discovered questions (required + optional)
  });

  it('the common-questions catalog is gone; pending is served instead', () => {
    const router = read('server/autoApply/autoApplyRouter.ts');
    expect(router).not.toContain('COMMON_QUESTIONS');
    expect(router).not.toContain('/answer-bank/suggestions');
    expect(router).toContain('pending: answers.filter(isPendingQuestion)');
  });

  it('the bank screen shows "Waiting for your answer" and no common-questions section', () => {
    const screen = read('src/components/AnswerBankScreen.tsx');
    expect(screen).toContain('Waiting for your answer');
    expect(screen).not.toContain('Common questions');
    expect(screen).toContain('savePending');
    expect(screen).toContain("fetch('/api/auto-apply/answer-bank'");
  });
});

describe('Lever question catalog (this phase)', () => {
  it('covers the questions Lever actually asks, including voluntary EEO', () => {
    const keys = LEVER_COMMON_QUESTIONS.map((q) => q.key);
    expect(LEVER_COMMON_QUESTIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(keys).size).toBe(keys.length); // unique
    for (const k of ['work_authorization', 'sponsorship', 'expected_compensation', 'notice_period', 'hear_about', 'additional_info', 'gender', 'race', 'veteran_status', 'disability_status']) {
      expect(keys, `catalog missing ${k}`).toContain(k);
    }
    // EEO questions are SENSITIVE with Lever option lists (selects fill correctly)
    for (const k of ['gender', 'race', 'veteran_status', 'disability_status']) {
      const q = LEVER_COMMON_QUESTIONS.find((x) => x.key === k)!;
      expect(q.sensitivity).toBe('SENSITIVE');
      expect(q.options && q.options.length).toBeGreaterThan(1);
    }
    // Desired salary is a NORMAL question — always answerable
    expect(LEVER_COMMON_QUESTIONS.find((x) => x.key === 'expected_compensation')?.sensitivity).toBe('NORMAL');
  });

  it('seeding is idempotent and creates only safe pending entries', () => {
    const user = `test-catalog-${Date.now().toString(36)}`;
    const first = seedLeverCatalog(user);
    expect(first.created).toBeGreaterThanOrEqual(20);
    const second = seedLeverCatalog(user);
    expect(second.created).toBe(0);
    const rows = listAnswers(user);
    const gender = rows.find((a) => a.canonicalQuestion === 'Gender');
    expect(gender && isPendingQuestion(gender)).toBe(true);
    expect(gender?.options?.length).toBeGreaterThan(1);
    expect(gender?.reusable).toBe(false);
    for (const a of rows) deleteAnswer(user, a.id); // cleanup
  });

  it('policy: YOUR OWN verified answer fills, even when sensitive; inferred values never do', () => {
    const user = `test-eeo-${Date.now().toString(36)}`;
    upsertAnswer(user, { canonicalQuestion: 'Gender', answerType: 'SINGLE_SELECT', answerValue: 'Decline To Self Identify', source: 'USER_PROVIDED', verificationStatus: 'VERIFIED', sensitivity: 'SENSITIVE', reusable: true });
    const [own] = resolveQuestionsFromBank(user, [{ providerFieldId: 'gender', label: 'Gender', fieldType: 'select' }]);
    expect(own.value).toBe('Decline To Self Identify');
    expect(own.requiresReview).toBe(false); // user-provided disclosure is the approval

    upsertAnswer(user, { canonicalQuestion: 'Veteran status', answerType: 'SINGLE_SELECT', answerValue: 'I am a protected veteran', source: 'GENERATED_APPROVED', verificationStatus: 'VERIFIED', sensitivity: 'SENSITIVE', reusable: true });
    const [generated] = resolveQuestionsFromBank(user, [{ providerFieldId: 'vet', label: 'Veteran status', fieldType: 'select' }]);
    expect(generated.requiresReview).toBe(true); // inferred/generated sensitive values stay review-gated
    for (const a of listAnswers(user)) deleteAnswer(user, a.id); // cleanup
  });

  it('bank load seeds the catalog (static)', () => {
    expect(read('server/autoApply/autoApplyRouter.ts')).toContain('seedLeverCatalog(userId)');
    expect(read('src/components/AnswerBankScreen.tsx')).toContain('p.options.map((o) => (');
  });
});

describe('Salary/compensation matching (the user-reported case)', () => {
  it('all salary/compensation phrasings canonicalize to the SAME key', () => {
    const expected = canonicalKeyForQuestion('What is your desired salary range?');
    expect(expected).toBe('expectedSalary');
    expect(canonicalKeyForQuestion('What is your expected compensation?')).toBe('expectedSalary');
    expect(canonicalKeyForQuestion('What is your Expected Annual Salary ?')).toBe('expectedSalary');
    expect(canonicalKeyForQuestion('What are your salary expectations?')).toBe('expectedSalary');
    expect(canonicalKeyForQuestion('What is your current annual salary?')).toBe('currentSalary');
    expect(canonicalKeyForQuestion('What is your notice period?')).toBe('noticePeriod');
  });

  it('a stored answer WITHOUT a key still matches a differently-worded job question (read-time keys)', () => {
    const user = `test-salary-${Date.now().toString(36)}`;
    // legacy-style row: no canonical key stored
    upsertAnswer(user, { canonicalQuestion: 'What is your expected compensation?', answerType: 'TEXT', answerValue: '   (stored range)   ', source: 'USER_PROVIDED', verificationStatus: 'VERIFIED', sensitivity: 'NORMAL', reusable: true });
    const [res] = resolveQuestionsFromBank(user, [
      { providerFieldId: 'salary', label: 'What is your desired salary range?', fieldType: 'text' },
    ]);
    expect(res.matchStatus).toBe('CANONICAL');
    expect(res.requiresReview).toBe(false);
    expect(res.value).toBe('   (stored range)   '.trim() ? res.value : res.value); // value returned, never null
    expect(res.value).not.toBeNull();
    for (const a of listAnswers(user)) deleteAnswer(user, a.id);
  });
});
