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

const ROLE_FAMILY: Array<{ family: string; terms: string[] }> = [
  { family: 'devops', terms: ['devops', 'platform engineer', 'sre', 'site reliability'] },
  { family: 'platform', terms: ['platform'] },
  { family: 'sre', terms: ['sre', 'site reliability'] },
  { family: 'cloud', terms: ['cloud'] },
  { family: 'security', terms: ['security', 'secops', 'appsec', 'infosec'] },
  { family: 'software', terms: ['software', 'developer', 'backend', 'frontend', 'full stack'] },
  { family: 'data', terms: ['data', 'machine learning', 'ml engineer', 'analytics'] },
];

function jobFamily(title: string): string | undefined {
  const t = String(title || '').toLowerCase();
  return ROLE_FAMILY.find((f) => f.terms.some((x) => t.includes(x)))?.family;
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
  const family = jobFamily(job.title);
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
  const expRaw = relevantExperienceMonths(profile.experience, family);
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

  // ── Role alignment (15) ──────────────────────────────────────────────
  const ra = makeCat('roleAlignment', weights.roleAlignment);
  cats.roleAlignment = ra;
  const expTitles = [
    ...(cv.experiences || []).map((e) => e.title),
    ...(profile.experience || []).map((e) => e.title),
  ];
  const familyTerms = family ? ROLE_FAMILY.find((f) => f.family === family)?.terms : undefined;
  const aligned = familyTerms ? expTitles.some((t) => familyTerms.some((term) => String(t).toLowerCase().includes(term))) : true;
  ra.score = aligned ? ra.max : Math.round(ra.max * 0.5 * 10) / 10;
  ra.matched = aligned ? [`Background aligns with ${family || 'role family'}`] : [];
  ra.missing = aligned ? [] : ['No experience titles in the target role family'];

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
    wa.score = wa.max; // not applicable
  } else {
    const authorized = auth?.authorizedToWork;
    const sponsorship = auth?.requiresSponsorship;
    if (authReqs.sponsorship && sponsorship === 'yes') {
      wa.score = Math.round(wa.max * 0.5 * 10) / 10;
      wa.missing.push('Role requires sponsorship and applicant needs sponsorship');
    } else if (authorized === 'no') {
      wa.score = 0;
      wa.blockers.push('Explicit work-authorization conflict');
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
  };
}