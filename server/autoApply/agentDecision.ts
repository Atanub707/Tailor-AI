// Agent decision facade (Phase 2) — the SERVER half of the one decision layer.
//
// The desktop loop observes the real page and posts the observation here. This
// module answers exactly one question: which primitives should fire next?
//
//   values   → Answer Bank (verified user answers) + profile/CV — never invented
//   binding  → Answer Bank label/option matching first, then Laya classification
//              (advisory, local, calibrated; unknown stays unknown)
//   guards   → CAPTCHA never touched · consent/EEO/legal never auto-answered ·
//              options must exist on the real page · submit only when clean
//
// No DOM, no browser, no generative text here — pure decisions over observed
// state (async only to consult the local Laya sidecar).

import { resolveQuestionsFromBank } from './answerBank/answerBankService.js';
import { answerBankConfigFromEnv, listAnswers, listRunAnswers } from './answerBank/answerBankStore.js';
import {
  classifyQuestionIntent,
  intentAllowsBankMatch,
  intentAllowsSelfIdentity,
  intentBlocksCanonical,
  type QuestionIntent,
} from './questionIntents.js';
import { layaConfigFromEnv } from './decisionEngine.js';
import { LayaDecisionEngine } from './layaDecisionEngine.js';
import { getMasterCv, runWithUser } from '../storage/fileStorage.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';
import { consultModelForFields, matchesOption, consultEnabled } from './modelConsult.js';

/** Clean value for a numeric form field. "$40k-$60k" → '40000', "16 LPA"
 *  → '1600000', '1800000' → '1800000'. Undefined when no sane number exists —
 *  the field then stays open and is ASKED instead of filled with garbage
 *  (a number widget mangled "$40k-$60k" into repeated digit noise). */
export function toNumericFieldValue(raw: string): string | undefined {
  const s = String(raw || '').toLowerCase().replace(/,/g, '').trim();
  if (!s) return undefined;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return undefined;
  let n = nums[0];
  if (/lpa|lakh|lacs?\b/.test(s)) n *= 100000;
  else if (/\d\s*k\b/.test(s) || /\dk/.test(s.replace(/\s+/g, ''))) n *= 1000;
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return undefined;
  return String(Math.round(n));
}

/** Compact candidate-facts block for the model consult: identity + profile +
 *  the user's saved answers. The ONLY value space the model may answer from. */
function buildCandidateFacts(records: any[], profile: any, std: any): string {
  const lines: string[] = [];
  if (std) {
    if (std.fullName) lines.push(`Full name: ${std.fullName}`);
    if (std.email) lines.push(`Email: ${std.email}`);
    if (std.phone) lines.push(`Phone: ${std.phone}`);
    if (std.location) lines.push(`Location: ${std.location}`);
  }
  const pick = (obj: any, prefix: string) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const sv = v == null ? '' : String(v).trim();
      if (sv && sv !== 'undefined' && sv !== 'null') lines.push(`${prefix}${k}: ${sv}`);
    }
  };
  pick(profile?.personal, 'Profile ');
  pick(profile?.contact, 'Profile ');
  pick(profile?.links, 'Profile ');
  pick(profile?.workAuthorization, 'WorkAuthorization ');
  pick(profile?.preferences, 'Preference ');
  pick(profile?.applicationDefaults, 'Default ');
  for (const r of (records || []).slice(0, 80)) {
    const q = String(r?.canonicalQuestion || '').trim();
    const v = r?.answerValue;
    const sv = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    if (q && sv.trim()) lines.push(`SavedAnswer: ${q} => ${sv.slice(0, 200)}`);
  }
  return lines.join('\n').slice(0, 6000);
}

