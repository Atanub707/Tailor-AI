// QUESTION-INTENT HARNESS — regression suite for the reported bug:
// "Who is actually referring?" (a referrer question) was auto-filled with
// the APPLICANT'S OWN NAME. Root cause: no entity/intent layer — any label
// containing "name" resolved from the applicant's identity, and "…name…"
// canonicalized to `fullName` (colliding with / overwriting the real one).
//
// The harness guarantees:
//   * referrer/emergency/spouse/manager/reference questions can NEVER be
//     answered with the applicant's own identity;
//   * their bank matches are scoped to entity keys (referrerName, …);
//   * conditional/EEO/citizenship/clearance questions only take EXACT
//     previously-stored answers — never generic concept/fuzzy matches.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-intents-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.AUTO_APPLY_ENABLED = 'false';
process.env.AUTO_APPLY_ANSWER_BANK_ENABLED = 'true';

const { getDb, runWithUser, saveMasterCv } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { ensureAnswerBankSchema, upsertAnswer } = await import('../../server/autoApply/answerBank/answerBankStore.js');
const { canonicalKeyForQuestion } = await import('../../server/autoApply/answerBank/answerCanonicalizer.js');
const { resolveAgentValues } = await import('../../server/autoApply/agentDecision.js');
const {
  classifyQuestionIntent,
  intentAllowsSelfIdentity,
  intentAllowsBankMatch,
} = await import('../../server/autoApply/questionIntents.js');
import type { MasterCv } from '../../src/types.js';

