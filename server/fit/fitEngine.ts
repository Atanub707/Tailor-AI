// FIT ENGINE V1 — deterministic candidate ↔ job matching.
//
// The numerical Fit Score is NEVER LLM-invented: every category is computed
// from explicit structured inputs (Applicant Profile + Master CV + Job + JD)
// with a fixed weight model. UNKNOWN ≠ false. The JD is treated as plain
// text data — malicious content has zero effect beyond text tokens.

import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';
import { parseJobRequirements } from './requirementsParser.js';
import { skillCovered, canonicalizeSkill } from './skillAliases.js';
import { experienceYears, relevantExperienceMonths } from './experience.js';

export const FIT_ENGINE_VERSION = 2; // 2: years extraction scoped to experience context

export interface FitEvidence {
  category: string;
  item: string;
  candidate?: string;
  source?: string;
}

export interface FitCategory {
  score: number; // 0..max
  max: number;
  matched: string[];
  missing: string[];
  unknowns: string[];
  blockers: string[];
  evidence: FitEvidence[];
}

export interface FitResult {
  version: number;
  jobId: string;
  score: number;
  grade: string;
  categories: Record<string, FitCategory>;
  strengths: string[];
  gaps: string[];
  blockers: string[];
  unknowns: string[];
  evidence: FitEvidence[];
  calculatedAt: string;
  /** How much of the job the engine could meaningfully assess — NOT AI
   *  confidence. Low coverage with a high score is honest. */
  assessmentCoverage: {
    applicableCategories: number;
    totalCategories: number;
    extractedRequirements: number;
    confidence: 'high' | 'medium' | 'low';
  };
}

export interface FitWeights {
  requiredSkills: number;
  experience: number;
  roleAlignment: number;
  preferredSkills: number;
  education: number;
  location: number;
  workMode: number;
  workAuthorization: number;
  compensation: number;
}

export const DEFAULT_FIT_WEIGHTS: FitWeights = {
  requiredSkills: 30,
  experience: 20,
  roleAlignment: 15,
  preferredSkills: 10,
  education: 5,
  location: 5,
  workMode: 5,
  workAuthorization: 5,
  compensation: 5,
};

export function gradeFor(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Partial';
  return 'Weak';
}

// Deterministic role taxonomy — top-level family + subfamily. This is a
// ROLE-ALIGNMENT signal only; it carries NO skill templates (the JD's
// actual requirements stay authoritative).
const ROLE_TAXONOMY: Array<{ top: string; sub: string; terms: string[] }> = [
  { top: 'software', sub: 'backend', terms: ['backend', 'back end', 'server-side'] },
  { top: 'software', sub: 'frontend', terms: ['frontend', 'front end', 'ui engineer', 'web ui'] },
  { top: 'software', sub: 'fullstack', terms: ['full stack', 'fullstack'] },
  { top: 'software', sub: 'mobile', terms: ['mobile', 'ios', 'android', 'react native'] },
  { top: 'software', sub: 'systems', terms: ['systems software', 'systems engineer', 'embedded'] },
  { top: 'software', sub: 'general', terms: ['software', 'developer', 'engineer'] },
  { top: 'infrastructure', sub: 'devops', terms: ['devops', 'dev ops'] },
  { top: 'infrastructure', sub: 'platform', terms: ['platform engineer', 'platform'] },
  { top: 'infrastructure', sub: 'sre', terms: ['sre', 'site reliability'] },
  { top: 'infrastructure', sub: 'cloud', terms: ['cloud engineer', 'cloud infrastructure', 'cloud architect'] },
  { top: 'infrastructure', sub: 'infrastructure', terms: ['infrastructure', 'systems administration'] },
  { top: 'ai_ml', sub: 'ai-engineering', terms: ['ai engineer', 'ai research', 'applied ai'] },
  { top: 'ai_ml', sub: 'ml-engineering', terms: ['ml engineer', 'machine learning engineer'] },
  { top: 'ai_ml', sub: 'ml-infrastructure', terms: ['ml infrastructure', 'ml platform', 'mlops', 'm lo ps'] },
  { top: 'ai_ml', sub: 'data-science', terms: ['data scientist', 'research scientist'] },
  { top: 'data', sub: 'data-engineering', terms: ['data engineer'] },
  { top: 'data', sub: 'analytics', terms: ['analyst', 'analytics', 'business intelligence', 'bi '] },
  { top: 'data', sub: 'database', terms: ['database', 'dba', 'data platform'] },
  { top: 'security', sub: 'application-security', terms: ['application security', 'appsec'] },
  { top: 'security', sub: 'cloud-security', terms: ['cloud security'] },
  { top: 'security', sub: 'security-engineering', terms: ['security engineer', 'security'] },
  { top: 'security', sub: 'detection', terms: ['detection', 'soc', 'security operations', 'incident response'] },
  { top: 'quality', sub: 'qa', terms: ['qa', 'quality assurance'] },
  { top: 'quality', sub: 'test-automation', terms: ['test automation', 'sdets', 'test engineer'] },
];