/** Deterministic name splitting — "Atanu Biswas" → { first, last }. */
function splitName(full: string | undefined): { first: string; last: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Deterministic concept → bank canonical keys (used when label matching is
 *  not literal, e.g. "Salary expectations per month?" → expectedSalary). */
const BANK_KEY_CONCEPTS: Array<{ re: RegExp; keys: string[] }> = [
  // Address components — mapped BEFORE the generic entries so "City, State"
  // resolves as ONE generic answer and "State" never eats a US-citizenship row.
  { re: /city\s*[\/,]\s*state|city\s+and\s+state|(city|state).{0,40}(reside|live)|reside.{0,40}(city|state)/i, keys: ['cityState'] },
  { re: /(?<![-])(?<!tri-)(?<!country\/)(?<!country )\bstate\b(?!s)|(?<!country\/)(?<!country )\b(province|region)\b|state of residence/i, keys: ['stateProvince'] },
  { re: /\b(zip|postal|post\s?code|pin\s?code)\b/i, keys: ['postalCode'] },
  { re: /street address|home address|mailing address|residential address|address line 1|full address/i, keys: ['streetAddress'] },
  { re: /address line 2|apartment|\bapt\b|\bsuite\b|unit number/i, keys: ['addressLine2'] },
  { re: /location\s*\(city\)|\btown\b|municipality|city of residence/i, keys: ['currentCity'] },
  { re: /salary|compensation/i, keys: ['expectedSalary', 'targetSalary', 'minimumSalary', 'currentSalary'] },
  { re: /notice period|notice/i, keys: ['noticePeriod'] },
  { re: /earliest start|start date|availability to start/i, keys: ['earliestStartDate'] },
  { re: /linkedin/i, keys: ['linkedinUrl'] },
  { re: /github/i, keys: ['githubUrl'] },
  { re: /portfolio|personal website|website/i, keys: ['portfolioUrl', 'websiteUrl'] },
  { re: /sponsor/i, keys: ['requiresSponsorship'] },
  { re: /authoriz|work permit|right to work|legally (allowed|able)/i, keys: ['authorizedToWork'] },
  { re: /relocat/i, keys: ['willingToRelocate'] },
  { re: /travel/i, keys: ['willingToTravel'] },
  { re: /remote|hybrid|on-?site|work (arrangement|model|preference)/i, keys: ['remotePreference'] },
  { re: /country( of residence|\/region)?\b/i, keys: ['currentCountry'] },
];

/** Exported for tests: canonical bank keys for a field label (or []). */
/** Does an answer match one of the form's options (tolerant keys)? */
export function answerMatchesOptions(answer: string, options: string[]): boolean {
  const wanted = String(answer || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!wanted.length) return false;
  return wanted.every((w) => options.some((o) => optionKeys(o).some((k) => optionKeys(w).includes(k))));
}

export function bankKeysForLabel(label: string): string[] {
  const text = String(label || '');
  // Phone country-code pickers are NOT phone-number fields: their answer is
  // the COUNTRY NAME (the widget appends the dial code itself). Typing the
  // phone number into them was a real misfill.
  if (/phone\s*(country\s*)?code|dial\s*code|country\s*phone/i.test(text)) return ['currentCountry'];
  return BANK_KEY_CONCEPTS.find((c) => c.re.test(text))?.keys ?? [];
}

export interface ObservedField {
  ref: string;
  kind: string; // text | textarea | select | radio | checkbox | checkbox-group | file
  name?: string;
  label: string;
  /** For radio/checkbox members: the question (legend) they belong to. */
  groupLabel?: string;
  required?: boolean;
  consent?: boolean;
  value?: string;
  checked?: boolean;
  options?: Array<{ option: string; checked?: boolean }>;
}

export interface ObservedState {
  url: string;
  title?: string;
  formPresent: boolean;
  captchaPresent: boolean;
  errors?: string[];
  fields: ObservedField[];
  buttons?: Array<{ ref: string; label: string; id?: string; disabled?: boolean }>;
  submitControl?: { ref: string; label: string; disabled: boolean; visible: boolean } | null;
}

export interface AgentAction {
  action: 'type' | 'select' | 'check' | 'click' | 'upload_resume';
  ref: string;
  value?: string;
  option?: string;
}

export interface AgentAsk {
  ref: string;
  label: string;
  reason: string;
  /** true → the loop must pause for the human (consent/EEO/CAPTCHA), not chat. */
  human: boolean;
  /** Select/radio options PARSED FROM THE FORM — the chat renders them as chips. */
  options?: string[];
}

export interface AgentDecision {
  actions: AgentAction[];
  asks: AgentAsk[];
  pause: 'CAPTCHA_REQUIRED' | null;
  submit: boolean;
  notes: string[];
}

const CONSENT_RE = /consent|agree|terms|privacy|acknowledg|declare|policy|certif|attest/i;
const EEO_RE = /gender|race|ethnicity|veteran|disability|sexual orientation|demographic/i;

function isConsentField(f: ObservedField): boolean {
  return f.consent === true || CONSENT_RE.test(String(f.label || '')) || CONSENT_RE.test(String(f.name || ''));
}

/** Blocking consent = legal/required acknowledgements. Optional marketing /
 *  communication opt-ins are never auto-accepted AND never block the loop. */
function isBlockingConsent(f: ObservedField): boolean {
  const s = `${f.label || ''} ${f.name || ''}`;
  if (/marketing|newsletter|job alerts|talent pool|future opportunit|communication preferences|text message|sms|whatsapp/i.test(s)) return false;
  return CONSENT_RE.test(s);
}

function isEeoField(f: ObservedField): boolean {
  return EEO_RE.test(String(f.label || ''));
}

function isEeoLabel(text: string): boolean {
  return EEO_RE.test(String(text || ''));
}

function kindToBankType(kind: string): string | undefined {
  switch (kind) {
    case 'text': return 'TEXT';
    case 'number': return 'NUMBER';
    case 'textarea': return 'TEXTAREA';
    case 'select':
    case 'custom-select':
    case 'radio': return 'SINGLE_SELECT';
    case 'checkbox': return 'BOOLEAN';
    case 'checkbox-group': return 'MULTI_SELECT';
    default: return undefined;
  }
}

function isFilled(f: ObservedField): boolean {
  if (f.kind === 'file') return !!String(f.value || '').trim();
  if (f.kind === 'checkbox' || f.kind === 'checkbox-group' || f.kind === 'radio') {
    return f.checked === true || (f.options || []).some((o) => o.checked);
  }
  return String(f.value || '').trim().length > 0;
}

/** Label used to RESOLVE a field's value: group members resolve from their
 *  question (legend), not from the option text ("Male" must not match a bank
 *  answer for "gender"). */
function matchText(f: ObservedField): string {
  const isMember = (f.kind === 'radio' || f.kind === 'checkbox-group') && !!String(f.groupLabel || '').trim();
  return isMember ? `${f.groupLabel} ${f.name || ''}` : `${f.label || ''} ${f.name || ''}`;
}

/** Tolerant option keys: exact, parenthetical-stripped, veteran synonym —
 *  mirrors the payload builder's canonicalOption so the agent matches the
 *  same way the submission path validates. */
export function optionKeys(value: string): string[] {
  const norm = String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const stripped = norm.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const vet = stripped.replace(/protected\s+veteran/g, 'veteran').replace(/\s+/g, ' ').trim();
  return [norm, stripped, vet].filter((k, i, a) => k && a.indexOf(k) === i);
}
function optionMatches(f: ObservedField, wanted: string): string | null {
  const want = optionKeys(wanted);
  if (!want.length) return null;
  for (const o of f.options || []) {
    const keys = optionKeys(String(o.option || ''));
    if (keys.some((k) => want.includes(k))) return String(o.option);
  }
  return null;
}

/** Chat-visible options for a question (form truth, capped at 60 — a US
 *  state list has 50 entries and MUST fully render in the chat). */
function askOptions(f: ObservedField): string[] {
  return (f.options || []).map((o) => String(o.option || '')).filter(Boolean).slice(0, 60);
}

/** Conditional follow-ups ("If not, please describe…", "Other, please
 *  specify") must never be concept-filled from a DIFFERENT question's value —
 *  a real misfill typed "Yes" into a free-text describe field. */
function isConditionalFreeText(f: ObservedField): boolean {
  if (f.kind !== 'text' && f.kind !== 'textarea') return false;
  return /^\s*if\s+(not|other|you|selected)|please\s+(specify|describe|explain)|describe\s+(below|the|which)|other,?\s+please/i.test(String(f.label || ''));
}

/** PURE decision core — state + resolved values → the next primitives. */
export function composeDecision(state: ObservedState, values: Map<string, string>): AgentDecision {
  const notes: string[] = [];
  if (state.captchaPresent) {
    return { actions: [], asks: [], pause: 'CAPTCHA_REQUIRED', submit: false, notes: ['CAPTCHA visible — human checkpoint'] };
  }
  if (!state.formPresent) {
    return { actions: [], asks: [], pause: null, submit: false, notes: ['no application form on page'] };
  }

  const actions: AgentAction[] = [];
  const asks: AgentAsk[] = [];

  // Multi-value members: group radio/checkbox members by their question so
  // one GROUP ask lists the real option texts, and a resolved group answer
  // checks the matching member(s).
  const groupMembers = new Map<string, ObservedField[]>();
  for (const f of state.fields || []) {
    if ((f.kind === 'radio' || f.kind === 'checkbox-group') && String(f.groupLabel || '').trim()) {
      const gk = String(f.name || f.groupLabel);
      const arr = groupMembers.get(gk) || [];
      arr.push(f);
      groupMembers.set(gk, arr);
    }
  }
  const askedGroups = new Set<string>();

  for (const f of state.fields || []) {
    if (isFilled(f)) continue;
    // Structural mirrors (react-select search inputs, hidden widgets) carry no
    // label — they are never questions and never actionable.
    if (!String(f.label || '').trim()) {
      notes.push(`unlabelled control skipped (${String(f.name || f.ref || '').slice(0, 40)})`);
      continue;
    }

    if (f.kind === 'file') {
      // Only the RESUME is ever uploaded; cover letters and unlabelled file
      // fields stay for manual handling (an unlabelled second upload widget
      // must never receive the resume).
      const idn = `${f.name || ''} ${f.label || ''}`;
      if (/cover/i.test(idn)) {
        notes.push('optional cover letter left empty');
      } else if (/resume|cv/i.test(idn)) {
        actions.push({ action: 'upload_resume', ref: f.ref });
      } else {
        notes.push('non-resume file field left for manual upload');
      }
      continue;
    }
    if (isConsentField(f)) {
      if (isBlockingConsent(f)) {
        asks.push({ ref: f.ref, label: f.label, reason: 'consent — never auto-accepted; confirm it yourself in the browser', human: true, options: askOptions(f) });
      } else {
        notes.push(`optional opt-in left untouched: ${String(f.label).slice(0, 60)}`);
      }
      continue;
    }
    // Voluntary EEO — filled ONLY from your saved answers; never guessed,
    // never blocking when unanswered.
    if (isEeoField(f) && !values.get(f.ref)) {
      notes.push(`voluntary EEO left untouched: ${String(f.label).slice(0, 60)}`);
      continue;
    }

    // Verification codes (OTP / 2FA) are HUMAN-ONLY: never auto-filled from
    // any source — the user types them on the page; the run keeps watching.
    if (/verification code|one-?time (code|password)|security code|\botp\b|two-?factor|authenticator/i.test(`${f.label || ''} ${f.name || ''}`)) {
      asks.push({ ref: f.ref, label: f.label, reason: 'a verification code only you can enter — type it on the page; the run continues by itself', human: true, options: [] });
      continue;
    }

    const value = values.get(f.ref);

    // Multi-value MEMBER: the group's answer decides which member checks.
    if ((f.kind === 'radio' || f.kind === 'checkbox-group') && String(f.groupLabel || '').trim()) {
      if (value) {
        const wanted = value.split(',').map((v) => v.trim()).filter(Boolean);
        const hit = wanted.some((w) => optionKeys(w).some((k) => optionKeys(String(f.label || '')).includes(k)));
        if (hit) actions.push({ action: 'check', ref: f.ref, option: String(f.label || '') });
        continue;
      }
      const gk = String(f.name || f.groupLabel);
      if (!askedGroups.has(gk)) {
        askedGroups.add(gk);
        const gLabel = String(f.groupLabel);
        if (isEeoLabel(gLabel)) {
          notes.push(`voluntary EEO group left untouched: ${gLabel.slice(0, 60)}`);
        } else if (f.required) {
          const opts = (groupMembers.get(gk) || []).map((m) => String(m.label || '')).filter(Boolean).slice(0, 60);
          asks.push({ ref: f.ref, label: gLabel.slice(0, 500), reason: 'no saved answer for this required question', human: false, options: opts });
        } else {
          notes.push(`optional group left unanswered: ${gLabel.slice(0, 60)}`);
        }
      }
      continue;
    }

    if (!value) {
      if (f.required) {
        asks.push({ ref: f.ref, label: f.label, reason: 'no saved answer for this required question', human: false, options: askOptions(f) });
      } else {
        notes.push(`optional question left unanswered: ${String(f.label).slice(0, 60)}`);
      }
      continue;
    }

    if (f.kind === 'select' || f.kind === 'custom-select') {
      const wanted = value.split(',').map((v) => v.trim()).filter(Boolean);
      // Option-less comboboxes (Greenhouse): the act script types the value and
      // picks the matching option live; only KNOWN option lists are matched here.
      if (f.kind === 'custom-select' && !(f.options || []).length && wanted.length) {
        // Long bank answers ("Yes I require sponsorship from Zopa") must reduce
        // to the widget's yes/no vocabulary — the live filter matches it then.
        const yn = /^\s*(yes|no)\b/i.exec(wanted[0]);
        actions.push({ action: 'type', ref: f.ref, value: yn ? yn[1] : wanted[0] });
        continue;
      }
      const m = wanted.length === 1 ? optionMatches(f, wanted[0]) : null;
      if (!m) {
        // OPTIONAL fields never become questions — a stale saved answer that
        // no longer fits the options must not block the run (real case: an
        // optional "Other" checkbox member with an old bank answer turned the
        // questions-first gate into a full stop).
        if (!f.required) {
          notes.push(`optional select left unanswered: ${String(f.label).slice(0, 60)}`);
          continue;
        }
        const allowed = (f.options || []).map((o) => o.option).slice(0, 8).join(' | ');
        asks.push({ ref: f.ref, label: f.label, reason: `saved answer is not one of the form options${allowed ? ` — allowed: ${allowed}` : ''}`, human: false, options: askOptions(f) });
        continue;
      }
      // Native selects use selectedIndex; custom dropdowns post the option
      // TEXT through their hidden cards[...][fieldN] input (type action).
      actions.push(f.kind === 'custom-select' ? { action: 'type', ref: f.ref, value: m } : { action: 'select', ref: f.ref, value: m });
      continue;
    }
    if (f.kind === 'radio' || f.kind === 'checkbox-group') {
      const wanted = value.split(',').map((v) => v.trim()).filter(Boolean);
      const matched = wanted.map((w) => optionMatches(f, w)).filter((m): m is string => !!m);
      if (!matched.length) {
        // Same rule as selects: optional groups never block with an ask.
        if (!f.required) {
          notes.push(`optional group left unanswered: ${String(f.label).slice(0, 60)}`);
          continue;
        }
        const allowed = (f.options || []).map((o) => o.option).slice(0, 8).join(' | ');
        asks.push({ ref: f.ref, label: f.label, reason: `saved answer is not one of the form options${allowed ? ` — allowed: ${allowed}` : ''}`, human: false, options: askOptions(f) });
        continue;
      }
      for (const m of matched) {
        actions.push({ action: 'check', ref: f.ref, option: m });
      }
      continue;
    }
    if (f.kind === 'checkbox') {
      actions.push({ action: 'check', ref: f.ref, value: /^(yes|true|1)$/i.test(value) ? 'true' : 'false' });
      continue;
    }
    actions.push({ action: 'type', ref: f.ref, value });
  }

  // Client-side validation errors are signals, not dead ends: re-assert the
  // value Lever's typeahead/validation rejected (e.g., location selection).
  const errText = (state.errors || []).join(' ');
  if (/select a location/i.test(errText) && actions.length === 0) {
    const loc = (state.fields || []).find((f) => f.kind === 'text' && /(current )?(location|city)|where .*based/i.test(String(f.label || '')));
    const v = loc ? values.get(loc.ref) : undefined;
    if (loc && v) {
      actions.push({ action: 'type', ref: loc.ref, value: v });
      notes.push('re-asserting location after a Lever validation error');
    }
  }

  const clean = actions.length === 0 && asks.length === 0;
  const sc = state.submitControl;
  const canSubmit = !!(sc && sc.visible && !sc.disabled);
  if (clean && !canSubmit) notes.push('form clean but the submit control is not usable yet');
  return { actions, asks, pause: null, submit: clean && canSubmit, notes };
}

/** DB-backed value resolution: profile/CV identity → bank label match → Laya. */
export async function resolveAgentValues(userId: string, fields: ObservedField[], jobId?: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const candidates = fields.filter((f) => !isConsentField(f) && f.kind !== 'file');
  if (!candidates.length) return values;

  // QUESTION-INTENT harness: every field is classified BEFORE value
  // resolution. Non-SELF entities (referrer/emergency/spouse/…) can never be
  // answered with the applicant's own identity; exactOnly/conditional/EEO
  // questions never resolve from generic stages.
  const intents = new Map<string, QuestionIntent>();
  for (const f of candidates) {
    intents.set(f.ref, classifyQuestionIntent({ label: f.label, name: f.name, groupLabel: f.groupLabel }));
  }
  const intentOf = (f: ObservedField): QuestionIntent => intents.get(f.ref)!;
  // RUN-SCOPED answers ("Remember" OFF) resolve first — this job only.
  const runRecords = jobId ? listRunAnswers(userId, jobId) : [];
  const allRecords = () => [...runRecords, ...listAnswers(userId)];

  // Identity/contact fields come from the Master CV FIRST — the bank must
  // never override canonical identity values (e.g., email) via fuzzy matches.
  const std = runWithUser(userId, () => {
    try { return getMasterCv(); } catch { return null; }
  });
  const profile = runWithUser(userId, () => {
    try { return getApplicantProfile(userId); } catch { return null; }
  }) as { links?: { linkedin?: string; github?: string; website?: string }; contact?: { phone?: string; country?: string }; personal?: { phone?: string } } | null;
  if (std) {
    const stdValue = (f: ObservedField): string | undefined => {
      const intent = intentOf(f);
      // Identity may only answer SELF questions — never a referrer/emergency/
      // spouse question, and never a conditional/EEO follow-up.
      if (!intentAllowsSelfIdentity(intent)) return undefined;
      const s = `${f.label || ''} ${f.name || ''}`;
      if (/\be-?mail\b/i.test(s)) return std.email;
      // Phone-number fields ONLY — never the dial-code/country-code pickers
      // (they resolve to the country name, not the number).
      if (/phone|mobile/i.test(s) && !/code|dial/i.test(s)) return std.phone || profile?.personal?.phone || profile?.contact?.phone;
      if (/linkedin/i.test(s)) return std.linkedin || profile?.links?.linkedin;
      if (/github/i.test(s)) return std.github || profile?.links?.github;
      if (/website|portfolio/i.test(s)) return std.website || profile?.links?.website;
      // Name splitting: "First Name"/"Preferred Name" get the given name only;
      // "Last/Family/Surname" gets the family name — never the whole full name.
      if (/first ?name|given ?name|preferred (first )?name|forename/i.test(s)) return splitName(std.fullName).first || undefined;
      if (/last ?name|family ?name|surname/i.test(s)) return splitName(std.fullName).last || undefined;
      if (/\b(full ?)?name\b/i.test(s) && !/company|file|user|first|last|preferred|given|family|surname/i.test(s)) return std.fullName;
      if (/country/i.test(s) && !/country code|phone code|dial/i.test(s)) return profile?.contact?.country;
      if (/(current )?(location|city)|where .*based/i.test(s) && !/relocat/i.test(s)) return std.location;
      return undefined;
    };
    for (const f of candidates) {
      const v = stdValue(f);
      if (v && String(v).trim()) values.set(f.ref, String(v).trim());
    }
  }

  // Deterministic concept fallback: labels that don't match a bank question
  // literally (e.g. "Salary expectations per month?") resolve by canonical key.
  const conceptRefs = new Set<string>();
  const stillUnmatched = candidates.filter((f) => !values.has(f.ref));
  if (stillUnmatched.length) {
    try {
      const records = allRecords();
      for (const f of stillUnmatched) {
        if (isConditionalFreeText(f)) continue; // conditional follow-ups stay empty
        const intent = intentOf(f);
        if (intent.exactOnly) continue; // EEO/conditional/visa: exact answers only
        const keys = bankKeysForLabel(matchText(f)).filter((k) => !intentBlocksCanonical(intent, k));
        if (!keys.length) continue;
        // Key-preference order: e.g. expectedSalary beats currentSalary for a
        // generic "salary" question (was: whichever row updated most recently).
        let rec: (typeof records)[number] | undefined;
        const ADDRESS_KEYS = new Set(['streetAddress', 'addressLine2', 'cityState', 'currentCity', 'stateProvince', 'postalCode']);
        const isAddress = keys.some((k) => ADDRESS_KEYS.has(k));
        for (const key of keys) {
          const isSalary = key.includes('alary');
          rec = records.find(
            (r) =>
              r.canonicalKey === key &&
              r.verificationStatus === 'VERIFIED' &&
              (r.sensitivity === 'NORMAL' || r.sensitivity === 'PERSONAL' || r.source === 'USER_PROVIDED') &&
              r.answerValue !== null &&
              r.answerValue !== undefined &&
              String(r.answerValue).trim() !== '' &&
              // A salary answer must look like an amount — guards against
              // mis-classified yes/no bank rows (a real poison we hit).
              (!isSalary || /[\d]/.test(String(r.answerValue))) &&
              // An address answer must not be an email (a real poison row).
              (!isAddress || !String(r.answerValue).includes('@')),
          );
          if (rec) break;
        }
        if (!rec) continue;
        // Concept ownership is claimed ONLY when it actually resolves —
        // otherwise the field is starved from exact/prefix matching.
        conceptRefs.add(f.ref);
        const v = rec.answerValue as unknown;
        values.set(f.ref, Array.isArray(v) ? v.join(', ') : String(v));
      }
    } catch { /* concept fallback is best-effort; Laya still runs below */ }
  }


  // Long free-text questions repeat across applications with tiny wording
  // differences (truncation, punctuation, trailing notes). Match by a
  // normalized PREFIX so a previously answered question RESOLVES instead of
  // asking the user forever (the observed infinite ask/fill loop).
  const prefixUnmatched = candidates.filter((f) => !values.has(f.ref) && !conceptRefs.has(f.ref));
  if (prefixUnmatched.length) {
    try {
      const records = allRecords();
      const norm = (t: string) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      for (const f of prefixUnmatched) {
        if (isConditionalFreeText(f)) continue; // conditional follow-ups stay empty
        const intent = intentOf(f);
        if (intent.exactOnly) continue;
        const label = norm(matchText(f));
        if (label.length < 12) continue; // short labels: exact/alias logic owns them
        const rec = records.find((r) => {
          if (intentBlocksCanonical(intent, r.canonicalKey)) return false;
          if (r.verificationStatus !== 'VERIFIED') return false;
          if (!(r.sensitivity === 'NORMAL' || r.sensitivity === 'PERSONAL' || r.source === 'USER_PROVIDED')) return false;
          if (r.answerValue === null || r.answerValue === undefined || String(r.answerValue).trim() === '') return false;
          const q = norm(r.canonicalQuestion);
          if (q.length < 12) return false;
          return q.startsWith(label.slice(0, 70)) || label.startsWith(q.slice(0, 70));
        });
        if (!rec) continue;
        const v = rec.answerValue as unknown;
        values.set(f.ref, Array.isArray(v) ? v.join(', ') : String(v));
      }
    } catch { /* prefix fallback is best-effort */ }
  }

  const remaining = candidates.filter((f) => !values.has(f.ref) && !conceptRefs.has(f.ref));
  if (remaining.length && answerBankConfigFromEnv().enabled) {
    const resolved = resolveQuestionsFromBank(
      userId,
      remaining.map((f) => ({
        providerFieldId: f.ref,
        label: matchText(f),
        fieldType: kindToBankType(f.kind),
        options: (f.options || []).map((o) => o.option),
      })),
      runRecords,
    );
    for (const r of resolved) {
      if (r.matchStatus === 'NONE' || r.value === null || r.value === undefined) continue;
      if (r.requiresReview) continue; // uncertain/stale/sensitive → never auto
      const field = remaining.find((x) => x.ref === r.providerFieldId);
      if (field) {
        const intent = intentOf(field);
        // Poison guard: an email stored against an address question must
        // never spread to other address fields via canonical/fuzzy matches.
        if (r.matchStatus !== 'EXACT' && r.canonicalKey && ['streetAddress', 'addressLine2', 'cityState', 'currentCity', 'stateProvince', 'postalCode'].includes(r.canonicalKey) && /@/.test(String(r.value))) continue;
        // Generic matches must respect the intent policy; EXACT (the user
        // answered THIS question) always passes.
        if (!intentAllowsBankMatch(intent, r.canonicalKey, r.matchStatus)) continue;
      }
      values.set(r.providerFieldId, Array.isArray(r.value) ? r.value.join(', ') : String(r.value));
    }
  }

  const unmatched = candidates.filter((f) => !values.has(f.ref) && !conceptRefs.has(f.ref));
  const layaCfg = layaConfigFromEnv();
  if (unmatched.length && layaCfg.enabled) {
    const engine = new LayaDecisionEngine({ url: layaCfg.url, timeoutMs: layaCfg.timeoutMs });
    const records = allRecords();
    for (const f of unmatched.slice(0, layaCfg.maxFields)) {
      const intent = intentOf(f);
      if (intent.exactOnly) continue; // EEO/conditional/visa never auto-engine
      const result = await engine.classifyField({
        label: matchText(f),
        type: kindToBankType(f.kind),
        required: !!f.required,
        options: (f.options || []).map((o) => o.option),
      });
      if (!result || !result.canonicalKey) continue;
      if (result.confidence < layaCfg.reviewConfidence) continue;
      // Entity scoping: a referrer/emergency question may only reuse its own
      // canonical keys — never fullName/firstName/email/… (the own-name bug).
      if (!intentAllowsBankMatch(intent, result.canonicalKey, 'SEMANTIC')) continue;
      const rec = records.find(
        (r) =>
          r.canonicalKey === result.canonicalKey &&
          r.verificationStatus === 'VERIFIED' &&
          (r.sensitivity === 'NORMAL' || r.sensitivity === 'PERSONAL' || r.source === 'USER_PROVIDED'),
      );
      if (!rec) continue;
      const v = rec.answerValue;
      values.set(f.ref, Array.isArray(v) ? v.join(', ') : String(v ?? ''));
    }
  }
  // ── MODEL CONSULT — the understanding layer. For questions the
  // deterministic stages could not answer, ONE batched LLM call reads the
  // question + the candidate's facts and either answers with a fact-grounded
  // value or escalates to the human. Never invents: every value is validated
  // (option membership for choices, fact membership for free text).
  const stillOpenForModel = candidates.filter((f) => !values.has(f.ref) && !conceptRefs.has(f.ref));
  if (stillOpenForModel.length && consultEnabled()) {
    const consultable = stillOpenForModel.filter((f) => {
      const intent = intentOf(f);
      return !intent.sensitive && !intent.exactOnly; // EEO/legal/conditional → human
    });
    if (consultable.length) {
      const facts = buildCandidateFacts(allRecords(), profile, std);
      const decisions = await consultModelForFields(
        facts,
        consultable.map((f) => ({
          ref: f.ref,
          label: matchText(f),
          kind: kindToBankType(f.kind) || f.kind,
          required: !!f.required,
          options: (f.options || []).map((o) => o.option).filter(Boolean),
        }))
      );
      const factsNorm = facts.toLowerCase();
      for (const d of decisions) {
        if (d.action !== 'answer' || !d.value) continue;
        const field = consultable.find((f) => f.ref === d.ref);
        if (!field) continue;
        const value = String(d.value).trim();
        if (!value || value.length > 500) continue;
        const opts = (field.options || []).map((o) => o.option).filter(Boolean);
        if (opts.length) {
          if (!matchesOption(value, opts)) continue; // must be a REAL option
        } else {
          const norm = value.toLowerCase();
          if (norm.length >= 4 && !factsNorm.includes(norm)) continue; // no invention
        }
        values.set(field.ref, value);
      }
    }
  }

  // ── NUMERIC FIELD PASS — a field that asks for a number must receive a
  // clean number. Unparseable values stay open (asked), never typed as text.
  for (const f of candidates) {
    if (f.kind !== 'number') continue;
    const raw = values.get(f.ref);
    if (raw === undefined) continue;
    const num = toNumericFieldValue(raw);
    if (num) values.set(f.ref, num);
    else values.delete(f.ref);
  }

  return values;
}

/** The loop's single entry point: observe → decide. */
export async function agentDecide(input: { userId: string; state: ObservedState; jobId?: string }): Promise<AgentDecision> {
  const state = input.state;
  if (state.captchaPresent || !state.formPresent) return composeDecision(state, new Map());
  const values = await resolveAgentValues(input.userId, state.fields || [], input.jobId);
  return composeDecision(state, values);
}
