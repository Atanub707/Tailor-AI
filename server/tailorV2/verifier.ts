// Tailor V2 — deterministic factual verifier.
// Every claim in a drafted resume must be grounded in the Candidate Fact
// Ledger. The JD and FitResult are NEVER candidate evidence. Any JD-only
// skill, altered metric, or unknown employer/title/degree/cert is a
// violation. FAIL CLOSED on violations that cannot be repaired.

import type { TailoredCv } from '../../src/types.js';
import { buildCandidateFactLedger, normalizeWord, type LedgerFact } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';
import { parseEnhancementAnnotations, countClaimElements, budgetExceeded, normalizeRedZoneTokens, type EnhancementLedger } from './enhancementLedger.js';

export interface VerificationIssue {
  type: 'employer' | 'title' | 'dates' | 'education' | 'certification' | 'skill' | 'metric' | 'technology' | 'unsupported_jd_skill' | 'claim_strength' | 'project' | 'achievement' | 'red_zone' | 'budget_exceeded' | 'invalid_enhancement';
  claim: string;
  severity: 'error' | 'warning';
}

export interface TailorVerification {
  passed: boolean;
  issues: VerificationIssue[];
  supportedJdTermsBefore: number;
  supportedJdTermsAfter: number;
  unsupportedInserted: number;
  enhancementLedger?: EnhancementLedger;
}

// 1-hop tool adjacency: a claimed tool is grounded when the tool itself or
// any adjacent family token is ledger-supported (e.g. claiming FastAPI is
// grounded by a real Flask source mention).
const TOOL_ADJACENCY: Record<string, string[]> = {
  flask: ['fastapi'],
  express: ['fastify', 'koa'],
  jenkins: ['github actions', 'gitlab ci'],
  docker: ['podman', 'containerd'],
  mysql: ['postgresql'],
  gke: ['kubernetes', 'eks'],
  eks: ['kubernetes', 'gke'],
  terraform: ['pulumi', 'cloudformation'],
  react: ['next.js', 'vue'],
  python: ['fastapi', 'django', 'flask'],
};

// Curated red-zone organizations: globally recognized employers a candidate
// cannot plausibly claim without source evidence. Only enforced in enhanced
// mode, and only when the token is INTRODUCED (absent from the candidate's
// own source text — a tool/client mention in the source grounds it).
const KNOWN_RED_ORGS = [
  'google', 'alphabet', 'microsoft', 'amazon', 'apple', 'meta', 'facebook', 'netflix',
  'stripe', 'tesla', 'spacex', 'uber', 'airbnb', 'linkedin', 'twitter', 'salesforce',
  'oracle', 'ibm', 'intel', 'cisco', 'adobe', 'nvidia', 'amd', 'samsung', 'sony',
  'goldman sachs', 'jpmorgan', 'jp morgan', 'morgan stanley', 'mckinsey', 'bain & company',
  'boston consulting group', 'deloitte', 'pwc', 'ernst & young', 'kpmg', 'accenture',
  'infosys', 'wipro', 'tcs', 'capgemini', 'atlassian', 'shopify', 'spotify', 'dropbox', 'palantir', 'red hat',
];

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
  projects?: Array<{ name?: string; description?: string }>;
}

// Content tokens that never carry evidence (filler/structure words).
const PROVENANCE_STOPWORDS = new Set([
  'with', 'from', 'into', 'over', 'under', 'using', 'used', 'and', 'for', 'our', 'their', 'your', 'this', 'that',
  'than', 'upon', 'very', 'about', 'after', 'before', 'between', 'other', 'these', 'those', 'they', 'them', 'have',
  'has', 'had', 'been', 'were', 'was', 'are', 'being', 'also', 'but', 'not', 'only', 'just', 'even', 'more', 'most',
  'much', 'many', 'such', 'then', 'then', 'while', 'where', 'when', 'which', 'will', 'would', 'could', 'should',
  'across', 'within', 'along', 'during', 'through', 'together', 'well', 'both', 'each', 'any', 'some', 'all', 'its',
  'his', 'her', 'who', 'whom', 'work', 'role', 'team', 'directly', 'key', 'primary', 'main', 'across', 'per', 'via',
]);