// Adjacency between subfamilies: full (same sub) → adjacent (0.7) → same
// top (0.5) → different top (0.3) → unknown (not applicable).
const ADJACENT_SUBS: Array<[string, string[]]> = [
  ['devops', ['platform', 'sre', 'cloud', 'infrastructure']],
  ['platform', ['devops', 'sre', 'cloud', 'ml-infrastructure']],
  ['sre', ['devops', 'platform', 'cloud']],
  ['cloud', ['devops', 'platform', 'infrastructure']],
  ['backend', ['fullstack', 'general']],
  ['frontend', ['fullstack', 'general']],
  ['fullstack', ['backend', 'frontend', 'general']],
  ['general', ['backend', 'frontend', 'fullstack', 'systems']],
  ['ml-engineering', ['ai-engineering', 'ml-infrastructure', 'data-science', 'data-engineering']],
  ['ai-engineering', ['ml-engineering', 'data-science']],
  ['ml-infrastructure', ['ml-engineering', 'platform', 'data-engineering']],
  ['data-engineering', ['ml-infrastructure', 'analytics', 'database']],
  ['analytics', ['data-engineering', 'data-science']],
  ['security-engineering', ['application-security', 'cloud-security', 'detection']],
  ['application-security', ['security-engineering', 'cloud-security']],
  ['cloud-security', ['security-engineering', 'application-security']],
  ['qa', ['test-automation']],
  ['test-automation', ['qa']],
];

export interface RoleIdentity { top: string; sub: string }

export function identifyRole(title: string): RoleIdentity | undefined {
  const t = String(title || '').toLowerCase();
  // Longest-term match first for precision ("cloud security engineer" must
  // not collapse into "security engineer" + cloud).
  const matches = ROLE_TAXONOMY.filter((f) => f.terms.some((x) => t.includes(x)))
    .sort((a, b) => Math.max(...b.terms.map((x) => x.length)) - Math.max(...a.terms.map((x) => x.length)));
  return matches[0] ? { top: matches[0].top, sub: matches[0].sub } : undefined;
}

export function roleAlignmentWeight(candidate: RoleIdentity | undefined, job: RoleIdentity | undefined): number | undefined {
  if (!job) return undefined; // unknown job family → not applicable
  if (!candidate) return 0.3; // unknown candidate background → weak
  if (candidate.sub === job.sub) return 1;
  if (ADJACENT_SUBS.some(([s, list]) => s === candidate.sub && list.includes(job.sub))) return 0.7;
  if (candidate.top === job.top) return 0.5;
  return 0.3;
}

function candidateSkills(profile: ApplicantProfile, cv: MasterCv): string[] {
  const out = new Set<string>();
  for (const s of profile.skills || []) if (s.name) out.add(String(s.name).toLowerCase());
  for (const g of cv.skills || []) for (const i of g.items || []) out.add(String(i).toLowerCase());
  for (const e of cv.experiences || []) {
    for (const r of e.responsibilities || []) out.add(String(r).toLowerCase());
    out.add(String(e.title).toLowerCase());
  }
  for (const e of profile.experience || []) {
    for (const t of e.technologies || []) out.add(String(t).toLowerCase());
    for (const a of e.achievements || []) out.add(String(a).toLowerCase());
  }
  return [...out];
}

/** Extract a skill-like token from candidate evidence lines (deterministic). */
function skillEvidence(skills: string[], target: string): FitEvidence | undefined {
  const req = canonicalizeSkill(target);
  if (!req) return undefined;
  for (const s of skills) {
    const norm = String(s).toLowerCase();
    if (norm.includes(req)) {
      return { category: 'skills', item: target, candidate: s.slice(0, 140), source: 'skills' };
    }
    const implies = req === 'kubernetes' ? ['gke', 'eks', 'aks'] : [];
    for (const imp of implies) {
      if (norm.includes(imp)) return { category: 'skills', item: target, candidate: s.slice(0, 140), source: 'skills' };
    }
  }
  return undefined;
}

