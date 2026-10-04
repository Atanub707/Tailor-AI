// Auto Apply — Grounded Generative Answer Engine.
//
// Drafts SHORT answers to GENERATIVE_REQUIRED application questions using
// ONLY verified candidate facts (Applicant Profile + Master CV), the real
// job description, and — when available — the VERIFIED tailored resume.
//
// Hard boundaries:
//   * default DISABLED (AUTO_APPLY_GENERATIVE_ENABLED=false)
//   * reuses the repository's ONE LLM integration (`askJson` → llmAdapter)
//   * never invents facts: a deterministic grounding check rejects answers
//     that mention companies/skills/numbers absent from the fact ledger
//   * only allowed question categories; salary/work-auth/legal/EEO/etc. are
//     blocked before any LLM call
//   * every draft is review-required — drafts are never auto-approved
//   * any failure (LLM/timeout/malformed/ungrounded) → null → the field
//     stays needs-input and the dry run continues

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import type { TailorDraft } from '../tailorV2/drafter.js';
import { parseJobRequirements } from '../fit/requirementsParser.js';
import { experienceYears } from '../fit/experience.js';
import { askJson } from '../llm/askJson.js';
import { isHardBlockedField } from './decisionEngine.js';
import type { FieldCategory } from '../applicationEngine/contract.js';

// ── Config (env; DISABLED by default) ────────────────────────────────────

export interface GenerativeConfig {
  enabled: boolean;
  maxQuestions: number;
  timeoutMs: number;
  maxWords: number;
}

function envInt(key: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : fallback;
}

export function generativeConfigFromEnv(): GenerativeConfig {
  return {
    enabled: (process.env.AUTO_APPLY_GENERATIVE_ENABLED ?? 'false') === 'true',
    maxQuestions: envInt('AUTO_APPLY_GENERATIVE_MAX_QUESTIONS', 5, 1, 20),
    timeoutMs: envInt('AUTO_APPLY_GENERATIVE_TIMEOUT_MS', 15000, 1000, 120000),
    maxWords: envInt('AUTO_APPLY_GENERATED_ANSWER_MAX_WORDS', 120, 40, 300),
  };
}

// ── Fact ledger (grounding source of truth) ──────────────────────────────

export type LedgerFactSource = 'PROFILE' | 'MASTER_CV' | 'JOB' | 'TAILORED_CV';

export interface LedgerFact {
  id: string;
  source: LedgerFactSource;
  kind: 'candidate' | 'experience' | 'skill' | 'certification' | 'education' | 'job' | 'highlight';
  summary: string;
}

export interface FactLedger {
  candidate: {
    currentTitle?: string;
    yearsExperience?: number;
    location?: string;
    summary?: string;
  };
  skills: string[];
  certifications: string[];
  experience: Array<{ id: string; title: string; company: string; dates?: string; responsibilities: string[] }>;
  education: Array<{ id: string; degree?: string; institution?: string; dates?: string }>;
  job: {
    title: string;
    company: string;
    requirements: string[];
    responsibilities: string[];
    descriptionExcerpt: string;
  };
  facts: LedgerFact[];
  /** Lowercased candidate-only text (numbers must appear here). Internal. */
  candidateText: string;
  /** Lowercased candidate + job text (proper nouns must appear here). Internal. */
  contextText: string;
}

const MAX_SKILLS = 40;
const MAX_CERTS = 20;
const MAX_EXPERIENCE = 6;
const MAX_RESPONSIBILITIES = 6;
const MAX_JD_LINES = 8;
const MAX_JD_EXCERPT = 1500;
const MAX_SUMMARY = 400;

function cap(text: unknown, max: number): string {
  return String(text ?? '').trim().slice(0, max);
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function jdResponsibilityLines(description: string): string[] {
  return String(description || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-*·]+/, '').trim())
    .filter((l) => l.length >= 20 && l.length <= 200)
    .slice(0, MAX_JD_LINES);
}

export interface BuildLedgerInput {
  profile: ApplicantProfile;
  masterCv: MasterCv;
  job: Job;
  /** VERIFIED Tailor V2 draft only (never the unverified V1 output). */
  tailoredDraft?: TailorDraft;
}

