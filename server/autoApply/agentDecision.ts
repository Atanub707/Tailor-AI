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
import { answerBankConfigFromEnv, listAnswers } from './answerBank/answerBankStore.js';
import { layaConfigFromEnv } from './decisionEngine.js';
import { LayaDecisionEngine } from './layaDecisionEngine.js';
import { getMasterCv, runWithUser } from '../storage/fileStorage.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';

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
export function bankKeysForLabel(label: string): string[] {
  return BANK_KEY_CONCEPTS.find((c) => c.re.test(String(label || '')))?.keys ?? [];
}

export interface ObservedField {
  ref: string;
  kind: string; // text | textarea | select | radio | checkbox | checkbox-group | file
  name?: string;
  label: string;
  required?: boolean;
  consent?: boolean;
  value?: string;
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

const CONSENT_RE = /consent|agree|terms|privacy|acknowledg|declare|policy/i;
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

function kindToBankType(kind: string): string | undefined {
  switch (kind) {
    case 'text': return 'TEXT';
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
    return (f.options || []).some((o) => o.checked);
  }
  return String(f.value || '').trim().length > 0;
}

/** Tolerant option keys: exact, parenthetical-stripped, veteran synonym —
 *  mirrors the payload builder's canonicalOption so the agent matches the
 *  same way the submission path validates. */
function optionKeys(value: string): string[] {
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

/** Chat-visible options for a question (form truth, capped). */
function askOptions(f: ObservedField): string[] {
  return (f.options || []).map((o) => String(o.option || '')).filter(Boolean).slice(0, 24);
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

  for (const f of state.fields || []) {
    if (isFilled(f)) continue;
    // Structural mirrors (react-select search inputs, hidden widgets) carry no
    // label — they are never questions and never actionable.
    if (!String(f.label || '').trim()) {
      notes.push(`unlabelled control skipped (${String(f.name || f.ref || '').slice(0, 40)})`);
      continue;
    }

    if (f.kind === 'file') {
      // Only the resume is ever uploaded; optional cover letters are left empty.
      const idn = `${f.name || ''} ${f.label || ''}`;
      if (/cover/i.test(idn)) {
        notes.push('optional cover letter left empty');
      } else {
        actions.push({ action: 'upload_resume', ref: f.ref });
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

    const value = values.get(f.ref);
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
        actions.push({ action: 'type', ref: f.ref, value: wanted[0] });
        continue;
      }
      const m = wanted.length === 1 ? optionMatches(f, wanted[0]) : null;
      if (!m) {
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
export async function resolveAgentValues(userId: string, fields: ObservedField[]): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const candidates = fields.filter((f) => !isConsentField(f) && f.kind !== 'file');
  if (!candidates.length) return values;

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
      const s = `${f.label || ''} ${f.name || ''}`;
      if (/e-?mail/i.test(s)) return std.email;
      if (/phone|mobile/i.test(s)) return std.phone || profile?.personal?.phone || profile?.contact?.phone;
      if (/linkedin/i.test(s)) return std.linkedin || profile?.links?.linkedin;
      if (/github/i.test(s)) return std.github || profile?.links?.github;
      if (/website|portfolio/i.test(s)) return std.website || profile?.links?.website;
      // Name splitting: "First Name"/"Preferred Name" get the given name only;
      // "Last/Family/Surname" gets the family name — never the whole full name.
      if (/first ?name|given ?name|preferred (first )?name|forename/i.test(s)) return splitName(std.fullName).first || undefined;
      if (/last ?name|family ?name|surname/i.test(s)) return splitName(std.fullName).last || undefined;
      if (/\b(full ?)?name\b/i.test(s) && !/company|file|user|first|last|preferred|given|family|surname/i.test(s)) return std.fullName;
      if (/country/i.test(s) && !/country code|dial/i.test(s)) return profile?.contact?.country;
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
      const records = listAnswers(userId);
      for (const f of stillUnmatched) {
        const keys = bankKeysForLabel(`${f.label || ''} ${f.name || ''}`);
        if (!keys.length) continue;
        conceptRefs.add(f.ref); // deterministic concept owns this field
        const isSalary = keys.includes('expectedSalary');
        const rec = records.find(
          (r) =>
            keys.includes(r.canonicalKey) &&
            r.verificationStatus === 'VERIFIED' &&
            (r.sensitivity === 'NORMAL' || r.sensitivity === 'PERSONAL' || r.source === 'USER_PROVIDED') &&
            r.answerValue !== null &&
            r.answerValue !== undefined &&
            String(r.answerValue).trim() !== '' &&
            // A salary answer must look like an amount — guards against
            // mis-classified yes/no bank rows (a real poison we hit).
            (!isSalary || /[\d]/.test(String(r.answerValue))),
        );
        if (!rec) continue;
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
      const records = listAnswers(userId);
      const norm = (t: string) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      for (const f of prefixUnmatched) {
        const label = norm(f.label);
        if (label.length < 12) continue; // short labels: exact/alias logic owns them
        const rec = records.find((r) => {
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
        label: f.label,
        fieldType: kindToBankType(f.kind),
        options: (f.options || []).map((o) => o.option),
      })),
    );
    for (const r of resolved) {
      if (r.matchStatus === 'NONE' || r.value === null || r.value === undefined) continue;
      if (r.requiresReview) continue; // uncertain/stale/sensitive → never auto
      values.set(r.providerFieldId, Array.isArray(r.value) ? r.value.join(', ') : String(r.value));
    }
  }

  const unmatched = candidates.filter((f) => !values.has(f.ref) && !conceptRefs.has(f.ref));
  const layaCfg = layaConfigFromEnv();
  if (unmatched.length && layaCfg.enabled) {
    const engine = new LayaDecisionEngine({ url: layaCfg.url, timeoutMs: layaCfg.timeoutMs });
    const records = listAnswers(userId);
    for (const f of unmatched.slice(0, layaCfg.maxFields)) {
      const result = await engine.classifyField({
        label: f.label,
        type: kindToBankType(f.kind),
        required: !!f.required,
        options: (f.options || []).map((o) => o.option),
      });
      if (!result || !result.canonicalKey) continue;
      if (result.confidence < layaCfg.reviewConfidence) continue;
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
  return values;
}

/** The loop's single entry point: observe → decide. */
export async function agentDecide(input: { userId: string; state: ObservedState }): Promise<AgentDecision> {
  const state = input.state;
  if (state.captchaPresent || !state.formPresent) return composeDecision(state, new Map());
  const values = await resolveAgentValues(input.userId, state.fields || []);
  return composeDecision(state, values);
}
