// Applicant Profile v1 — canonical local profile storage + validation.
// One versioned JSON record per local user (mirrors master_cv pattern).
// Local-first: nothing here ever leaves the machine except explicit user
// actions. Never logs profile payloads.

import type { ApplicantProfile } from '../../src/types.js';
import { getDb, getCurrentUserId } from './fileStorage.js';

export const PROFILE_VERSION = 1;

export function defaultApplicantProfile(): ApplicantProfile {
  return {
    version: PROFILE_VERSION,
    updatedAt: undefined,
    personal: {},
    contact: {},
    links: {},
    locationPrefs: {},
    workAuthorization: {},
    preferences: {},
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    applicationDefaults: {},
    optionalSensitive: { enabled: false },
  };
}

export function ensureApplicantProfileSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS applicant_profile (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);
}

/** ONE FACT = ONE CANONICAL FIELD. Phase-1 payloads may carry legacy
 *  duplicate fields under applicationDefaults; migrate them into the
 *  canonical slot ONLY when the canonical slot is empty (canonical wins on
 *  conflict), then strip the legacy keys entirely. Idempotent. */
function normalizeCanonical(p: ApplicantProfile): ApplicantProfile {
  const legacy = (p as any).applicationDefaults || {};
  const prefs = p.preferences || {};
  const loc = p.locationPrefs || {};
  const wa = p.workAuthorization || {};
  const merged: ApplicantProfile = {
    ...p,
    preferences: {
      ...prefs,
      noticePeriod: prefs.noticePeriod ?? legacy.noticePeriod ?? undefined,
      currentSalary: prefs.currentSalary ?? legacy.currentSalary ?? undefined,
      minimumSalary: prefs.minimumSalary ?? legacy.expectedSalary ?? undefined,
      salaryCurrency: prefs.salaryCurrency ?? legacy.salaryCurrency ?? undefined,
      earliestStartDate: prefs.earliestStartDate ?? legacy.availableStartDate ?? undefined,
    },
    locationPrefs: {
      ...loc,
      willingToRelocate: loc.willingToRelocate ?? legacy.willingToRelocate ?? undefined,
    },
    workAuthorization: {
      ...wa,
      authorizedToWork: wa.authorizedToWork ?? legacy.workAuthorization ?? undefined,
      requiresSponsorship: wa.requiresSponsorship ?? legacy.sponsorship ?? undefined,
    },
    applicationDefaults: {
      reasonForChange: legacy.reasonForChange ?? undefined,
      whyInterestedDefault: legacy.whyInterestedDefault ?? undefined,
      preferredContactMethod: legacy.preferredContactMethod ?? undefined,
    },
  };
  // legacy.yearsOfExperience is intentionally NOT migrated (STEP 5: Fit
  // Engine derives experience from structured experience).
  return merged;
}

function parseStored(raw: string | undefined): ApplicantProfile {
  try {
    const p = JSON.parse(raw || 'null') as ApplicantProfile;
    if (p && typeof p === 'object' && p.version) {
      // Versioned payloads are the contract; unknown versions are refused
      // (never silently mangled by older readers).
      if (p.version !== PROFILE_VERSION) return defaultApplicantProfile();
      return normalizeCanonical(p);
    }
  } catch {
    /* corrupt row → fresh default, never crash the app */
  }
  return defaultApplicantProfile();
}

export function getApplicantProfile(userId?: string): ApplicantProfile {
  const targetId = userId || getCurrentUserId();
  ensureApplicantProfileSchema();
  const row = getDb().prepare('SELECT data FROM applicant_profile WHERE user_id = ?').get(targetId) as { data: string } | undefined;
  if (row) return parseStored(row.data);
  const fresh = defaultApplicantProfile();
  saveApplicantProfile(fresh, targetId);
  return fresh;
}

export function saveApplicantProfile(profile: ApplicantProfile, userId?: string): void {
  const targetId = userId || getCurrentUserId();
  ensureApplicantProfileSchema();
  const payload: ApplicantProfile = { ...defaultApplicantProfile(), ...normalizeCanonical(profile), version: PROFILE_VERSION, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(`
      INSERT INTO applicant_profile (user_id, data, version, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at
    `)
    .run(targetId, JSON.stringify(payload), PROFILE_VERSION, payload.updatedAt);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const SALARY_RANGE = { min: 0, max: 10_000_000_000 };

function validOptionalString(v: unknown, maxLen = 500): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= maxLen);
}

/** Server-side validation — tolerant on real-world names/titles, strict on
 *  machine-consumed formats (email/URL/date/salary/travel%). */
export function validateApplicantProfile(p: ApplicantProfile): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['Profile must be an object.'] };
  if (p.version !== PROFILE_VERSION) errors.push(`Unsupported profile version ${String(p.version)} — expected ${PROFILE_VERSION}.`);

  const email = p.personal?.email;
  if (email !== undefined && email !== null && email !== '' && !EMAIL_RE.test(email)) {
    errors.push('Email format is invalid.');
  }
  const phone = p.personal?.phone;
  if (phone !== undefined && phone !== null && phone !== '' && !/^[0-9+\-().\s]{6,24}$/.test(phone)) {
    errors.push('Phone format is invalid.');
  }
  for (const [label, v] of [
    ['linkedin', p.links?.linkedin],
    ['github', p.links?.github],
    ['portfolio', p.links?.portfolio],
    ['website', p.links?.website],
  ] as const) {
    if (v !== undefined && v !== null && v !== '' && !URL_RE.test(v)) errors.push(`${label} URL is invalid.`);
  }
  for (const d of [p.workAuthorization?.validUntil, p.preferences?.earliestStartDate]) {
    if (d !== undefined && d !== null && d !== '' && !DATE_RE.test(d)) errors.push('Date format is invalid (expected YYYY or YYYY-MM or YYYY-MM-DD).');
  }
  for (const [label, v] of [
    ['minimumSalary', p.preferences?.minimumSalary],
    ['targetSalary', p.preferences?.targetSalary],
    ['currentSalary', p.preferences?.currentSalary],
  ] as const) {
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < SALARY_RANGE.min || v > SALARY_RANGE.max)) {
      errors.push(`${label} must be a non-negative number.`);
    }
  }
  const travel = p.preferences?.travelPercentage;
  if (travel !== undefined && travel !== null && (typeof travel !== 'number' || travel < 0 || travel > 100)) {
    errors.push('Travel percentage must be between 0 and 100.');
  }
  for (const e of p.experience || []) {
    if (e.startDate && !DATE_RE.test(e.startDate)) errors.push(`Experience at ${e.company || 'unknown company'}: invalid start date.`);
    if (e.endDate && !DATE_RE.test(e.endDate)) errors.push(`Experience at ${e.company || 'unknown company'}: invalid end date.`);
  }
  if (!validOptionalString(p.personal?.firstName) || !validOptionalString(p.personal?.lastName) || !validOptionalString(p.personal?.preferredName)) {
    errors.push('Names are too long.');
  }
  return { ok: errors.length === 0, errors };
}

/** Tolerant date parse for CV import: 'Jan 2020', '2020-01', 'Jan 2020 – Present'. */
export function parseCvDate(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const m = raw.match(/(\d{4})/);
  if (!m) return undefined;
  const year = m[1];
  const month = raw.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
  const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  return month ? `${year}-${MONTHS[month[1].toLowerCase()]}` : year;
}

export function isCvDateCurrent(raw: string | undefined): boolean {
  return /present|current|now/i.test(String(raw || ''));
}