/** Build the minimal, PII-free fact ledger used for grounding + provenance. */
export function buildFactLedger(input: BuildLedgerInput): FactLedger {
  const { profile, masterCv, job } = input;
  const facts: LedgerFact[] = [];

  // Candidate headline
  const latestProfileExp = (profile.experience || []).find((e) => e.isCurrent) ?? (profile.experience || [])[0];
  const currentTitle = latestProfileExp?.title || masterCv.experiences?.[0]?.title || undefined;
  const years = experienceYears(profile.experience || []);
  const location = [profile.contact?.city, profile.contact?.country].filter(Boolean).join(', ') || cap(masterCv.location, 80) || undefined;
  const summary = cap(masterCv.summary, MAX_SUMMARY) || undefined;

  const candidate: FactLedger['candidate'] = {
    currentTitle,
    yearsExperience: years.known ? years.years : undefined,
    location,
    summary,
  };
  facts.push({
    id: 'candidate-1',
    source: 'MASTER_CV',
    kind: 'candidate',
    summary: [currentTitle, summary].filter(Boolean).join(' — ').slice(0, 300) || 'Candidate profile',
  });

  // Skills (profile first, then Master CV), certifications, experience, education
  const skills = uniqueStrings([
    ...(profile.skills || []).map((s) => s.name),
    ...(masterCv.skills || []).flatMap((s) => (Array.isArray(s.items) ? s.items : [])),
  ]).slice(0, MAX_SKILLS);
  skills.forEach((skill, i) => facts.push({ id: `skill-${i + 1}`, source: 'PROFILE', kind: 'skill', summary: skill }));

  const certifications = uniqueStrings([
    ...(profile.certifications || []).map((c) => c.name),
    ...(masterCv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name)),
  ]).slice(0, MAX_CERTS);
  certifications.forEach((cert, i) => facts.push({ id: `cert-${i + 1}`, source: 'MASTER_CV', kind: 'certification', summary: cert }));

  // Experience: Master CV is authoritative; matching profile entries contribute
  // their configured achievements/summary (candidate-owned facts too).
  const profileExpByKey = new Map(
    (profile.experience || []).map((e) => [`${String(e.company || '').toLowerCase()}|${String(e.title || '').toLowerCase()}`, e])
  );
  const experience = (masterCv.experiences || []).slice(0, MAX_EXPERIENCE).map((e, i) => {
    const match = profileExpByKey.get(`${String(e.company || '').toLowerCase()}|${String(e.title || '').toLowerCase()}`);
    const merged = uniqueStrings([
      ...(e.responsibilities || []),
      ...((match?.achievements || []) as string[]),
      ...(match?.summary ? [match.summary] : []),
    ]).slice(0, MAX_RESPONSIBILITIES);
    profileExpByKey.delete(`${String(e.company || '').toLowerCase()}|${String(e.title || '').toLowerCase()}`);
    return { id: `exp-${i + 1}`, title: e.title, company: e.company, dates: e.dates || undefined, responsibilities: merged.map((r) => cap(r, 240)) };
  });
  experience.forEach((e) => {
    facts.push({
      id: e.id,
      source: 'MASTER_CV',
      kind: 'experience',
      summary: `${e.title} at ${e.company}${e.dates ? ` (${e.dates})` : ''}`.slice(0, 200),
    });
  });
  // Profile-only roles (not present in the Master CV) become PROFILE facts.
  for (const e of profileExpByKey.values()) {
    if (experience.length >= MAX_EXPERIENCE + 2) break;
    const id = `exp-${experience.length + 1}`;
    const responsibilities = uniqueStrings([...(e.achievements || []), ...(e.summary ? [e.summary] : [])]).slice(0, MAX_RESPONSIBILITIES).map((r) => cap(r, 240));
    if (!e.title && !e.company && responsibilities.length === 0) continue;
    experience.push({ id, title: e.title || 'Role', company: e.company || 'Company', dates: undefined, responsibilities });
    facts.push({ id, source: 'PROFILE', kind: 'experience', summary: `${e.title || 'Role'} at ${e.company || 'Company'}`.slice(0, 200) });
  }

  const education = (masterCv.education || []).map((e, i) => ({
    id: `edu-${i + 1}`,
    degree: e.degree || undefined,
    institution: e.institution || undefined,
    dates: e.dates || undefined,
  }));
  education.forEach((e) => {
    facts.push({ id: e.id, source: 'MASTER_CV', kind: 'education', summary: [e.degree, e.institution, e.dates].filter(Boolean).join(', ').slice(0, 200) });
  });

  // Verified tailored highlights (V2 only) — still candidate-owned evidence.
  const tailoredHighlights: string[] = [];
  if (input.tailoredDraft) {
    const exp = (input.tailoredDraft.experience || []).slice(0, MAX_EXPERIENCE);
    exp.forEach((e, i) => {
      (e.highlights || []).slice(0, MAX_RESPONSIBILITIES).forEach((h) => tailoredHighlights.push(cap(h, 240)));
      if (tailoredHighlights.length) {
        facts.push({ id: `tailored-${i + 1}`, source: 'TAILORED_CV', kind: 'highlight', summary: cap(e.highlights?.[0], 200) || `${e.title} at ${e.company}` });
      }
    });
  }

  // Job
  const reqs = parseJobRequirements(job.description || '', { location: job.location, workMode: undefined });
  const requirements = uniqueStrings([
    ...reqs.requiredSkills,
    ...reqs.preferredSkills,
    ...reqs.unknownStrengthSkills,
    reqs.minYears !== undefined ? `${reqs.minYears}+ years experience` : '',
    reqs.education?.level ? `${reqs.education.level} degree` : '',
    reqs.workMode ? `${reqs.workMode} work` : '',
  ]).slice(0, 20);
  const jobSection: FactLedger['job'] = {
    title: cap(job.title, 120),
    company: cap(job.company, 120),
    requirements,
    responsibilities: jdResponsibilityLines(job.description || ''),
    descriptionExcerpt: cap(job.description, MAX_JD_EXCERPT),
  };
  facts.push({ id: 'job-1', source: 'JOB', kind: 'job', summary: `${jobSection.title} at ${jobSection.company}`.slice(0, 200) });

  // Grounding texts (internal): numbers must be candidate facts; proper nouns
  // may also come from the job context.
  const candidateText = [
    candidate.currentTitle,
    candidate.yearsExperience !== undefined ? String(candidate.yearsExperience) : '',
    candidate.yearsExperience !== undefined ? String(Math.floor(candidate.yearsExperience)) : '',
    candidate.location,
    candidate.summary,
    ...skills,
    ...certifications,
    ...experience.flatMap((e) => [e.title, e.company, e.dates, ...e.responsibilities]),
    ...education.flatMap((e) => [e.degree, e.institution, e.dates]),
    ...tailoredHighlights,
  ]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  const contextText = [
    candidateText,
    jobSection.title,
    jobSection.company,
    ...jobSection.requirements,
    ...jobSection.responsibilities,
    jobSection.descriptionExcerpt,
  ]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  return {
    candidate,
    skills,
    certifications,
    experience,
    education,
    job: jobSection,
    facts,
    candidateText,
    contextText,
  };
}

