// Tailor V2 — deterministic factual verifier.
// Every claim in a drafted resume must be grounded in the Candidate Fact
// Ledger. The JD and FitResult are NEVER candidate evidence. Any JD-only
// skill, altered metric, or unknown employer/title/degree/cert is a
// violation. FAIL CLOSED on violations that cannot be repaired.

import type { TailoredCv } from '../../src/types.js';
import { buildCandidateFactLedger, normalizeWord, type LedgerFact } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';

export interface VerificationIssue {
  type: 'employer' | 'title' | 'dates' | 'education' | 'certification' | 'skill' | 'metric' | 'technology' | 'unsupported_jd_skill';
  claim: string;
  severity: 'error' | 'warning';
}

export interface TailorVerification {
  passed: boolean;
  issues: VerificationIssue[];
  supportedJdTermsBefore: number;
  supportedJdTermsAfter: number;
  unsupportedInserted: number;
}

const METRIC_TOKEN_RE = /(\d+(?:[.,]\d+)?\s*(?:%|x|k|m|b|bn|mn|\+)?)/gi;

function extractDraftNumbers(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = METRIC_TOKEN_RE.exec(String(text || ''))) !== null) {
    const digits = (m[1].match(/\d+(?:[.,]\d+)?/) || [''])[0].replace(/,/g, '');
    // Ignore years that look like dates (1990-2040) — those are protected
    // under dates, not metrics — even with a stray suffix ('2016 k').
    if (/^\d{4}$/.test(digits) && Number(digits) >= 1990 && Number(digits) <= 2040) continue;
    const t = m[1].toLowerCase().replace(/\./g, '.').replace(/[.,]$/, '').trim();
    if (t) out.push(t);
  }
  return out;
}

function draftNumbers(draft: VerifierDraftShape): string[] {
  const texts = [
    draft.professionalSummary || '',
    ...(draft.coreCompetencies || []),
    ...(draft.workExperience || []).flatMap((w) => [w.title, w.company, w.location, w.dates, ...(w.highlights || [])]),
    ...(draft.education || []).flatMap((e) => [e.degree, e.institution, e.dates, e.details || '']),
    ...(draft.technicalSkills || []).flatMap((s) => s.skills || []),
  ];
  return extractDraftNumbers(texts.join(' '));
}

function listMembers(list: string[]): string[] {
  return (list || []).map(normalizeWord).filter(Boolean);
}

export interface VerifierDraftShape {
  professionalSummary?: string;
  coreCompetencies?: string[];
  workExperience?: Array<{ title?: string; company?: string; location?: string; dates?: string; highlights?: string[] }>;
  education?: Array<{ degree?: string; institution?: string; dates?: string; details?: string }>;
  technicalSkills?: Array<{ category?: string; skills?: string[] }>;
  certifications?: Array<string | { name?: string }>;
}