export function computeFit(
  profile: ApplicantProfile,
  cv: MasterCv,
  job: Job,
  description: string,
  weights: FitWeights = DEFAULT_FIT_WEIGHTS
): FitResult {
  const reqs = parseJobRequirements(description, { location: job.location, workMode: (job as any).workMode });
  const skills = candidateSkills(profile, cv);
  const jobRole = identifyRole(job.title);
  const cats: Record<string, FitCategory> = {};

  const makeCat = (key: string, max: number): FitCategory => ({
    score: 0, max, matched: [], missing: [], unknowns: [], blockers: [], evidence: [],
  });

  // ── Required skills (30) ─────────────────────────────────────────────
  const rs = makeCat('requiredSkills', weights.requiredSkills);
  cats.requiredSkills = rs;
  const required = reqs.requiredSkills.length ? reqs.requiredSkills : reqs.unknownStrengthSkills;
  const matchedRequired = required.filter((s) => skillCovered(s, skills).covered);
  const missingRequired = required.filter((s) => !skillCovered(s, skills).covered);
  const requiredScore = required.length ? (matchedRequired.length / required.length) * rs.max : rs.max; // no requirements = full (not applicable)
  rs.score = Math.round(requiredScore * 10) / 10;
  rs.matched = matchedRequired;
  rs.missing = missingRequired;
  for (const m of matchedRequired) {
    const ev = skillEvidence(skills, m);
    if (ev) rs.evidence.push({ ...ev, category: 'requiredSkills' });
  }

  // ── Preferred skills (10) ────────────────────────────────────────────
  const ps = makeCat('preferredSkills', weights.preferredSkills);
  cats.preferredSkills = ps;
  const preferred = reqs.preferredSkills;
  const matchedPref = preferred.filter((s) => skillCovered(s, skills).covered);
  const missingPref = preferred.filter((s) => !skillCovered(s, skills).covered);
  ps.score = preferred.length ? Math.round((matchedPref.length / preferred.length) * ps.max * 10) / 10 : ps.max;
  ps.matched = matchedPref;
  ps.missing = missingPref;

  // ── Experience (20) ──────────────────────────────────────────────────
  const ex = makeCat('experience', weights.experience);
  cats.experience = ex;
  const expRaw = relevantExperienceMonths(profile.experience, jobRole?.top);
  const exp = { known: expRaw.known, years: expRaw.known ? Math.round((expRaw.months || 0) / 12 * 10) / 10 : undefined };
  const reqYears = reqs.minYears;
  if (!reqYears) {
    ex.score = ex.max; // no explicit requirement
  } else if (!exp.known || exp.years === undefined) {
    ex.score = 0;
    ex.unknowns.push('Experience duration unknown (missing dates)');
  } else if (exp.years >= reqYears) {
    ex.score = ex.max;
    ex.matched.push(`${exp.years}y experience meets ${reqYears}+y requirement`);
  } else {
    const ratio = exp.years / reqYears;
    ex.score = Math.round(ex.max * Math.min(ratio, 1) * 10) / 10;
    ex.missing.push(`${exp.years}y experience vs ${reqYears}+y required`);
  }

  // ── Role alignment (15) — taxonomy signal only; JD requirements decide ──
  const ra = makeCat('roleAlignment', weights.roleAlignment);
  cats.roleAlignment = ra;
  const expTitles = [
    ...(cv.experiences || []).map((e) => e.title),
    ...(profile.experience || []).map((e) => e.title),
  ];
  const candRole = expTitles.map(identifyRole).find(Boolean);
  const alignment = roleAlignmentWeight(candRole, jobRole);
  if (alignment === undefined) {
    // Unknown job family → category NOT applicable (never auto-full).
    ra.score = 0;
    ra.max = 0;
    ra.unknowns.push('Role family not recognized — role alignment not applicable');
  } else {
    ra.score = Math.round(ra.max * alignment * 10) / 10;
    if (alignment >= 1) ra.matched.push(`Background aligns with ${jobRole?.sub || 'role'} (${jobRole?.top || '?'})`);
    else if (alignment >= 0.7) ra.matched.push(`Background adjacent to ${jobRole?.sub || 'role'} (${jobRole?.top || '?'})`);
    else if (alignment >= 0.5) ra.matched.push(`Background partially related to ${jobRole?.sub || 'role'}`);
    else ra.missing.push(`Background not aligned with ${jobRole?.sub || 'role'} (${jobRole?.top || '?'})`);
  }

  // ── Education (5) ────────────────────────────────────────────────────
  const ed = makeCat('education', weights.education);
  cats.education = ed;
  const eduReqs = reqs.education;
  if (!eduReqs) {
    ed.score = ed.max; // not specified → not applicable
  } else {
    const degrees = (cv.education || []).map((e) => `${e.degree || ''} ${e.institution || ''}`.toLowerCase());
    const profileDegrees = (profile.education || []).map((e) => `${e.degree || ''} ${e.fieldOfStudy || ''}`.toLowerCase());
    const allDegrees = [...degrees, ...profileDegrees].join(' ');
    if (eduReqs.level === "bachelor's" || eduReqs.level === 'phd') {
      const has = /b\.?tech|bachelor|bs\b|ba\b|undergraduate|ph\.?d|doctorate/.test(allDegrees);
      ed.score = has ? ed.max : Math.round(ed.max * 0.5 * 10) / 10;
      if (!has) ed.missing.push(`${eduReqs.level} required`);
    } else if (eduReqs.level === "master's") {
      const hasMasters = /m\.?tech|master|ms\b|ma\b/.test(allDegrees);
      const hasBachelors = /b\.?tech|bachelor|bs\b|ba\b/.test(allDegrees);
      if (hasMasters) ed.score = ed.max;
      else if (hasBachelors) {
        ed.score = Math.round(ed.max * 0.5 * 10) / 10;
        ed.missing.push("master's required — candidate holds bachelor's");
      } else { ed.score = 0; ed.missing.push("master's required"); }
    }
  }

  // ── Location (5) ─────────────────────────────────────────────────────
  const loc = makeCat('location', weights.location);
  cats.location = loc;
  const jobLoc = String(job.location || '').toLowerCase();
  const prefLocations = (profile.locationPrefs?.preferredLocations || []).map((l) => String(l).toLowerCase());
  const currentCity = String(profile.locationPrefs?.currentCity || '').toLowerCase();
  const currentCountry = String(profile.locationPrefs?.currentCountry || '').toLowerCase();
  const willingRelocate = profile.locationPrefs?.willingToRelocate;
  const remoteJob = /\bremote\b|worldwide|anywhere/.test(jobLoc) || reqs.workMode === 'remote';
  if (remoteJob) {
    loc.score = loc.max;
    loc.matched.push('Remote role — location-agnostic');
  } else if (prefLocations.some((l) => jobLoc.includes(l)) || (currentCity && jobLoc.includes(currentCity)) || (currentCountry && jobLoc.includes(currentCountry))) {
    loc.score = loc.max;
    loc.matched.push(`Location matches ${currentCity || currentCountry || 'preferred location'}`);
  } else if (willingRelocate === 'no') {
    loc.score = 0;
    loc.blockers.push('Role location conflicts with explicit no-relocation preference');
  } else if (willingRelocate === 'yes') {
    loc.score = Math.round(loc.max * 0.5 * 10) / 10;
    loc.unknowns.push('Relocation willingness is explicit, but role location is outside current region');
  } else {
    loc.score = Math.round(loc.max * 0.5 * 10) / 10;
    loc.unknowns.push('Location fit unknown (relocation preference unset)');
  }

  // ── Work mode (5) ────────────────────────────────────────────────────
  const wm = makeCat('workMode', weights.workMode);
  cats.workMode = wm;
  const pref = profile.locationPrefs?.remotePreference;
  const jobWm = reqs.workMode;
  if (!jobWm) {
    wm.score = wm.max; // not specified
  } else if (!pref || pref === 'unknown') {
    wm.score = Math.round(wm.max * 0.5 * 10) / 10;
    wm.unknowns.push(`Work-mode preference unset (job: ${jobWm})`);
  } else if (pref === 'flexible') {
    wm.score = wm.max;
    wm.matched.push('Flexible preference compatible with any mode');
  } else if (pref === jobWm) {
    wm.score = wm.max;
    wm.matched.push(`${pref} matches job ${jobWm}`);
  } else if (pref === 'remote' && jobWm === 'hybrid') {
    wm.score = Math.round(wm.max * 0.5 * 10) / 10;
    wm.missing.push('Remote preference vs hybrid role');
  } else {
    wm.score = Math.round(wm.max * 0.5 * 10) / 10;
    wm.missing.push(`${pref} preference vs ${jobWm} role`);
  }

  // ── Work authorization (5) ───────────────────────────────────────────
  const wa = makeCat('workAuthorization', weights.workAuthorization);
  cats.workAuthorization = wa;
  const authReqs = reqs.authorization;
  const auth = profile.workAuthorization;
  if (!authReqs) {
    wa.score = wa.max; // not applicable — sponsorship need alone is not a conflict
  } else {
    const authorized = auth?.authorizedToWork;
    const sponsorship = auth?.requiresSponsorship;
        const jdSponsorship = /(?:\b(?:we|employer|company)?\s*cannot\s+(?:provide|offer)\s+(?:visa\s+)?sponsorship\b|\bno\s+(?:visa\s+)?sponsorship\b|\bunable\s+to\s+sponsor\b)/i.test(description);
    const jdSponsorshipAvailable = /sponsorship\s*(?:is\s+)?available|visa\s+sponsorship\s+available|will\s+(?:we\s+)?sponsor|sponsorship\s+offered/i.test(description);
    if (authorized === 'no') {
      wa.score = 0;
      wa.blockers.push('Explicit work-authorization conflict');
    } else if (jdSponsorship && sponsorship === 'yes') {
      wa.score = 0;
      wa.blockers.push('Role cannot provide sponsorship and applicant requires it');
    } else if (jdSponsorshipAvailable && sponsorship === 'yes') {
      wa.score = wa.max;
      wa.matched.push('Sponsorship available and applicant requires it');
    } else if (authorized === 'unknown' || authorized === undefined) {
      wa.score = Math.round(wa.max * 0.5 * 10) / 10;
      wa.unknowns.push('Work authorization unknown (never inferred)');
    } else {
      wa.score = wa.max;
      wa.matched.push('Applicant authorized to work');
    }
  }

  // ── Compensation (5) ─────────────────────────────────────────────────
  const comp = makeCat('compensation', weights.compensation);
  cats.compensation = comp;
  const compReq = reqs.compensation;
  if (!compReq?.explicit) {
    comp.score = comp.max; // not applicable
  } else {
    const minSalary = profile.preferences?.minimumSalary;
    const targetSalary = profile.preferences?.targetSalary;
    const currency = profile.preferences?.salaryCurrency;
    if (!minSalary && !targetSalary) {
      comp.score = Math.round(comp.max * 0.5 * 10) / 10;
      comp.unknowns.push('Salary expectation not set in profile');
    } else if (currency && compReq.currency && currency.toUpperCase() !== compReq.currency.toUpperCase()) {
      comp.score = Math.round(comp.max * 0.5 * 10) / 10;
      comp.unknowns.push(`Currency mismatch (${currency} vs ${compReq.currency}) — no FX conversion`);
    } else {
      const expect = targetSalary || minSalary || 0;
      const offer = compReq.amount || 0;
      if (offer >= expect) {
        comp.score = comp.max;
        comp.matched.push('Compensation meets expectation');
      } else if (minSalary && offer < minSalary) {
        comp.score = Math.round(comp.max * 0.4 * 10) / 10;
        comp.missing.push(`Offer ${offer} below minimum ${minSalary}`);
      } else {
        comp.score = Math.round(comp.max * 0.7 * 10) / 10;
        comp.missing.push('Offer below target');
      }
    }
  }

  // ── Normalize across APPLICABLE categories (dynamic denominator) ─────
  const applicable = Object.entries(cats).filter(([, c]) => c.max > 0);
  let totalScore = 0;
  let totalMax = 0;
  for (const [, c] of applicable) {
    totalScore += c.score;
    totalMax += c.max;
  }
  const score = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;

  const strengths = Object.values(cats).flatMap((c) => c.matched);
  const gaps = Object.values(cats).flatMap((c) => c.missing);
  const blockers = Object.values(cats).flatMap((c) => c.blockers);
  const unknowns = Object.values(cats).flatMap((c) => c.unknowns);
  const evidence = Object.values(cats).flatMap((c) => c.evidence);

  // ── Assessment coverage — how much of the job we could actually assess.
  //    Never alters the score; a sparse JD honestly shows LOW coverage. ──
  const explicitSignals = [
    reqs.requiredSkills.length > 0,
    reqs.preferredSkills.length > 0,
    reqs.minYears !== undefined,
    reqs.education !== undefined,
    reqs.authorization !== undefined,
    reqs.compensation?.explicit === true,
    reqs.workMode !== undefined,
    !!reqs.location,
  ].filter(Boolean).length;
  const applicableCount = Object.values(cats).filter((c) => c.max > 0).length;
  const confidence: FitResult['assessmentCoverage']['confidence'] =
    explicitSignals >= 5 ? 'high' : explicitSignals >= 3 ? 'medium' : 'low';

  return {
    version: FIT_ENGINE_VERSION,
    jobId: job.id,
    score,
    grade: gradeFor(score),
    categories: cats,
    strengths,
    gaps,
    blockers,
    unknowns,
    evidence,
    calculatedAt: new Date().toISOString(),
    assessmentCoverage: {
      applicableCategories: applicableCount,
      totalCategories: Object.keys(cats).length,
      extractedRequirements: explicitSignals,
      confidence,
    },
  };
}