// ── Eligibility (allowed vs blocked question categories) ─────────────────

export type GenerativeQuestionCategory =
  | 'motivation'
  | 'why_company'
  | 'why_role'
  | 'fit_summary'
  | 'relevant_experience'
  | 'project_experience'
  | 'technical_experience_summary';

const QUESTION_CATEGORY_PATTERNS: Array<{ category: GenerativeQuestionCategory; re: RegExp }> = [
  { category: 'why_company', re: /why (do you want to work|work at|join|choose)|what (interests|excites|attracts) you about (our|the) (company|product|mission|team)|why our (company|product|mission)/i },
  { category: 'why_role', re: /why (are you interested|do you want this|this role|this position|this job|are you applying)|what interests you about (this|the) (role|position|job)/i },
  { category: 'fit_summary', re: /(why|how) (are you|would you be|do you think you are) .{0,40}?(good|great|strong|best)? ?fit|what makes you a (good|great|strong) fit|why should we (hire|choose|consider)|what would you bring/i },
  { category: 'project_experience', re: /(describe|tell us about|share|walk us through) (a|an|your) ?(project|portfolio|piece of work|work sample)|project (you|experience|work)/i },
  { category: 'relevant_experience', re: /(tell us about|describe|summari[sz]e|summary of|highlight) your (relevant|related|professional)? ?(experience|background)|(relevant|related) experience|experience (relevant|related) to (this|the)/i },
  { category: 'technical_experience_summary', re: /technical (experience|background|expertise|skills)|experience with (our|the) (stack|technolog)|how have you (used|worked with)|your (technical|engineering) (experience|background)/i },
  { category: 'motivation', re: /(interest|excit|passion|motivat|enthusias|why .{0,30}(apply|consider))/i },
];

/** Question categories that must NEVER be generated, on top of the existing
 *  hard blocks (consent/EEO/legal/CAPTCHA/OTP/MFA/password/background). */
