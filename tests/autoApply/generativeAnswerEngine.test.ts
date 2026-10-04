// Grounded Generative Answer Engine — unit tests.
//
// No network, no LLM: the LLM call is injected. These tests pin:
//   * default OFF + config
//   * fact ledger is grounded and PII-free
//   * eligibility (allowed question categories; blocked categories)
//   * strict validation: hallucinated facts/numbers/companies, placeholders,
//     over-length, invented fact ids, malformed output, timeout
//   * provenance: supporting facts resolve from the ledger
//   * dedupe within one pass
import { describe, it, expect } from 'vitest';
import {
  buildFactLedger,
  classifyGenerativeQuestion,
  emptyGenerativeMeta,
  generativeConfigFromEnv,
  isGenerativeEligible,
  LlmGenerativeAnswerEngine,
  runGenerativePass,
  validateGeneratedAnswer,
  findUnsupportedClaims,
  type GenerativeAnswerEngine,
  type GenerativeAnswerInput,
  type GeneratedAnswer,
} from '../../server/autoApply/generativeAnswerEngine.js';
import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';

const profile = (): ApplicantProfile => {
  const p = {
    version: 1,
    personal: { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', phone: '+91 90000 00000' },
    contact: { city: 'Bengaluru', country: 'India' },
    links: { linkedin: 'https://linkedin.com/in/ravi' },
    locationPrefs: {},
    workAuthorization: { authorizedToWork: 'yes', requiresSponsorship: 'no' },
    preferences: { targetSalary: 2500000, noticePeriod: '30 days' },
    experience: [
      { company: 'Acme Cloud', title: 'Senior Platform Engineer', startDate: '2021-01', isCurrent: true, achievements: ['Reduced deployment time by 70%'] },
      { company: 'Nexus Digital', title: 'DevOps Engineer', startDate: '2018-06', endDate: '2020-12' },
    ],
    education: [], skills: [], certifications: [], applicationDefaults: {}, optionalSensitive: { enabled: false },
  };
  return p as unknown as ApplicantProfile;
};

const cv = (): MasterCv => ({
  fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', location: 'Bengaluru, India',
  summary: 'Platform engineer with 5+ years of Kubernetes and AWS experience.',
  experiences: [
    { id: '1', title: 'Senior Platform Engineer', company: 'Acme Cloud', location: 'Bengaluru', dates: '2021 – Present', responsibilities: ['Built GitLab CI/CD pipelines for 40 services', 'Managed GKE and EKS clusters'] },
    { id: '2', title: 'DevOps Engineer', company: 'Nexus Digital', location: 'Oakland', dates: '2018 – 2020', responsibilities: ['Automated Terraform provisioning'] },
  ],
  education: [{ id: '1', degree: 'B.Tech Computer Science', institution: 'IIT', dates: '2013 – 2017' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform'] }],
  certifications: [{ id: '1', name: 'CKA' }],
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 'gen-j1', externalId: 'e1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen',
  description: 'We are looking for a Platform Engineer to own our Kubernetes platform. Must have 4+ years experience with AWS and Terraform. You will build CI/CD pipelines and improve reliability.',
  atsPlatform: 'lever', applyUrl: 'https://jobs.lever.co/veo/e1', url: 'https://jobs.lever.co/veo/e1', source: 'Lever', state: 'pending',
  ...over,
} as unknown as Job);

// ── Config ───────────────────────────────────────────────────────────────

describe('Generative config', () => {
  it('defaults to disabled with conservative limits', () => {
    delete process.env.AUTO_APPLY_GENERATIVE_ENABLED;
    const cfg = generativeConfigFromEnv();
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxQuestions).toBe(5);
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.maxWords).toBe(120);
  });

  it('empty meta reports disabled', () => {
    expect(emptyGenerativeMeta()).toMatchObject({ engine: 'none', enabled: false, requested: 0, generated: 0, failed: 0 });
  });
});

// ── Fact ledger ──────────────────────────────────────────────────────────

describe('Fact ledger', () => {
  const ledger = buildFactLedger({ profile: profile(), masterCv: cv(), job: job() });

  it('carries grounded candidate + job facts with stable ids', () => {
    expect(ledger.facts.find((f) => f.id === 'exp-1')?.summary).toContain('Senior Platform Engineer');
    expect(ledger.facts.find((f) => f.id === 'exp-1')?.summary).toContain('Acme Cloud');
    expect(ledger.facts.some((f) => f.id.startsWith('skill-') && /kubernetes/i.test(f.summary))).toBe(true);
    expect(ledger.facts.some((f) => f.id === 'cert-1' && f.summary === 'CKA')).toBe(true);
    expect(ledger.facts.some((f) => f.id === 'edu-1')).toBe(true);
    expect(ledger.facts.some((f) => f.id === 'job-1' && f.summary.includes('Veo'))).toBe(true);
    expect(ledger.candidate.currentTitle).toBe('Senior Platform Engineer');
    expect(ledger.candidate.yearsExperience).toBeGreaterThan(3);
  });

  it('contains NO PII (no email/phone/salary/work-authorization/address)', () => {
    const serialized = JSON.stringify(ledger).toLowerCase();
    expect(serialized).not.toContain('ravi@example.com');
    expect(serialized).not.toContain('90000');
    expect(serialized).not.toContain('2500000');
    expect(serialized).not.toContain('authorizedtowork');
    expect(serialized).not.toContain('requiressponsorship');
    expect(serialized).not.toContain('postal');
  });

  it('extracts deterministic JD requirements', () => {
    expect(ledger.job.requirements.join(' ').toLowerCase()).toContain('kubernetes');
    expect(ledger.job.requirements.join(' ').toLowerCase()).toContain('terraform');
    expect(ledger.job.descriptionExcerpt.length).toBeGreaterThan(40);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────

describe('Generative eligibility', () => {
  const eligible = (question: string, answerSource = 'GENERATIVE_REQUIRED') =>
    isGenerativeEligible({ question, answerSource });

  it('allows the supported question categories', () => {
    expect(classifyGenerativeQuestion('Why are you interested in this role?')).toBe('why_role');
    expect(classifyGenerativeQuestion('Why do you want to work at our company?')).toBe('why_company');
    expect(classifyGenerativeQuestion('Why are you a good fit for this position?')).toBe('fit_summary');
    expect(classifyGenerativeQuestion('Tell us about your relevant experience.')).toBe('relevant_experience');
    expect(classifyGenerativeQuestion('Describe a project related to this role.')).toBe('project_experience');
    expect(classifyGenerativeQuestion('What excites you about this opportunity?')).toBe('motivation');
  });

  it('requires GENERATIVE_REQUIRED answerSource', () => {
    expect(eligible('Why are you interested in this role?', 'PROFILE').eligible).toBe(false);
    expect(eligible('Why are you interested in this role?', 'USER_REQUIRED').eligible).toBe(false);
    // Missing answerSource → never eligible (no classification happened).
    expect(isGenerativeEligible({ question: 'Why are you interested in this role?' }).eligible).toBe(false);
    expect(eligible('Why are you interested in this role?').eligible).toBe(true);
  });

  it('blocks sensitive/legal/factual categories even at GENERATIVE_REQUIRED', () => {
    expect(eligible('What is your expected salary?').eligible).toBe(false);
    expect(eligible('Do you require sponsorship?').eligible).toBe(false);
    expect(eligible('Are you authorized to work in the EU?').eligible).toBe(false);
    expect(eligible('What is your notice period?').eligible).toBe(false);
    expect(eligible('Will you require relocation assistance?').eligible).toBe(false);
    expect(eligible('I consent to the processing of my data').eligible).toBe(false);
    expect(eligible('What is your gender?').eligible).toBe(false);
    expect(eligible('Do you have a criminal record?').eligible).toBe(false);
    expect(eligible('Enter the CAPTCHA code').eligible).toBe(false);
  });

  it('does not generate for unrecognized free-text questions', () => {
    expect(eligible('Describe your favorite movie.').eligible).toBe(false);
    expect(eligible('What did you eat for breakfast?').eligible).toBe(false);
  });
});

// ── Grounding validation ─────────────────────────────────────────────────

describe('Grounding validation', () => {
  const ledger = buildFactLedger({ profile: profile(), masterCv: cv(), job: job() });

  it('accepts answers grounded in candidate facts', () => {
    const answer = 'I am interested in this role because I have spent the last five years building Kubernetes platforms at Acme Cloud, where I reduced deployment time by 70%. I would bring hands-on AWS and Terraform experience to your platform team.';
    expect(findUnsupportedClaims(answer, ledger)).toEqual([]);
  });

  it('rejects invented companies and skills', () => {
    const claims = findUnsupportedClaims('At Google I led Kubernetes migrations.', ledger);
    expect(claims.some((c) => /google/i.test(c))).toBe(true);
    expect(findUnsupportedClaims('I have deep Rust experience.', ledger).some((c) => /rust/i.test(c))).toBe(true);
  });

  it('rejects invented numbers/metrics', () => {
    const claims = findUnsupportedClaims('I reduced costs by 93% across the platform.', ledger);
    expect(claims.some((c) => c.includes('93'))).toBe(true);
  });

  it('rejects placeholders and over-length answers', () => {
    expect(validateGeneratedAnswer({ status: 'ANSWERED', answer: 'I am [Your Name] and I love this role.', supportingFactIds: ['exp-1'] }, ledger, 'Why are you interested in this role?', 120).ok).toBe(false);
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(validateGeneratedAnswer({ status: 'ANSWERED', answer: long, supportingFactIds: ['exp-1'] }, ledger, 'Why are you interested in this role?', 120).ok).toBe(false);
  });

  it('rejects invented supporting fact ids and empty answers', () => {
    expect(validateGeneratedAnswer({ status: 'ANSWERED', answer: 'I am excited about this role.', supportingFactIds: ['exp-99'] }, ledger, 'Why are you interested in this role?', 120).ok).toBe(false);
    expect(validateGeneratedAnswer({ status: 'ANSWERED', answer: '   ', supportingFactIds: ['exp-1'] }, ledger, 'Why are you interested in this role?', 120).ok).toBe(false);
    expect(validateGeneratedAnswer({ status: 'NEEDS_USER_INPUT', reason: 'not enough facts' }, ledger, 'Why are you interested in this role?', 120).ok).toBe(false);
  });

  it('blocks generation for a legal question even if asked to validate', () => {
    const v = validateGeneratedAnswer({ status: 'ANSWERED', answer: 'I consent to everything.', supportingFactIds: ['exp-1'] }, ledger, 'I consent to the processing of my data', 120);
    expect(v.ok).toBe(false);
  });
});

// ── LLM engine ───────────────────────────────────────────────────────────

type AskJsonFn = (prompt: string, opts?: { temperature?: number; maxRetries?: number }) => Promise<unknown>;

const engineFor = (askJsonFn: AskJsonFn, over: Partial<{ timeoutMs: number; maxWords: number }> = {}) =>
  new LlmGenerativeAnswerEngine(
    { timeoutMs: over.timeoutMs ?? 500, maxWords: over.maxWords ?? 120 },
    askJsonFn as never
  );

const inputFor = (ledger = buildFactLedger({ profile: profile(), masterCv: cv(), job: job() })): GenerativeAnswerInput => ({
  question: 'Why are you interested in this role?',
  questionCategory: 'why_role',
  job: { title: 'Platform Engineer', company: 'Veo', description: job().description },
  ledger,
});

describe('LlmGenerativeAnswerEngine', () => {
  it('returns a grounded draft with provenance for a valid ANSWERED response', async () => {
    const answer = 'I am interested in this role because I build Kubernetes platforms and CI/CD pipelines. At Acme Cloud I reduced deployment time by 70% and managed GKE and EKS clusters, and I would bring the same AWS and Terraform focus to Veo.';
    const engine = engineFor(async () => ({ status: 'ANSWERED', answer, supportingFactIds: ['exp-1', 'skill-1', 'job-1'], reason: 'grounded' }));
    const draft = await engine.generateAnswer(inputFor());
    expect(draft).not.toBeNull();
    expect(draft!.value).toBe(answer);
    expect(draft!.source).toBe('GENERATED_FROM_CANDIDATE_FACTS');
    expect(draft!.requiresUserReview).toBe(true);
    expect(draft!.supportingFacts.map((f) => f.id)).toEqual(['exp-1', 'skill-1', 'job-1']);
    expect(draft!.supportingFacts[0].source).toBe('MASTER_CV');
  });

  it('returns null for NEEDS_USER_INPUT (insufficient facts)', async () => {
    const engine = engineFor(async () => ({ status: 'NEEDS_USER_INPUT', reason: 'no relevant projects' }));
    expect(await engine.generateAnswer(inputFor())).toBeNull();
  });

  it('returns null for malformed output', async () => {
    expect(await engineFor(async () => ({ foo: 'bar' })).generateAnswer(inputFor())).toBeNull();
    expect(await engineFor(async () => 'not json').generateAnswer(inputFor())).toBeNull();
    expect(await engineFor(async () => { throw new Error('provider exploded'); }).generateAnswer(inputFor())).toBeNull();
  });

  it('returns null on timeout without breaking the caller', async () => {
    const engine = engineFor(() => new Promise(() => { /* never resolves */ }), { timeoutMs: 40 });
    const started = Date.now();
    expect(await engine.generateAnswer(inputFor())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns null when the job description is missing', async () => {
    let called = 0;
    const engine = engineFor(async () => { called += 1; return { status: 'ANSWERED', answer: 'x', supportingFactIds: [] }; });
    const ledger = buildFactLedger({ profile: profile(), masterCv: cv(), job: job({ description: '' }) });
    expect(await engine.generateAnswer({ ...inputFor(ledger), job: { title: 'Platform Engineer', company: 'Veo', description: '' } })).toBeNull();
    expect(called).toBe(0);
  });

  it('rejects a hallucinated supporting fact id', async () => {
    const engine = engineFor(async () => ({ status: 'ANSWERED', answer: 'I am excited about this role at Acme Cloud.', supportingFactIds: ['exp-404'] }));
    expect(await engine.generateAnswer(inputFor())).toBeNull();
  });

  it('rejects a draft with an invented employer', async () => {
    const engine = engineFor(async () => ({ status: 'ANSWERED', answer: 'I led Kubernetes platform work at Google for years.', supportingFactIds: ['exp-1'] }));
    expect(await engine.generateAnswer(inputFor())).toBeNull();
  });
});

// ── Pass orchestration ───────────────────────────────────────────────────

const fakeEngine = (impl: (input: GenerativeAnswerInput) => Promise<GeneratedAnswer | null>): GenerativeAnswerEngine & { calls: GenerativeAnswerInput[] } => {
  const calls: GenerativeAnswerInput[] = [];
  return {
    name: 'fake-gen',
    calls,
    async generateAnswer(input) {
      calls.push(input);
      return impl(input);
    },
  };
};

const draftFor = (question: string): GeneratedAnswer => ({
  value: `Grounded draft for ${question}`,
  source: 'GENERATED_FROM_CANDIDATE_FACTS',
  requiresUserReview: true,
  supportingFacts: [{ id: 'exp-1', source: 'MASTER_CV', summary: 'Senior Platform Engineer at Acme Cloud' }],
  warnings: [],
  questionCategory: 'why_role',
});

describe('runGenerativePass', () => {
  const ledger = buildFactLedger({ profile: profile(), masterCv: cv(), job: job() });
  const jobInput = { title: 'Platform Engineer', company: 'Veo', description: job().description };

  it('generates only for GENERATIVE_REQUIRED suggestions (PROFILE/USER_REQUIRED skipped)', async () => {
    const engine = fakeEngine(async (i) => draftFor(i.question));
    const result = await runGenerativePass({
      engine,
      job: jobInput,
      ledger,
      maxQuestions: 5,
      candidates: [
        { providerFieldId: 'q1', question: 'Why are you interested in this role?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
        { providerFieldId: 'q2', question: 'Preferred location', answerSource: 'PROFILE', category: 'LOCATION' },
        { providerFieldId: 'q3', question: 'What is your notice period?', answerSource: 'USER_REQUIRED', category: 'CUSTOM' },
      ],
    });
    expect(engine.calls).toHaveLength(1);
    expect(result.drafts.get('q1')).toBeTruthy();
    expect(result.drafts.get('q2')).toBeUndefined();
    expect(result.drafts.get('q3')).toBeUndefined();
    expect(result.meta).toMatchObject({ engine: 'fake-gen', enabled: true, requested: 1, generated: 1, failed: 0 });
  });

  it('never generates for blocked categories even at GENERATIVE_REQUIRED', async () => {
    const engine = fakeEngine(async (i) => draftFor(i.question));
    const result = await runGenerativePass({
      engine, job: jobInput, ledger, maxQuestions: 5,
      candidates: [
        { providerFieldId: 'salary', question: 'What is your expected salary?', answerSource: 'GENERATIVE_REQUIRED', category: 'COMPENSATION' },
        { providerFieldId: 'legal', question: 'I consent to the processing of my data', answerSource: 'GENERATIVE_REQUIRED', category: 'CONSENT' },
        { providerFieldId: 'eeo', question: 'What is your gender?', answerSource: 'GENERATIVE_REQUIRED', category: 'EEO' },
      ],
    });
    expect(engine.calls).toHaveLength(0);
    expect(result.drafts.size).toBe(0);
    expect(result.meta.requested).toBe(0);
  });

  it('dedupes identical questions within one pass', async () => {
    const engine = fakeEngine(async (i) => draftFor(i.question));
    const result = await runGenerativePass({
      engine, job: jobInput, ledger, maxQuestions: 5,
      candidates: [
        { providerFieldId: 'q1', question: 'Why are you interested in this role?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
        { providerFieldId: 'q2', question: 'why are you interested in this role', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
      ],
    });
    expect(engine.calls).toHaveLength(1);
    expect(result.drafts.get('q1')).toBeTruthy();
    expect(result.drafts.get('q2')).toBeTruthy();
  });

  it('caps the number of generations', async () => {
    const engine = fakeEngine(async (i) => draftFor(i.question));
    const result = await runGenerativePass({
      engine, job: jobInput, ledger, maxQuestions: 1,
      candidates: [
        { providerFieldId: 'q1', question: 'Why are you interested in this role?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
        { providerFieldId: 'q2', question: 'Why do you want to work at our company?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
      ],
    });
    expect(engine.calls).toHaveLength(1);
    expect(result.drafts.size).toBe(1);
  });

  it('failure of one question never breaks the pass', async () => {
    const engine = fakeEngine(async (i) => (i.question.includes('company') ? null : draftFor(i.question)));
    const result = await runGenerativePass({
      engine, job: jobInput, ledger, maxQuestions: 5,
      candidates: [
        { providerFieldId: 'q1', question: 'Why are you interested in this role?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
        { providerFieldId: 'q2', question: 'Why do you want to work at our company?', answerSource: 'GENERATIVE_REQUIRED', category: 'CUSTOM' },
      ],
    });
    expect(result.drafts.get('q1')).toBeTruthy();
    expect(result.drafts.get('q2')).toBeUndefined();
    expect(result.meta).toMatchObject({ requested: 2, generated: 1, failed: 1 });
  });
});
