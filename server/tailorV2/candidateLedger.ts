// Candidate Fact Ledger — deterministic source-of-truth for Tailor V2.
// Generated WITHOUT any LLM from the Master CV + Applicant Profile.
// Every candidate claim in a tailored resume must be grounded here.

import type { MasterCv, ApplicantProfile } from '../../src/types.js';

export interface LedgerFact {
  employers: string[];
  titles: string[];
  employmentDates: string[];
  education: string[];
  certifications: string[];
  explicitSkills: string[];
  projects: string[];
  achievements: string[];
  metrics: string[];
  technologies: string[];
  /** skills grouped by employer (association protection) */
  skillsByEmployer: Record<string, string[]>;
}

const NUMBER_RE = /(?:^|\s)(\d+(?:[.,]\d+)?\s*(?:%|x|X|k|K|m|M|b|B|bn|mn|\+)?)(?:\s|$)/g;

function extractMetrics(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const s = String(t || '');
    let m: RegExpExecArray | null;
    while ((m = NUMBER_RE.exec(s)) !== null) {
      out.add(m[1].toLowerCase());
    }
  }
  return [...out];
}

function normalizeWord(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?()]+$/g, '');
}

export function buildCandidateFactLedger(cv: MasterCv, profile: ApplicantProfile): LedgerFact {
  const employers = new Set<string>();
  const titles = new Set<string>();
  const employmentDates = new Set<string>();
  const education = new Set<string>();
  const certifications = new Set<string>();
  const explicitSkills = new Set<string>();
  const projects = new Set<string>();
  const achievements: string[] = [];
  const technologies = new Set<string>();
  const skillsByEmployer: Record<string, string[]> = {};

  for (const e of cv.experiences || []) {
    if (e.company) employers.add(normalizeWord(e.company));
    if (e.title) titles.add(normalizeWord(e.title));
    if (e.dates) employmentDates.add(normalizeWord(e.dates));
    for (const r of e.responsibilities || []) {
      if (r) achievements.push(String(r).trim());
      const tech = String(r || '').toLowerCase();
      // Deterministic technology tokens in responsibility text.
      for (const t of ['aws', 'gcp', 'azure', 'kubernetes', 'k8s', 'docker', 'terraform', 'ansible', 'python', 'golang', 'go', 'java', 'typescript', 'react', 'postgresql', 'mysql', 'redis', 'kafka', 'jenkins', 'gitlab', 'ci/cd', 'prometheus', 'grafana', 'linux', 'bash', 'sql', 'gke', 'eks']) {
        if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(tech)) technologies.add(t);
      }
      if (e.company) {
        const key = normalizeWord(e.company);
        skillsByEmployer[key] = skillsByEmployer[key] || [];
        for (const t of ['aws', 'gcp', 'azure', 'kubernetes', 'k8s', 'docker', 'terraform', 'python', 'typescript', 'react', 'sql', 'gke', 'eks', 'ci/cd', 'jenkins', 'gitlab', 'prometheus', 'grafana', 'linux', 'bash']) {
          if (new RegExp(`\\b${t}\\b`).test(tech)) {
            if (!skillsByEmployer[key].includes(t)) skillsByEmployer[key].push(t);
          }
        }
      }
    }
  }
  for (const e of profile.experience || []) {
    if (e.company) employers.add(normalizeWord(e.company));
    if (e.title) titles.add(normalizeWord(e.title));
    if (e.startDate) employmentDates.add(e.startDate);
    if (e.endDate) employmentDates.add(e.endDate);
    for (const a of e.achievements || []) if (a) achievements.push(String(a).trim());
    for (const t of e.technologies || []) if (t) technologies.add(String(t).toLowerCase());
  }

  for (const e of cv.education || []) {
    const parts = [e.degree, e.institution, e.dates].filter(Boolean).map((p) => normalizeWord(p));
    if (parts.length) education.add(parts.join(' | '));
  }
  for (const e of profile.education || []) {
    const parts = [e.degree, e.institution, e.startDate, e.endDate].filter(Boolean).map((p) => normalizeWord(p));
    if (parts.length) education.add(parts.join(' | '));
  }

  for (const c of cv.certifications || []) {
    const name = typeof c === 'string' ? c : c.name;
    if (name) certifications.add(normalizeWord(name));
  }
  for (const c of profile.certifications || []) if (c.name) certifications.add(normalizeWord(c.name));

  for (const g of cv.skills || []) for (const i of g.items || []) explicitSkills.add(normalizeWord(i));
  for (const s of profile.skills || []) if (s.name) explicitSkills.add(normalizeWord(s.name));

  for (const p of cv.projects || []) if (p) projects.add(normalizeWord(String(p)));

  const metrics = extractMetrics(
    cv.summary,
    ...(cv.experiences || []).flatMap((e) => e.responsibilities || []),
    ...(profile.experience || []).flatMap((e) => e.achievements || [])
  );

  return {
    employers: [...employers],
    titles: [...titles],
    employmentDates: [...employmentDates],
    education: [...education],
    certifications: [...certifications],
    explicitSkills: [...explicitSkills],
    projects: [...projects],
    achievements,
    metrics,
    technologies: [...technologies],
    skillsByEmployer,
  };
}

export { normalizeWord };