const GENERATIVE_BLOCKED_RE = /(salary|compensation|expected pay|desired pay|pay expectation|work authorization|authorized to work|right to work|work permit|sponsorship|sponsor|visa|immigration|relocation|notice period|availability to start|earliest start|when can you start|criminal|conviction|background check|drug (test|screen)|security clearance|date of birth|\bage\b)/i;

export function classifyGenerativeQuestion(question: string): GenerativeQuestionCategory | null {
  const text = String(question || '').trim();
  if (!text) return null;
  for (const { category, re } of QUESTION_CATEGORY_PATTERNS) {
    if (re.test(text)) return category;
  }
  return null;
}

export interface EligibilityInput {
  question: string;
  answerSource?: string;
  category?: string;
}

/** Generation is allowed ONLY for GENERATIVE_REQUIRED + allowed category +
 *  not blocked. Deterministic; no LLM involved. */
export function isGenerativeEligible(input: EligibilityInput): { eligible: boolean; category?: GenerativeQuestionCategory; reason?: string } {
  if (input.answerSource !== 'GENERATIVE_REQUIRED') {
    return { eligible: false, reason: 'answerSource is not GENERATIVE_REQUIRED' };
  }
  const question = String(input.question || '');
  const stub = {
    category: (String(input.category || 'UNKNOWN').toUpperCase() as FieldCategory),
    confidence: 1,
    mappingMethod: 'AI_SUGGESTED' as const,
    requiresUser: true,
  };
  if (isHardBlockedField(stub, question) || GENERATIVE_BLOCKED_RE.test(question)) {
    return { eligible: false, reason: 'blocked category — deterministic/user-required only' };
  }
  const category = classifyGenerativeQuestion(question);
  if (!category) return { eligible: false, reason: 'unrecognized question category' };
  return { eligible: true, category };
}

// ── Grounding validation ─────────────────────────────────────────────────

const NUMBER_RE = /\b\d+(?:[.,]\d+)?%?\b/g;
const PROPER_RE = /\b[A-Z][A-Za-z0-9.+#&'-]{2,}\b/g;
const PLACEHOLDER_RE = /(\[[^\]]{2,60}\]|\{\{[^}]{2,60}\}\}|<[^>]{2,60}>|\bTODO\b|\bXXX\b|lorem ipsum|\bYOUR_[A-Z_]+\b|\bINSERT\b)/i;

const PROPER_STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'and', 'but', 'for', 'with', 'from', 'into', 'over', 'under',
  'our', 'your', 'their', 'its', 'his', 'her', 'they', 'them', 'there', 'here', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'then', 'too', 'very', 'just', 'about', 'because', 'also', 'however', 'additionally', 'furthermore',
  'working', 'building', 'leading', 'managing', 'collaborating', 'throughout', 'during', 'after', 'before',
  'since', 'currently', 'recently', 'previously', 'please', 'thank', 'would', 'could', 'should', 'might',
  'must', 'shall', 'may', 'have', 'has', 'had', 'been', 'being', 'having', 'doing', 'does', 'did', 'will',
  'can', 'not', 'yes', 'are', 'was', 'were', 'am', 'while', 'i', 'my', 'me', 'we', 'us', 'it', 'as', 'at',
  'in', 'on', 'to', 'of', 'by', 'an', 'a', 'if', 'so', 'or', 'no', 'do',
]);

/** Deterministic grounding check. Numbers must appear in candidate facts;
 *  mid-sentence proper nouns must appear in candidate + job context. */
export function findUnsupportedClaims(answer: string, ledger: FactLedger): string[] {
  const claims: string[] = [];
  const text = String(answer || '');

  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const normalized = raw.replace(/[,\s]/g, '').replace(/%$/, '');
    if (!ledger.candidateText.includes(normalized) && !ledger.candidateText.includes(raw)) {
      claims.push(raw);
    }
  }

  for (const m of text.matchAll(PROPER_RE)) {
    const token = m[0];
    const index = m.index ?? 0;
    if (index === 0) continue; // sentence start
    const before = text.slice(Math.max(0, index - 3), index);
    if (/[.!?\n]\s*$/.test(before)) continue; // sentence start
    if (token.length < 3) continue;
    const lower = token.toLowerCase();
    if (PROPER_STOPWORDS.has(lower)) continue;
    if (ledger.contextText.includes(lower)) continue;
    claims.push(token);
  }

  return [...new Set(claims)];
}