export async function verifyDraft(
  draft: VerifierDraftShape,
  cv: import('../../src/types.js').MasterCv,
  profile: import('../../src/types.js').ApplicantProfile,
  jdTerms: string[],
  opts: { mode?: 'strict' | 'enhanced'; enhancementLedger?: EnhancementLedger } = {}
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

  // Enhanced mode: self-declared yellow-zone claims (Task 1 ledger). The
  // strict sweeps below exempt numbers inside annotated (yellow) claims —
  // each annotation is re-verified in the enhanced block; yellow is tracked,
  // not rejected ("real 70% may become 70% across 40+ services").
  const enhLedger: EnhancementLedger = opts.mode === 'enhanced'
    ? opts.enhancementLedger ?? { entries: parseEnhancementAnnotations(draft as any) }
    : { entries: [] };
  const yellowNumbers = new Set<string>();
  if (opts.mode === 'enhanced') {
    for (const e of enhLedger.entries) {
      if (e.type === 'metric') for (const n of extractDraftNumbers(e.claim)) yellowNumbers.add(n);
    }
  }
  for (const n of draftNumbers(draft)) {
    if (yellowNumbers.has(n)) continue;
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

  // Projects — every listed project must be grounded in the candidate's own
  // projects (Master CV) or the candidate's source text. The JD never
  // authorizes a project. Metrics/skills inside project descriptions are
  // checked by the same rules as the rest of the resume.
  for (const p of draft.projects || []) {
    const name = normalizeWord(p?.name || '');
    const grounded = !!name && (ledger.projects.some((lp) => lp.includes(name) || name.includes(lp)) || new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sourceText));
    if (!grounded) {
      issues.push({ type: 'project', claim: String(p?.name || '(unnamed project)').slice(0, 100), severity: 'error' });
    }
    const descText = String(p?.description || '');
    for (const n of extractDraftNumbers(descText)) {
      if (!metricSupported(n)) issues.push({ type: 'metric', claim: `${n} in project "${p?.name || ''}"`.slice(0, 100), severity: 'error' });
    }
    const { SKILL_TERMS: PROJECT_SKILL_TERMS } = await import('../fit/requirementsParser.js');
    for (const term of PROJECT_SKILL_TERMS) {
      const inDesc = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(descText.toLowerCase());
      if (inDesc && !supportedSkill(term)) {
        issues.push({ type: 'skill', claim: `${term} in project "${p?.name || ''}"`.slice(0, 100), severity: 'error' });
      }
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
      if (yellowNumbers.has(n)) continue; // yellow-zone (annotated) claim — verified via the ledger
      if (!localOrGlobal(n)) {
        issues.push({ type: 'metric', claim: `${n} in ${w.company || ''} bullet unsupported`.slice(0, 100), severity: 'error' });
      }
    }
  }

  // ── Bullet provenance (achievement safety) ──
  // Every highlight bullet must share at least one content token with the
  // candidate's own evidence (the employer's local context, or the global
  // source when no local context exists). Stylistic rewording reuses source
  // terms and passes; a wholly invented accomplishment has no lexical
  // overlap and fails. Skills, metrics and strength verbs inside bullets are
  // already checked separately — this closes the pure-prose invention hole.
  const contentTokens = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const t of String(text || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []) {
      if (!PROVENANCE_STOPWORDS.has(t)) out.add(t);
    }
    return out;
  };
  const sourceTokens = contentTokens(sourceText);
  for (const w of draft.workExperience || []) {
    const employerKey = normalizeWord(w.company || '');
    const localCtx = (cv.experiences || [])
      .filter((e) => normalizeWord(e.company) === employerKey)
      .flatMap((e) => e.responsibilities || [])
      .concat((profile.experience || [])
        .filter((e) => normalizeWord(e.company) === employerKey)
        .flatMap((e) => [...(e.achievements || []), ...(e.summary ? [e.summary] : [])]))
      .join(' ');
    const ctxTokens = contentTokens(localCtx).size > 0 ? contentTokens(localCtx) : sourceTokens;
    for (const b of w.highlights || []) {
      const bulletTokens = contentTokens(b);
      if (bulletTokens.size === 0) continue;
      let overlap = 0;
      for (const t of bulletTokens) if (ctxTokens.has(t)) overlap++;
      if (overlap === 0) {
        issues.push({ type: 'achievement', claim: String(b).slice(0, 100), severity: 'error' });
      }
    }
  }

  // Global metric check (summary and other free text)
  for (const n of draftNumbers(draft)) {
    if (yellowNumbers.has(n)) continue; // yellow-zone (annotated) claim — verified via the ledger
    if (!metricSupported(n)) {
      issues.push({ type: 'metric', claim: n.slice(0, 50), severity: 'error' });
    }
  }

  // ── Claim-strength scan (ownership/leadership/scale inflation) ───────
  const STRENGTH_VERBS = ['led ', 'spearheaded', 'owned ', 'directed ', 'architected ', 'scaled to', 'managed a team', 'built the enterprise', 'engineering leader', 'technical leader', 'team lead', 'leadership', 'director of'];
  const strengthVerbs = STRENGTH_VERBS;
  const draftTextAll = JSON.stringify(draft).toLowerCase();
  for (const v of STRENGTH_VERBS) {
    const inDraft = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(draftTextAll);
    if (inDraft && !sourceText.includes(v)) {
      issues.push({ type: 'claim_strength', claim: `"${v.trim()}" claim not supported by source`.slice(0, 100), severity: 'error' });
    }
  }

  // ── Enhanced mode: 3-zone rules ──────────────────────────────────────
  // YELLOW: every self-declared enhancement is re-verified against the
  // candidate's own evidence (real base number / tool adjacency / strength
  // verb or provenance overlap) and counted against the 30% budget.
  // RED: employer/title/degree/cert/project/org tokens must never be
  // introduced anywhere in the draft (sweep over the whole draft text;
  // per-experience employer/title checks already run above in both modes).
  if (opts.mode === 'enhanced') {
    const redTokens = [...normalizeRedZoneTokens(cv), ...KNOWN_RED_ORGS];
    const sourceLower = sourceText;
    for (const t of redTokens) {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${esc}\\b`).test(draftTextAll) && !new RegExp(`\\b${esc}\\b`).test(sourceLower)) {
        issues.push({ type: 'red_zone', claim: t.slice(0, 100), severity: 'error' });
      }
    }
    for (const e of enhLedger.entries) {
      if (e.type === 'metric') {
        // The BASE number must be real; additional (scaled/scope) numbers are
        // the invention itself and are allowed. Fail only when NO number in
        // the claim is supported by the source.
        const nums = extractDraftNumbers(e.claim);
        if (!nums.length || !nums.some((n) => metricSupported(n))) {
          issues.push({ type: 'invalid_enhancement', claim: `metric: ${e.claim}`.slice(0, 100), severity: 'error' });
        }
      } else if (e.type === 'tool') {
        const tool = e.claim.split(/\s+/).pop() || '';
        const basis = (e.basis || '').toLowerCase().trim();
        const adj = TOOL_ADJACENCY[tool.toLowerCase()] || [];
        const ok = supportedSkill(tool) || adj.some((a) => supportedSkill(a)) || (!!basis && supportedSkill(basis) && (TOOL_ADJACENCY[basis] || []).includes(tool.toLowerCase()));
        if (!ok) issues.push({ type: 'invalid_enhancement', claim: `tool: ${tool}`.slice(0, 100), severity: 'error' });
      } else {
        const inStrength = STRENGTH_VERBS.some((v) => e.claim.toLowerCase().includes(v) && sourceLower.includes(v));
        const tokens = contentTokens(e.claim);
        const ctxTokens = sourceTokens;
        let overlap = 0;
        for (const t of tokens) if (ctxTokens.has(t)) overlap++;
        if (!inStrength && overlap === 0) {
          issues.push({ type: 'invalid_enhancement', claim: `${e.type}: ${e.claim}`.slice(0, 100), severity: 'error' });
        }
      }
    }
    const enhElements = countClaimElements({
      summary: draft.professionalSummary || '',
      skills: draft.coreCompetencies || [],
      experience: draft.workExperience || [],
      education: draft.education || [],
      certifications: (draft.certifications || []) as unknown as string[],
      projects: draft.projects || [],
    } as any);
    // A single tracked enhancement is the tolerated yellow case; the 30%
    // budget applies from the second yellow element on.
    if (enhLedger.entries.length >= 2 && budgetExceeded(enhLedger, enhElements)) {
      issues.push({ type: 'budget_exceeded', claim: `budget > 30% (${enhLedger.entries.length}/${enhElements})`, severity: 'error' });
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
    ...(opts.mode === 'enhanced' ? { enhancementLedger: enhLedger } : {}),
  };
}
/**
 * Deterministic safety check for GENERATED free text (application answers,
 * cover letters). Reuses the same grounding sources as the resume verifier:
 * employers/titles/dates/skills/metrics/leadership claims must be supported
 * by the candidate's own sources. The JD is NOT candidate evidence.
 */
export async function checkGeneratedTextSafety(text: string, cv: import('../../src/types.js').MasterCv, profile: import('../../src/types.js').ApplicantProfile): Promise<{ ok: boolean; issues: string[] }> {
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
