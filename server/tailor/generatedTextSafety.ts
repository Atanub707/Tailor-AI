// Deterministic safety checks for OPTIONAL LLM-generated answers/cover letters.
// Unsupported numbers, skills or strength claims are rejected before storage.

import type { MasterCv, ApplicantProfile } from '../../src/types.js';
import { buildCandidateFactLedger } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';

const METRIC_TOKEN_RE = /(\d+(?:[.,]\d+)?\s*(?:%|x|k|m|b|bn|mn|\+)?)/gi;

// Deterministic word↔number normalization (small, explicit map).
const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
};

function normalizeNumberToken(raw: string): string | undefined {
  let t = String(raw || '').toLowerCase().trim().replace(/[.,]$/, '');
  const digits = (t.match(/\d+(?:[.,]\d+)?/) || [''])[0].replace(/,/g, '');
  if (/^\d{4}$/.test(digits) && Number(digits) >= 1990 && Number(digits) <= 2040) return undefined; // date years exempt
  const m = t.match(/^(%|percent|\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(\s*[+xkmb%]?)$/);
  if (!m) return undefined;
  const base = WORD_NUMBERS[m[1]] ?? (m[1] === 'percent' ? '%' : m[1]);
  const suffix = m[2].trim();
  return suffix === 'percent' ? base + '%' : base + suffix;
}

function extractDraftNumbersRaw(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = METRIC_TOKEN_RE.exec(String(text || ''))) !== null) {
    const n = normalizeNumberToken(m[1]);
    if (n) out.push(n);
  }
  // word numbers
  const words = String(text || '').toLowerCase();
  for (const [w, d] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${w}\\b`).test(words)) out.push(d);
  }
  if (/\bpercent\b/.test(words)) out.push('%');
  return out;
}

export function extractDraftNumbers(text: string): string[] {
  return extractDraftNumbersRaw(text);
}

/** Digit-only metric tokens (no word-numbers) — used to verify that a
 *  rewrite never DROPS a real number from a source bullet. Date years are
 *  exempt; currency symbols are not part of the token. */
export function extractNumericTokens(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  METRIC_TOKEN_RE.lastIndex = 0;
  while ((m = METRIC_TOKEN_RE.exec(String(text || ''))) !== null) {
    if (!/\d/.test(m[1])) continue;
    const n = normalizeNumberToken(m[1]);
    if (n && /\d/.test(n)) out.push(n);
  }
  return out;
}

export async function checkGeneratedTextSafety(text: string, cv: MasterCv, profile: ApplicantProfile): Promise<{ ok: boolean; issues: string[] }> {
  const ledger = buildCandidateFactLedger(cv, profile);
  const sourceText = JSON.stringify({ cv, profile }).toLowerCase();
  const issues: string[] = [];
  const t = String(text || '');

  const sourceNumbers = extractDraftNumbers(sourceText);
  const metricSupported = (token: string): boolean => {
    if (token === '%') return sourceNumbers.some((s) => s.endsWith('%'));
    const dBase = token.replace(/[+xkmb%]/g, '');
    const dStrong = /[+x%k]/.test(token);
    return sourceNumbers.some((s) => {
      if (token.endsWith('%') && !s.endsWith('%')) return false;
      if (s.replace(/[+xkmb%]/g, '') !== dBase) return false;
      return !dStrong || /[+x%k]/.test(s);
    });
  };
  for (const n of extractDraftNumbers(t)) {
    if (!metricSupported(n)) issues.push(`unsupported number: ${n}`);
  }

  const { SKILL_TERMS } = await import('../fit/requirementsParser.js');
  const lower = t.toLowerCase();
  for (const term of SKILL_TERMS) {
    if (!new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) continue;
    const supported = ledger.explicitSkills.some((s) => skillCovered(term, [s]).covered) ||
      ledger.technologies.some((x) => skillCovered(term, [x]).covered) ||
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sourceText);
    if (!supported) issues.push(`unsupported skill: ${term}`);
  }

  const STRENGTH_VERBS = ['led ', 'spearheaded', 'owned ', 'directed ', 'architected ', 'scaled to', 'managed a team', 'built the enterprise', 'engineering leader', 'technical leader', 'team lead', 'leadership', 'director of'];
  for (const v of STRENGTH_VERBS) {
    if (t.toLowerCase().includes(v) && !sourceText.includes(v)) {
      issues.push(`unsupported claim: "${v.trim()}"`);
    }
  }

  return { ok: issues.length === 0, issues };
}