const USER = 'qi-user';
const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'Platform engineer with 5+ years.',
  experiences: [{ id: '1', title: 'Senior Platform Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: '2021 – Present', responsibilities: ['Reduced deployment time by 70%'] }],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};

const fields = (labels: string[]) =>
  labels.map((label, i) => ({ ref: `f${i}`, kind: 'text', label, name: `q${i}` }));

describe('question-intent harness', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    ensureAnswerBankSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'QI', 'qi@test.local');
      saveMasterCv(cv, USER);
      const p = defaultApplicantProfile();
      p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' };
      p.contact = { city: 'Bengaluru', country: 'India' };
      saveApplicantProfile(p, USER);
    });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('classifies the reported question as a REFERRER intent that forbids self-identity', () => {
    const intent = classifyQuestionIntent({ label: 'Who is actually referring?' });
    expect(intent.id).toBe('referral.name');
    expect(intent.entity).toBe('REFERRER');
    expect(intent.forbidsSelfIdentity).toBe(true);
    expect(intentAllowsSelfIdentity(intent)).toBe(false);
    expect(intent.canonicalKeys).toEqual(['referrerName']);
  });

  it('third-party name variants never resolve to SELF; self name questions still do', () => {
    for (const label of [
      'Who is actually referring?',
      'Name of referrer',
      'Referrer name',
      'Name of the referrer',
      'Referring employee name',
      'First name of referrer',
      'Last name of referrer',
      "Please provide the employee's name who referred you",
    ]) {
      const intent = classifyQuestionIntent({ label });
      expect(intent.forbidsSelfIdentity, label).toBe(true);
    }
    for (const [label, id] of [
      ['First Name', 'identity.firstName'],
      ['Last Name', 'identity.lastName'],
      ['Full Name', 'identity.fullName'],
      ['Preferred First Name', 'identity.firstName'],
    ] as Array<[string, string]>) {
      const intent = classifyQuestionIntent({ label });
      expect(intent.entity).toBe('SELF');
      expect(intent.id).toBe(id);
      expect(intentAllowsSelfIdentity(intent)).toBe(true);
    }
  });

  it('other third-party entities are detected (emergency, spouse, manager, reference, family)', () => {
    expect(classifyQuestionIntent({ label: 'Name of emergency contact' }).entity).toBe('EMERGENCY');
    expect(classifyQuestionIntent({ label: 'Spouse name' }).entity).toBe('SPOUSE');
    expect(classifyQuestionIntent({ label: "Manager's name" }).entity).toBe('MANAGER');
    expect(classifyQuestionIntent({ label: 'Name of your supervisor' }).entity).toBe('MANAGER');
    expect(classifyQuestionIntent({ label: 'Professional reference name' }).entity).toBe('REFERENCE');
    expect(classifyQuestionIntent({ label: 'Are you related to anyone at Extreme Networks?' }).entity).toBe('RELATIVE');
  });

  it('conditional / EEO / citizenship / clearance questions are exact-only', () => {
    expect(classifyQuestionIntent({ label: 'If yes, where in the US do you currently live?' }).exactOnly).toBe(true);
    expect(classifyQuestionIntent({ label: 'If you were referred, please provide their name' }).exactOnly).toBe(true);
    expect(classifyQuestionIntent({ label: 'Gender' }).sensitive).toBe(true);
    expect(classifyQuestionIntent({ label: 'Are you a U.S. citizen?' }).exactOnly).toBe(true);
    expect(classifyQuestionIntent({ label: 'Do you hold an active security clearance?' }).exactOnly).toBe(true);
    // ordinary reusable questions stay reusable
    expect(intentAllowsBankMatch(classifyQuestionIntent({ label: 'Do you require sponsorship?' }), 'requiresSponsorship', 'SEMANTIC')).toBe(true);
  });

  it('canonical keys: referrer questions never collide with the applicant fullName', () => {
    expect(canonicalKeyForQuestion('Name of referrer')).toBe('referrerName');
    expect(canonicalKeyForQuestion('First name of referrer')).toBe('referrerName');
    expect(canonicalKeyForQuestion('Who is actually referring?')).toBe('referrerName');
    expect(canonicalKeyForQuestion('Name of emergency contact')).toBe('emergencyContactName');
    expect(canonicalKeyForQuestion('Spouse name')).toBe('spouseName');
    expect(canonicalKeyForQuestion('Full Name')).toBe('fullName');
    expect(canonicalKeyForQuestion('First Name')).toBe('firstName');
    expect(canonicalKeyForQuestion('Preferred First Name')).toBe('firstName');
    expect(canonicalKeyForQuestion('How did you hear about us?')).toBe('referralSource');
    expect(canonicalKeyForQuestion('What is your current (or most recent) company?')).toBe('currentCompany');
  });

  it('REGRESSION: a stored fullName never fills referrer questions — they stay unanswered (→ ask)', async () => {
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Full Name', questionCategory: 'identity', answerType: 'TEXT',
      answerValue: 'Ravi Kumar', source: 'USER_PROVIDED', reusable: true,
    }));
    const fs2 = fields(['Who is actually referring?', 'Name of referrer', 'First name of referrer', 'Name of emergency contact', 'Spouse name', 'First Name', 'Full Name']);
    const values = await resolveAgentValues(USER, fs2);
    expect(values.get('f0')).toBeUndefined(); // the reported bug
    expect(values.get('f1')).toBeUndefined();
    expect(values.get('f2')).toBeUndefined();
    expect(values.get('f3')).toBeUndefined();
    expect(values.get('f4')).toBeUndefined();
    // SELF name questions still resolve from the Master CV identity
    expect(values.get('f5')).toBe('Ravi');
    expect(values.get('f6')).toBe('Ravi Kumar');
  });

  it('a stored REFERRER answer is reused across referral forms (like a human would)', async () => {
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Referrer name', questionCategory: 'referral', answerType: 'TEXT',
      answerValue: 'Priya Sharma', source: 'USER_PROVIDED', reusable: true,
    }));
    const values = await resolveAgentValues(USER, fields(['Name of referrer']));
    expect(values.get('f0')).toBe('Priya Sharma');
  });

  it('conditional follow-ups never resolve from generic matches', async () => {
    // The applicant's city exists (Master CV) — but "If yes, where in the US…"
    // must not receive it; it is conditional and stays a question for the user.
    const values = await resolveAgentValues(USER, fields(['If yes, where in the US do you currently live?']));
    expect(values.get('f0')).toBeUndefined();
  });

  it('ADDRESS: one generic answer per component — re-worded questions reuse it instead of re-asking', async () => {
    // Seed exactly what the user answered in chat (real phrasings from the DB).
    runWithUser(USER, () => {
      upsertAnswer(USER, { canonicalQuestion: 'State*', questionCategory: 'identity', answerType: 'TEXT', answerValue: 'WB', source: 'USER_PROVIDED', reusable: true });
      upsertAnswer(USER, { canonicalQuestion: 'Street Address (include apartment number if applicable)', questionCategory: 'identity', answerType: 'TEXT', answerValue: 'Barrackpore', source: 'USER_PROVIDED', reusable: true });
      upsertAnswer(USER, { canonicalQuestion: 'Location (City)*', questionCategory: 'identity', answerType: 'TEXT', answerValue: 'Kolkata', source: 'USER_PROVIDED', reusable: true });
    });
    const values = await resolveAgentValues(USER, fields([
      'What state do you currently reside in?*', // another form's wording → stateProvince
      'Region', // same component, third wording
      'Zip Code', // never answered → stays a single ask (NOT a wrong match)
      'Town', // → currentCity from "Location (City)*"
      'Mailing Address', // → streetAddress from "Street Address (…)"
    ]));
    expect(values.get('f0')).toBe('WB');
    expect(values.get('f1')).toBe('WB');
    expect(values.get('f2')).toBeUndefined();
    expect(values.get('f3')).toBe('Kolkata');
    expect(values.get('f4')).toBe('Barrackpore');
  });

  it('POISON GUARD: an email stored against a mailing-address question never spreads to other address fields', async () => {
    runWithUser(USER, () => upsertAnswer(USER, {
      canonicalQuestion: 'Please share your mailing address for future reference.', questionCategory: 'identity', answerType: 'TEXT',
      answerValue: 'ravi@example.com', source: 'USER_PROVIDED', reusable: true,
    }));
    const values = await resolveAgentValues(USER, fields(['Street Address', 'Home Address']));
    expect(values.get('f0')).toBeUndefined(); // email is never typed into an address
    expect(values.get('f1')).toBeUndefined();
  });
});
