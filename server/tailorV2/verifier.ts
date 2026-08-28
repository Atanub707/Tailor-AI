// Tailor V2 — deterministic factual verifier.
// Every claim in a drafted resume must be grounded in the Candidate Fact
// Ledger. The JD and FitResult are NEVER candidate evidence. Any JD-only
// skill, altered metric, or unknown employer/title/degree/cert is a
// violation. FAIL CLOSED on violations that cannot be repaired.

import type { TailoredCv } from '../../src/types.js';
import { buildCandidateFactLedger, normalizeWord, type LedgerFact } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';

export interface VerificationIssue {
  type: 'employer' | 'title' | 'dates' | 'education' | 'certification' | 'skill' | 'metric' | 'technology' | 'unsupported_jd_skill' | 'claim_strength';
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
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(sourceText);
  };

  // Metrics — every number in the draft must be EQUAL OR WEAKER than a
  // source number. '4' is allowed against '4+'; '4+' is not allowed
  // against '4'; '70%' is allowed only against '70%'.
  const sourceNumbers = extractDraftNumbers(sourceText);
  const metricSupported = (draftToken: string, pool: string[] = sourceNumbers): boolean => {
    if (draftToken === '%') return pool.some((s) => s.endsWith('%')); // generalized claim
    const dBase = draftToken.replace(/[+xkmb%]/g, '');
    const dStrong = /[+x%k]/.test(draftToken);
    return pool.some((s) => {
      if (draftToken.endsWith('%') && !s.endsWith('%')) return false;
      const sBase = s.replace(/[+xkmb%]/g, '');
      if (sBase !== dBase) return false;
      const sStrong = /[+x%k]/.test(s);
      return !dStrong || sStrong; // draft must not be stronger than source
    });
  };
  for (const n of draftNumbers(draft)) {
    if (!metricSupported(n)) {
      issues.push({ type: 'metric', claim: n.slice(0, 50), severity: 'error' });
    }
  }




  // Dates: month-name / 03/2022 / 'Mar 2022' formats normalize to the same
  // canonical token, so equivalent formatting is accepted (never looser
  // semantics — 'Present' must exist in the source).
  const normDate = (d: string) => String(d || '')
    .toLowerCase()
    .replace(/january/g, 'jan').replace(/february/g, 'feb').replace(/march/g, 'mar')
    .replace(/april/g, 'apr').replace(/june/g, 'jun').replace(/july/g, 'jul')
    .replace(/august/g, 'aug').replace(/september/g, 'sep').replace(/october/g, 'oct')
    .replace(/november/g, 'nov').replace(/december/g, 'dec')
    .replace(/\b(?:0?1|01)\//g, 'jan/').replace(/\b(?:0?2|02)\//g, 'feb/')
    .replace(/\b(?:0?3|03)\//g, 'mar/').replace(/\b(?:0?4|04)\//g, 'apr/')
    .replace(/\b(?:0?5|05)\//g, 'may/').replace(/\b(?:0?6|06)\//g, 'jun/')
    .replace(/\b(?:0?7|07)\//g, 'jul/').replace(/\b(?:0?8|08)\//g, 'aug/')
    .replace(/\b(?:0?9|09)\//g, 'sep/')
    .replace(/\b1[012]\//g, (m) => ({ '10/': 'oct/', '11/': 'nov/', '12/': 'dec' })[m] || m)
    .replace(/[\s-]+/g, ' ').trim();
  const ledgerDatesNorm = ledger.employmentDates.map(normDate);

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
      const normalized = normDate(w.dates);
      const pieces = normalized.split(/[-–—]/).map((p) => p.trim());
      const supported = pieces.every((p) => p === '' || ledgerDatesNorm.includes(p) || ledgerDatesNorm.some((d) => d.includes(p)));
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

  // ── Employer-local association ──
  // Bullets must be supported by their OWN employer context (skills and
  // numbers). A metric or technology from Company A must not appear under
  // Company B. Global skills list stays global.
  for (const w of draft.workExperience || []) {
    const employerKey = normalizeWord(w.company || '');
    const local = (cv.experiences || [])
      .filter((e) => normalizeWord(e.company) === employerKey)
      .flatMap((e) => e.responsibilities || [])
      .concat((profile.experience || [])
        .filter((e) => normalizeWord(e.company) === employerKey)
        .flatMap((e) => [...(e.achievements || []), ...(e.summary ? [e.summary] : [])]))
      .join(' ')
      .toLowerCase();
    const bulletText = (w.highlights || []).join(' ');
    if (!local && (w.highlights || []).length) continue; // no local context — global grounding only
    // skills in bullets must exist in this employer's context
    const { SKILL_TERMS } = await import('../fit/requirementsParser.js');
    for (const term of SKILL_TERMS) {
      const inBullet = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bulletText.toLowerCase());
      if (!inBullet) continue;
      // Local grounding uses the same alias-aware matcher: GKE/EKS bullets
      // support a 'Kubernetes' claim within the SAME employer.
      const inLocal = skillCovered(term, [local]).covered;
      const inGlobal = supportedSkill(term);
      if (!inLocal && inGlobal) {
        issues.push({ type: 'technology', claim: `${term} moved into ${w.company || 'an employer'} bullet without local support`.slice(0, 100), severity: 'error' });
      } else if (!inLocal && !inGlobal) {
        issues.push({ type: 'skill', claim: `${term} in ${w.company || ''} bullet unsupported`.slice(0, 100), severity: 'error' });
      }
    }
    // numbers in bullets must be equal-or-weaker than THIS employer's
    // context numbers. The global pool only applies when the employer has
    // no source context at all (nothing to associate against).
    const localNumbers = extractDraftNumbers(local);
    const globalNumbers = extractDraftNumbers(sourceText);
    const localOrGlobal = (n: string) => (local ? localNumbers.some((s) => metricSupported(n, [s])) : globalNumbers.some((s) => metricSupported(n, [s])));
      for (const n of extractDraftNumbers(bulletText)) {
      if (!localOrGlobal(n)) {
        issues.push({ type: 'metric', claim: `${n} in ${w.company || ''} bullet unsupported`.slice(0, 100), severity: 'error' });
      }
    }
  }

  // Global metric check (summary and other free text)
  for (const n of draftNumbers(draft)) {
    if (!metricSupported(n)) {
      issues.push({ type: 'metric', claim: n.slice(0, 50), severity: 'error' });
    }
  }

  // ── Claim-strength scan (ownership/leadership/scale inflation) ───────
  const STRENGTH_VERBS = ['led ', 'spearheaded', 'owned ', 'directed ', 'architected ', 'scaled to', 'managed a team', 'built the enterprise', 'engineering leader', 'technical leader', 'team lead', 'leadership', 'director of'];
  const draftTextAll = JSON.stringify(draft).toLowerCase();
  for (const v of STRENGTH_VERBS) {
    const inDraft = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(draftTextAll);
    if (inDraft && !sourceText.includes(v)) {
      issues.push({ type: 'claim_strength', claim: `"${v.trim()}" claim not supported by source`.slice(0, 100), severity: 'error' });
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