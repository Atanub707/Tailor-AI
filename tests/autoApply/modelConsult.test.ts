// MODEL CONSULT + numeric-field handling — regression suite for the reported
// salary incident: "$40k-$60k" typed into a number field became "06040604…"
// (digit garbage re-appended every retry), and questions the deterministic
// layers can't answer never reached any understanding layer.
//
//   * toNumericFieldValue: "$40k-$60k" → 40000, "16 LPA" → 1600000 …
//   * number-kind fields receive a clean number or stay OPEN (asked) — never
//     mangled text;
//   * the model consult answers ONLY from the candidate facts (option
//     membership for choices, fact-text membership for free text) and
//     escalates to the human otherwise.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-consult-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.AUTO_APPLY_ENABLED = 'false';
process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';
process.env.AUTO_APPLY_MODEL_CONSULT = '1'; // hermetic: no api-key dependency

const { getDb, runWithUser, saveMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { ensureAnswerBankSchema, upsertAnswer } = await import('../../server/autoApply/answerBank/answerBankStore.js');
const { resolveAgentValues, toNumericFieldValue } = await import('../../server/autoApply/agentDecision.js');
import type { MasterCv } from '../../src/types.js';

const USER = 'consult-user';
const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'Platform engineer.',
  experiences: [{ id: '1', title: 'Platform Engineer', company: 'Acme', location: 'Bengaluru', dates: '2021 – Present', responsibilities: ['Reduced deployment time by 70%'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes'] }],
  certifications: [],
};

function stubConsult(draft: any) {
  vi.stubGlobal('fetch', async () => ({
    status: 200,
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) } }] }),
    text: async () => '',
  }));
}

describe('numeric fields + model consult', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    ensureAnswerBankSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'C', 'c@test.local');
      saveMasterCv(cv, USER);
      const p = defaultApplicantProfile();
      p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
      p.contact = { city: 'Bengaluru', country: 'India' };
      saveApplicantProfile(p, USER);
      upsertAnswer(USER, { canonicalQuestion: 'What is your target salary range?', questionCategory: 'compensation', answerType: 'TEXT', answerValue: '$40k-$60k', source: 'USER_PROVIDED', reusable: true });
      upsertAnswer(USER, { canonicalQuestion: 'Notice Period', questionCategory: 'availability', answerType: 'TEXT', answerValue: '30 days', source: 'USER_PROVIDED', reusable: true });
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('toNumericFieldValue turns salary/tenure answers into clean numbers', () => {
    expect(toNumericFieldValue('$40k-$60k')).toBe('40000');
    expect(toNumericFieldValue('16 LPA')).toBe('1600000');
    expect(toNumericFieldValue('12LPA')).toBe('1200000');
    expect(toNumericFieldValue('80-100k')).toBe('80000');
    expect(toNumericFieldValue('1,800,000')).toBe('1800000');
    expect(toNumericFieldValue('1800000')).toBe('1800000');
    expect(toNumericFieldValue('negotiable')).toBeUndefined();
    expect(toNumericFieldValue('')).toBeUndefined();
  });

  it('REGRESSION: a number field gets 40000 — never the raw "$40k-$60k" that caused the digit loop', async () => {
    const fields = [{ ref: 'f1', kind: 'number', label: 'What are your salary expectations?' }];
    const values = await resolveAgentValues(USER, fields as any);
    expect(values.get('f1')).toBe('40000');
  });

  it('unparseable answers leave a number field OPEN (asked) instead of typing garbage', async () => {
    runWithUser(USER, () => upsertAnswer(USER, { canonicalQuestion: 'Expected Annual Salary ?', questionCategory: 'compensation', answerType: 'TEXT', answerValue: 'negotiable on discussion', source: 'USER_PROVIDED', reusable: true }));
    const fields = [{ ref: 'f1', kind: 'number', label: 'Expected Annual Salary ?' }];
    const values = await resolveAgentValues(USER, fields as any);
    expect(values.get('f1')).toBeUndefined();
  });

  it('consult answers a free-text question ONLY from the facts (grounded value accepted)', async () => {
    stubConsult({ decisions: [{ index: 0, action: 'answer', value: '30 days', reason: 'SavedAnswer: Notice Period' }] });
    const fields = [{ ref: 'f1', kind: 'text', label: 'How soon can you join us?' }];
    const values = await resolveAgentValues(USER, fields as any);
    expect(values.get('f1')).toBe('30 days');
  });

  it('consult NEVER invents: an ungrounded value is rejected (stays open → ask)', async () => {
    stubConsult({ decisions: [{ index: 0, action: 'answer', value: 'Immediately available', reason: 'guessed' }] });
    const fields = [{ ref: 'f1', kind: 'text', label: 'When can you start working?' }];
    const values = await resolveAgentValues(USER, fields as any);
    expect(values.get('f1')).toBeUndefined();
  });

  it('consult escalates third-party questions to the human (ask)', async () => {
    stubConsult({ decisions: [{ index: 0, action: 'ask', value: undefined, reason: 'referrer unknown' }] });
    const fields = [{ ref: 'f1', kind: 'text', label: 'Who is actually referring?' }];
    const values = await resolveAgentValues(USER, fields as any);
    expect(values.get('f1')).toBeUndefined();
  });
});