export function countWords(text: string): number {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export type AnswerValidation =
  | { ok: true; answer: string; supportingFactIds: string[] }
  | { ok: false; reason: string };

export function validateGeneratedAnswer(
  raw: unknown,
  ledger: FactLedger,
  question: string,
  maxWords: number
): AnswerValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed output' };
  const obj = raw as Record<string, unknown>;
  if (obj.status !== 'ANSWERED') return { ok: false, reason: 'status is not ANSWERED' };
  const answer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
  if (!answer) return { ok: false, reason: 'empty answer' };
  if (countWords(answer) > maxWords) return { ok: false, reason: 'answer exceeds word limit' };
  if (PLACEHOLDER_RE.test(answer)) return { ok: false, reason: 'placeholder text present' };

  const stub = { category: 'UNKNOWN' as FieldCategory, confidence: 1, mappingMethod: 'AI_SUGGESTED' as const, requiresUser: true };
  if (isHardBlockedField(stub, question) || GENERATIVE_BLOCKED_RE.test(question)) {
    return { ok: false, reason: 'blocked question category' };
  }

  const ids = Array.isArray(obj.supportingFactIds) ? obj.supportingFactIds.filter((x): x is string => typeof x === 'string') : [];
  const known = new Set(ledger.facts.map((f) => f.id));
  if (ids.length === 0) return { ok: false, reason: 'no supporting facts supplied' };
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return { ok: false, reason: `unknown supporting fact ids: ${unknown.slice(0, 3).join(', ')}` };

  const claims = findUnsupportedClaims(answer, ledger);
  if (claims.length) return { ok: false, reason: `unsupported claims: ${claims.slice(0, 3).join(', ')}` };

  return { ok: true, answer, supportingFactIds: ids };
}

// ── Engine interface + LLM implementation ────────────────────────────────

export interface GenerativeAnswerInput {
  question: string;
  questionCategory: string;
  job: { title: string; company: string; description: string };
  ledger: FactLedger;
}

export interface SupportingFact {
  id: string;
  source: LedgerFactSource;
  summary: string;
}

export interface GeneratedAnswer {
  value: string;
  source: 'GENERATED_FROM_CANDIDATE_FACTS';
  requiresUserReview: true;
  supportingFacts: SupportingFact[];
  warnings: string[];
  questionCategory: string;
}

export interface GenerativeAnswerEngine {
  readonly name: string;
  generateAnswer(input: GenerativeAnswerInput): Promise<GeneratedAnswer | null>;
}

type AskJsonFn = <T = unknown>(prompt: string, opts?: { temperature?: number; maxRetries?: number }) => Promise<T>;

const MIN_JD_CHARS = 40;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('GENERATIVE_TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ledgerPromptPayload(ledger: FactLedger): Record<string, unknown> {
  return {
    candidate: ledger.candidate,
    skills: ledger.skills,
    certifications: ledger.certifications,
    experience: ledger.experience.map((e) => ({ id: e.id, title: e.title, company: e.company, dates: e.dates, responsibilities: e.responsibilities })),
    education: ledger.education,
    job: {
      title: ledger.job.title,
      company: ledger.job.company,
      requirements: ledger.job.requirements,
      responsibilities: ledger.job.responsibilities,
      description: ledger.job.descriptionExcerpt,
    },
    fact_ids: ledger.facts.map((f) => f.id),
  };
}

export function buildGenerativePrompt(input: GenerativeAnswerInput, maxWords: number): string {
  return `You are drafting a short answer to a job-application question.

STRICT RULES — any violation makes the answer unusable:
1. Use ONLY the facts supplied below (CANDIDATE_FACTS and JOB). Never invent or infer employers, job titles, dates, years of experience, skills, certifications, degrees, projects, achievements, tools, cloud platforms, numbers or metrics.
2. Do not mention any company, technology, product or metric that is not present in the facts.
3. If the facts are insufficient to answer honestly, return status NEEDS_USER_INPUT.
4. Write in first person. Concise, professional, specific to this role. No generic marketing language, no clichés, no placeholders.
5. Maximum ${maxWords} words (aim for 50-120).

Return STRICT JSON with exactly this shape:
{"status":"ANSWERED"|"NEEDS_USER_INPUT","answer":"...","supportingFactIds":["exp-1"],"reason":"..."}
supportingFactIds MUST be ids from fact_ids below, and every claim in the answer must be supported by them.

CANDIDATE_FACTS:
${JSON.stringify(ledgerPromptPayload(input.ledger))}

JOB:
${JSON.stringify({ title: input.job.title, company: input.job.company, description: input.job.description.slice(0, 1500) })}

QUESTION (${input.questionCategory}): ${input.question}`;
}

