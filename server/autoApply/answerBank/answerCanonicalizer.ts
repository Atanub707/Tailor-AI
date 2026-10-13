// Auto Apply — Answer Bank question canonicalization.
//
// Hierarchy: exact canonical key → existing aliases (the SAME
// `normalizeFieldLabel` ladder the deterministic mapper uses) → deterministic
// normalization → (Laya classification happens upstream, not here).
// Approximate matching NEVER overwrites verified answers.

import { normalizeFieldLabel } from '../../applicationEngine/contract.js';

/** Deterministic normalized form used for EXACT matching. */
export function normalizeQuestion(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Entity-scoped aliases — MUST run before the engine ladder, because that
 *  ladder maps any "…name…" question to fullName: a referrer/emergency/
 *  spouse question would otherwise collide with the APPLICANT's own name
 *  (and could even overwrite the applicant's fullName bank row). */
const ENTITY_ALIASES: Array<{ re: RegExp; key: string }> = [
  { re: /\breferr(er|al|ed|ing)\b|referred by|who (is )?(actually )?(referring|referred)|employee'?s? name.*referr/i, key: 'referrerName' },
  { re: /relationship (to|with)\b.*(referr|employee|associate)|how (do|does) you know/i, key: 'relationshipToReferrer' },
  { re: /related to (anyone|an employee|a (current|current or former|former) employee|any)|family member|immediate family|\brelatives?\b|\bfamiliar\b/i, key: 'hasReferralsAtCompany' },
  { re: /emergency contact/i, key: 'emergencyContactName' },
  { re: /\bspouse\b|\bhusband\b|\bwife\b|domestic partner/i, key: 'spouseName' },
  { re: /(current |your )?(manager|supervisor)'?s? name|name of (your )?(current )?(manager|supervisor)/i, key: 'managerName' },
  { re: /professional reference|reference'?s name|name of (your )?reference/i, key: 'referenceName' },
  { re: /current\s*\(?(or most recent)?\)?\s*(company|employer)|most recent\)?\s*(company|employer)|company name/i, key: 'currentCompany' },
  { re: /have you (previously|ever) (worked|been employed)|are you a former|former (employee|associate)/i, key: 'previouslyWorkedAtCompany' },
  { re: /highest (level of )?education|education level/i, key: 'educationLevel' },
  { re: /school attended|name of (your )?(school|university|college)/i, key: 'schoolName' },
  { re: /tell us about yourself|about yourself|brief introduction|introduce yourself|about you/i, key: 'selfIntroduction' },
  { re: /how did you (hear|learn)|where did you (hear|find|learn)|hear about (us|our)|referral source|find out about (this|us)/i, key: 'referralSource' },
  { re: /\bpronoun/i, key: 'pronouns' },
  { re: /\bgender\b/i, key: 'gender' },
  { re: /race|ethnic/i, key: 'raceEthnicity' },
  { re: /veteran|military service/i, key: 'veteranStatus' },
  { re: /disabilit|handicap/i, key: 'disabilityStatus' },
];

/** Extra deterministic aliases for common bank questions not covered by the
 *  engine's field-alias ladder. Ordered; first match wins. */
const EXTRA_ALIASES: Array<{ re: RegExp; key: string }> = [
  // ADDRESS components — one generic answer per component, reused across
  // every form's wording ("State*", "What state do you reside in?", "Region").
  { re: /city\s*[\/,]\s*state|city\s+and\s+state|(city|state).{0,40}(reside|live)|reside.{0,40}(city|state)/i, key: 'cityState' },
  { re: /(?<![-])(?<!tri-)(?<!country\/)(?<!country )\bstate\b(?!s)|(?<!country\/)(?<!country )\b(province|region)\b|state of residence/i, key: 'stateProvince' },
  { re: /\b(zip|postal|post\s?code|pin\s?code)\b/i, key: 'postalCode' },
  { re: /street address|home address|mailing address|residential address|address line 1|address 1\b|full address/i, key: 'streetAddress' },
  { re: /address line 2|apartment|\bapt\b|\bsuite\b|unit number/i, key: 'addressLine2' },
  { re: /location\s*\(city\)|\btown\b|municipality|city of residence/i, key: 'currentCity' },
  // Identity anchors the engine ladder misses ('Full Name' does not start
  // with 'name'; 'Preferred Name' etc.).
  { re: /^\s*(full|legal)\s+name\b|^\s*(your\s+)?name\s*$/i, key: 'fullName' },
  { re: /^\s*(your\s+)?(first|given|preferred(\s+first)?)\s+name\b/i, key: 'firstName' },
  { re: /^\s*(your\s+)?(last|family|sur)\s*name\b/i, key: 'lastName' },
  { re: /(willing to relocate|willingness to relocate|open to relocat|relocat)/i, key: 'willingToRelocate' },
  { re: /(willing to travel|travel (requirement|percentage|willingness)|able to travel)/i, key: 'willingToTravel' },
  { re: /(earliest start|when can you start|available to start|availability to start|start date|when (will|would|can) you (be able to )?(join|start)|date of availability|how soon can you join)/i, key: 'earliestStartDate' },
  { re: /(currently based|current location|where do you live|where are you based|your location)/i, key: 'currentCity' },
  { re: /(work mode|work arrangement|remote preference|preferred work (mode|arrangement))/i, key: 'remotePreference' },
  { re: /(years of (relevant |professional )?experience|how many years)/i, key: 'yearsOfExperience' },
  // Compensation — same canonical key the engine ladder uses ('expectedSalary')
  // so stored answers written under any phrasing all match every job phrasing.
  { re: /(current|present)\s+(annual\s+)?(salary|compensation|ctc|pay)/i, key: 'currentSalary' },
  { re: /(expected|desired|target|requested)\s+(annual\s+)?(salary|compensation|ctc|pay)|(salary|compensation|ctc|pay)\s+(expectation|expectations|expect|range|requirement|requirements)/i, key: 'expectedSalary' },
  { re: /(notice period|period of notice|how much notice|notice required)/i, key: 'noticePeriod' },
];

/** Canonical key for a question, or undefined when genuinely unknown. */
export function canonicalKeyForQuestion(question: string): string | undefined {
  const q = String(question || '');
  // Entity-scoped keys win before the generic "name" ladder.
  for (const { re, key } of ENTITY_ALIASES) {
    if (re.test(q)) return key;
  }
  const fromEngine = normalizeFieldLabel(question);
  if (fromEngine) return fromEngine;
  for (const { re, key } of EXTRA_ALIASES) {
    if (re.test(q)) return key;
  }
  return undefined;
}