export async function verifyDraft(
  draft: VerifierDraftShape,
  cv: import('../../src/types.js').MasterCv,
  profile: import('../../src/types.js').ApplicantProfile,
  jdTerms: string[]
): Promise<TailorVerification> {
  const ledger = buildCandidateFactLedger(cv, profile);
  const issues: VerificationIssue[] = [];
  // The candidate's own source text (Master CV + profile) is evidence:
  // a term mentioned anywhere in the source is grounded, even if it is not
  // in the curated skill lists.
  const sourceText = JSON.stringify({ cv, profile }).toLowerCase();

  const supportedSkill = (term: string): boolean => {
    if (ledger.explicitSkills.some((s) => skillCovered(term, [s]).covered)) return true;
    if (ledger.technologies.some((t) => skillCovered(term, [t]).covered)) return true;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(sourceText);
  };

  // Employers / titles / dates
  for (const w of draft.workExperience || []) {
    const company = normalizeWord(w.company);
    const title = normalizeWord(w.title);
    if (company && !ledger.employers.includes(company)) {
      issues.push({ type: 'employer', claim: String(w.company).slice(0, 100), severity: 'error' });
    }
    if (title && !ledger.titles.includes(title)) {
      issues.push({ type: 'title', claim: String(w.title).slice(0, 100), severity: 'error' });
    }
    if (w.dates) {
      const normalized = normalizeWord(w.dates);
      const pieces = normalized.split(/[-–—]/).map((p) => p.trim());
      const supported = pieces.every((p) => p === '' || ledger.employmentDates.includes(p) || ledger.employmentDates.some((d) => d.includes(p)));
      if (!supported) {
        issues.push({ type: 'dates', claim: String(w.dates).slice(0, 100), severity: 'error' });
      }
    }
  }

  // Education
  for (const e of draft.education || []) {
    const degree = normalizeWord(e.degree || '');
    const institution = normalizeWord(e.institution || '');
    const supportedEdu = ledger.education.some((le) => {
      if (degree && institution) return le.includes(degree) && le.includes(institution);
      if (degree) return le.includes(degree);
      if (institution) return le.includes(institution);
      return false;
    });
    if ((degree || institution) && !supportedEdu) {
      issues.push({ type: 'education', claim: `${e.degree || ''} @ ${e.institution || ''}`.slice(0, 100), severity: 'error' });
    }
  }

  // Certifications
  const draftCerts = listMembers((draft.certifications || []).map((c) => (typeof c === 'string' ? c : c.name)));
  const ledgerCerts = ledger.certifications;
  for (const c of draftCerts) {
    if (!ledgerCerts.some((lc) => lc.includes(c) || c.includes(lc))) {
      issues.push({ type: 'certification', claim: c.slice(0, 100), severity: 'error' });
    }
  }

  // Skills — every drafted skill must be ledger-supported. Claim locations
  // include the summary and highlight bullets, not just the skill lists:
  // a summary saying "Experienced with Azure" is an insertion too.
  const draftSkills = [
    ...(draft.coreCompetencies || []),
    ...(draft.technicalSkills || []).flatMap((s) => s.skills || []),
  ];
  const { SKILL_TERMS } = await import('../fit/requirementsParser.js');
  const summaryText = String(draft.professionalSummary || '').toLowerCase();
  const highlightText = (draft.workExperience || []).flatMap((w) => w.highlights || []).join(' ').toLowerCase();
  for (const s of draftSkills) {
    if (!supportedSkill(s)) {
      issues.push({ type: 'skill', claim: String(s).slice(0, 100), severity: 'error' });
    }
  }
  for (const term of SKILL_TERMS) {
    const inText = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(summaryText) || new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(highlightText);
    if (inText && !supportedSkill(term)) {
      issues.push({ type: 'skill', claim: `${term} (in summary/highlights)`.slice(0, 100), severity: 'error' });
    }
  }

  // JD-only skills (unsupported by candidate) must NOT appear anywhere
  const draftText = JSON.stringify(draft).toLowerCase();
  let unsupportedInserted = 0;
  for (const term of jdTerms) {
    const t = term.toLowerCase();
    if (!supportedSkill(t) && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(draftText)) {
      unsupportedInserted++;
      issues.push({ type: 'unsupported_jd_skill', claim: term.slice(0, 100), severity: 'error' });
    }
  }

  // Metrics — every number in the draft must appear in the source text
  const sourceNumbers = new Set(extractDraftNumbers(sourceText));
  for (const n of draftNumbers(draft)) {
    if (!sourceNumbers.has(n)) {
      issues.push({ type: 'metric', claim: n.slice(0, 50), severity: 'error' });
    }
  }

  // Keyword coverage (supported JD terms present in draft)
  const supportedTerms = jdTerms.filter((t) => supportedSkill(t));
  const draftLower = draftText;
  const supportedAfter = supportedTerms.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(draftLower)).length;

  return {
    passed: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
    supportedJdTermsBefore: 0,
    supportedJdTermsAfter: supportedAfter,
    unsupportedInserted,
  };
}