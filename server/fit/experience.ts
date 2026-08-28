// Experience duration calculation — deterministic, overlap-safe.
// Missing/partial dates → UNKNOWN (never invented).

import type { ProfileExperience } from '../../src/types.js';

export function parseMonth(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4})-(\d{2})/.exec(raw);
  if (m) return Number(m[1]) * 12 + Number(m[2]) - 1;
  const y = /^(\d{4})$/.exec(raw);
  if (y) return Number(y[1]) * 12 + 5.5; // year-only → midpoint (deterministic)
  return undefined;
}

export interface Interval {
  start: number | undefined;
  end: number | undefined; // month index; undefined = ongoing
}

export function experienceIntervals(entries: ProfileExperience[]): Interval[] {
  return (entries || []).map((e) => ({
    start: parseMonth(e.startDate),
    end: e.isCurrent ? undefined : parseMonth(e.endDate),
  }));
}

/** Union of intervals — overlapping months counted ONCE. */
export function unionMonths(intervals: Interval[]): number {
  if (!intervals.length) return 0;
  const known = intervals
    .filter((i) => i.start !== undefined && (i.end !== undefined || i.start !== undefined))
    .map((i) => ({ start: i.start as number, end: i.end ?? Infinity }));
  if (!known.length) return 0;
  known.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const k of known) {
    const last = merged[merged.length - 1];
    if (last && k.start <= last.end + 1) {
      last.end = Math.max(last.end, k.end);
    } else {
      merged.push({ start: k.start, end: k.end });
    }
  }
  const now = new Date().getFullYear() * 12 + new Date().getMonth();
  let months = 0;
  for (const m of merged) {
    const end = Number.isFinite(m.end) ? m.end : now;
    if (end >= m.start) months += end - m.start + 1;
  }
  return months;
}

export function experienceMonths(entries: ProfileExperience[]): { months: number | undefined; known: boolean } {
  const intervals = experienceIntervals(entries);
  if (!intervals.length) return { months: 0, known: true }; // no entries = 0 known months
  const anyKnown = intervals.some((i) => i.start !== undefined);
  if (!anyKnown) return { months: undefined, known: false };
  return { months: unionMonths(intervals), known: true };
}

export function experienceYears(entries: ProfileExperience[]): { years: number | undefined; known: boolean } {
  const r = experienceMonths(entries);
  if (!r.known) return { years: undefined, known: false };
  return { years: Math.round((r.months || 0) / 12 * 10) / 10, known: true };
}

/** Conservative domain relevance: match experience titles against a job
 *  family using deterministic keywords. Never counts unrelated roles. */
const FAMILY_TERMS: Record<string, string[]> = {
  devops: ['devops', 'platform', 'sre', 'site reliability', 'cloud infrastructure', 'reliability'],
  platform: ['platform', 'devops', 'infrastructure', 'sre', 'cloud'],
  sre: ['sre', 'site reliability', 'reliability', 'devops', 'platform'],
  cloud: ['cloud', 'aws', 'azure', 'gcp', 'cloud engineer', 'devops', 'platform'],
  security: ['security', 'secops', 'appsec', 'infosec', 'cryptography', 'vulnerability'],
  software: ['software', 'developer', 'engineer', 'backend', 'frontend', 'full stack', 'fullstack'],
  data: ['data', 'analytics', 'etl', 'machine learning', 'ml', 'spark', 'database'],
};

export function relevantExperienceMonths(entries: ProfileExperience[], family?: string): { months: number | undefined; known: boolean } {
  if (!family || !FAMILY_TERMS[family]) return experienceMonths(entries);
  const terms = FAMILY_TERMS[family];
  const relevant = (entries || []).filter((e) => {
    const hay = `${e.title || ''} ${e.company || ''} ${(e.summary || '').slice(0, 300)} ${(e.achievements || []).join(' ')}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
  return experienceMonths(relevant);
}