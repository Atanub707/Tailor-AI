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

/** One-time, idempotent migration from the legacy CandidateProfile store into
 *  the canonical applicant_profile. Rule: only fill EMPTY canonical fields
 *  from the legacy store; never overwrite; record genuine conflicts once. */
export function migrateLegacyCandidateProfile(profile: ApplicantProfile, legacy: any): { migrated: boolean; conflicts: Record<string, string>; merged: ApplicantProfile } {
  const conflicts: Record<string, string> = {};
  const prefs = profile.preferences || {};

  const adopt = (key: string, canonicalValue: unknown, legacyValue: unknown) => {
    if (legacyValue === undefined || legacyValue === null || legacyValue === '' || (Array.isArray(legacyValue) && legacyValue.length === 0)) return false; // CASE 1
    if (canonicalValue !== undefined && canonicalValue !== null && canonicalValue !== '' && !(Array.isArray(canonicalValue) && canonicalValue.length === 0)) {
      // CASE 5 — both populated & different: do NOT silently overwrite
      if (JSON.stringify(canonicalValue) !== JSON.stringify(legacyValue)) conflicts[key] = String(legacyValue);
      return false;
    }
    // CASE 2/3 — canonical empty → adopt legacy
    return true;
  };

  const apply = (fn: (next: any) => void) => { fn(prefs); };
  const changes: any = {};

  if (adopt('noticePeriod', prefs.noticePeriod, legacy.noticePeriod)) changes.noticePeriod = legacy.noticePeriod;
  if (adopt('earliestStartDate', prefs.earliestStartDate, legacy.availableFrom)) changes.earliestStartDate = legacy.availableFrom;
  if (adopt('minimumSalary', prefs.minimumSalary, legacy.expectedSalaryMin ? Number(legacy.expectedSalaryMin) : undefined)) changes.minimumSalary = legacy.expectedSalaryMin ? Number(legacy.expectedSalaryMin) : undefined;
  if (adopt('targetSalary', prefs.targetSalary, legacy.expectedSalaryMax ? Number(legacy.expectedSalaryMax) : undefined)) changes.targetSalary = legacy.expectedSalaryMax ? Number(legacy.expectedSalaryMax) : undefined;
  if (adopt('salaryCurrency', prefs.salaryCurrency, legacy.salaryCurrency)) changes.salaryCurrency = legacy.salaryCurrency;
  if (adopt('currentSalary', prefs.currentSalary, legacy.currentSalary ? Number(legacy.currentSalary) : undefined)) changes.currentSalary = legacy.currentSalary ? Number(legacy.currentSalary) : undefined;
  // Authorization / sponsorship / relocation (explicit values only)
  if (adopt('authorizedToWork', profile.workAuthorization?.authorizedToWork, legacy.workAuthorization || undefined)) {
    if (legacy.workAuthorization) changes.authorizedToWork = legacy.workAuthorization;
  }
  if (adopt('requiresSponsorship', profile.workAuthorization?.requiresSponsorship, legacy.needsSponsorship === true ? 'yes' : legacy.needsSponsorship === false ? 'no' : undefined)) {
    if (legacy.needsSponsorship !== undefined) changes.requiresSponsorship = legacy.needsSponsorship ? 'yes' : 'no';
  }
  if (adopt('willingToRelocate', profile.locationPrefs?.willingToRelocate, legacy.willingToRelocate || undefined)) {
    if (legacy.willingToRelocate) changes.willingToRelocate = legacy.willingToRelocate;
  }
  // Job-preference lists
  if (adopt('preferredLocations', profile.locationPrefs?.preferredLocations, legacy.preferredLocations)) changes.preferredLocations = legacy.preferredLocations;
  if (adopt('preferredEmploymentTypes', prefs.preferredEmploymentTypes, legacy.employmentTypes)) changes.preferredEmploymentTypes = legacy.employmentTypes;
  if (adopt('desiredTitles', prefs.desiredTitles, legacy.desiredRolesOfInterest ?? [])) changes.desiredTitles = undefined; // only if legacy has none
  if (adopt('jobSearchStatus', prefs.jobSearchStatus, legacy.jobSearchStatus)) changes.jobSearchStatus = legacy.jobSearchStatus;
  if (adopt('preferredCompanySize', prefs.preferredCompanySize, legacy.preferredCompanySize)) changes.preferredCompanySize = legacy.preferredCompanySize;
  if (adopt('travelPercentage', prefs.travelPercentage, legacy.willingToTravelPct ? Number(legacy.willingToTravelPct) : undefined)) changes.travelPercentage = legacy.willingToTravelPct ? Number(legacy.willingToTravelPct) : undefined;
  if (adopt('languages', prefs.languages, legacy.languages)) changes.languages = legacy.languages;
  if (adopt('recruiterNote', prefs.recruiterNote, legacy.recruiterNote)) changes.recruiterNote = legacy.recruiterNote;

  if (Object.keys(changes).length === 0) return { migrated: false, conflicts, merged: profile };

  const next = {
    ...profile,
    preferences: { ...prefs },
  };
  for (const [k, v] of Object.entries(changes)) {
    if (['authorizedToWork', 'requiresSponsorship', 'willingToRelocate', 'preferredLocations'].includes(k)) {
      if (k === 'preferredLocations') next.locationPrefs = { ...next.locationPrefs, preferredLocations: v as string[] };
      else if (k === 'authorizedToWork' || k === 'requiresSponsorship') next.workAuthorization = { ...next.workAuthorization, [k]: v };
      else if (k === 'willingToRelocate') next.locationPrefs = { ...next.locationPrefs, willingToRelocate: v as any };
    } else {
      next.preferences = { ...next.preferences, [k]: v };
    }
  }
  return { migrated: true, conflicts, merged: next };
}
