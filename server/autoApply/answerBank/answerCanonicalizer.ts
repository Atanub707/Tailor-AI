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

/** Extra deterministic aliases for common bank questions not covered by the
 *  engine's field-alias ladder. Ordered; first match wins. */
const EXTRA_ALIASES: Array<{ re: RegExp; key: string }> = [
  { re: /(willing to relocate|willingness to relocate|open to relocat|relocat)/i, key: 'willingToRelocate' },
  { re: /(willing to travel|travel (requirement|percentage|willingness)|able to travel)/i, key: 'willingToTravel' },
  { re: /(earliest start|when can you start|available to start|availability to start|start date)/i, key: 'earliestStartDate' },
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
  const fromEngine = normalizeFieldLabel(question);
  if (fromEngine) return fromEngine;
  for (const { re, key } of EXTRA_ALIASES) {
    if (re.test(String(question || ''))) return key;
  }
  return undefined;
}