export class LlmGenerativeAnswerEngine implements GenerativeAnswerEngine {
  readonly name = 'llm-grounded';

  constructor(
    private readonly config: { timeoutMs: number; maxWords: number },
    private readonly askJsonFn: AskJsonFn = askJson as unknown as AskJsonFn
  ) {}

  async generateAnswer(input: GenerativeAnswerInput): Promise<GeneratedAnswer | null> {
    if (!input.question.trim()) return null;
    if (String(input.job.description || '').trim().length < MIN_JD_CHARS) return null; // missing JD → no generation

    const prompt = buildGenerativePrompt(input, this.config.maxWords);
    let raw: unknown;
    try {
      raw = await withTimeout(this.askJsonFn(prompt, { temperature: 0.4, maxRetries: 0 }), this.config.timeoutMs);
    } catch {
      return null; // provider error / timeout / malformed JSON → safe no-op
    }

    const verdict = validateGeneratedAnswer(raw, input.ledger, input.question, this.config.maxWords);
    if (!verdict.ok) return null;

    const byId = new Map(input.ledger.facts.map((f) => [f.id, f]));
    const supportingFacts: SupportingFact[] = verdict.supportingFactIds.map((id) => {
      const fact = byId.get(id)!;
      return { id, source: fact.source, summary: fact.summary.slice(0, 200) };
    });

    return {
      value: verdict.answer,
      source: 'GENERATED_FROM_CANDIDATE_FACTS',
      requiresUserReview: true,
      supportingFacts,
      warnings: [],
      questionCategory: input.questionCategory,
    };
  }
}

// ── Pass orchestration (dedupe + cap + failure isolation) ────────────────

export interface GenerativeCandidate {
  providerFieldId: string;
  question: string;
  answerSource?: string;
  category?: string;
}

export interface GenerativePassInput {
  engine: GenerativeAnswerEngine;
  candidates: GenerativeCandidate[];
  ledger: FactLedger;
  job: { title: string; company: string; description: string };
  maxQuestions: number;
}

export interface GenerativeMeta {
  engine: string;
  enabled: boolean;
  requested: number;
  generated: number;
  failed: number;
  durationMs: number;
}

export function emptyGenerativeMeta(): GenerativeMeta {
  return { engine: 'none', enabled: false, requested: 0, generated: 0, failed: 0, durationMs: 0 };
}

function normalizeQuestion(question: string): string {
  return String(question || '').toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '').trim();
}

export async function runGenerativePass(input: GenerativePassInput): Promise<{ drafts: Map<string, GeneratedAnswer>; meta: GenerativeMeta }> {
  const started = Date.now();
  const drafts = new Map<string, GeneratedAnswer>();

  // 1. Eligibility filter (blocked categories never reach the engine).
  const eligible: Array<{ candidate: GenerativeCandidate; category: string }> = [];
  for (const candidate of input.candidates) {
    const verdict = isGenerativeEligible({ question: candidate.question, answerSource: candidate.answerSource, category: candidate.category });
    if (verdict.eligible && verdict.category) eligible.push({ candidate, category: verdict.category });
  }

  // 2. Dedupe identical questions + cap the number of generations.
  const unique: Array<{ question: string; category: string; ids: string[] }> = [];
  const byKey = new Map<string, number>();
  for (const { candidate, category } of eligible) {
    const key = normalizeQuestion(candidate.question);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      unique[existing].ids.push(candidate.providerFieldId);
      continue;
    }
    if (unique.length >= input.maxQuestions) continue;
    byKey.set(key, unique.length);
    unique.push({ question: candidate.question, category, ids: [candidate.providerFieldId] });
  }

  // 3. Generate (parallel, bounded by maxQuestions); one failure never breaks others.
  let generated = 0;
  let failed = 0;
  await Promise.all(
    unique.map(async (u) => {
      let draft: GeneratedAnswer | null = null;
      try {
        draft = await input.engine.generateAnswer({
          question: u.question,
          questionCategory: u.category,
          job: input.job,
          ledger: input.ledger,
        });
      } catch {
        draft = null;
      }
      if (!draft) {
        failed += 1;
        return;
      }
      generated += 1;
      for (const id of u.ids) drafts.set(id, draft);
    })
  );

  return {
    drafts,
    meta: {
      engine: input.engine.name,
      enabled: true,
      requested: unique.length,
      generated,
      failed,
      durationMs: Date.now() - started,
    },
  };
}
