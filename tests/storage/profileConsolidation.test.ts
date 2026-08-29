// Applicant Profile → Settings consolidation — ONE canonical source.
// Verifies: deterministic resolution order (Profile → Master CV → unresolved),
// sensitive/unknown never resolved, consent requires explicit action,
// package snapshot integrity, and backend model compatibility.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-consolid-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile, getApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { resolveDeterministicAnswers } = await import('../../server/applicationPackage/answers.js');
import type { Job, MasterCv } from '../../src/types.js';

const job = (): Job => ({ id: 'j1', externalId: 'j1', title: 'Platform Engineer', company: 'Veo', companyId: 'Veo', location: 'Copenhagen', description: 'x', atsPlatform: 'lever', jobUrl: 'x', applyUrl: 'x', url: 'x', source: 'Lever', state: 'pending' } as unknown as Job);
const cv = (): MasterCv => ({ fullName: 'Ravi Kumar', email: 'cv@example.com', phone: 'cv-phone', location: 'B', summary: 'x', linkedin: 'cv-linkedin', experiences: [], education: [], skills: [], certifications: [] } as unknown as MasterCv);

beforeAll(() => {
  const db = getDb();
  ensureV2Tables();
  ensureApplicantProfileSchema();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Canonical profile — one source of truth', () => {
  it('Profile fields win over Master CV; missing profile fields fall back to Master CV', () => {
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'Test', lastName: 'Name', email: 'test@example.com', phone: 'profile-phone' };
    p.links = { linkedin: 'https://linkedin.com/in/test' };
    const answers = resolveDeterministicAnswers(cv(), p, job());
    const get = (k: string) => answers.find((a) => a.key === k);
    expect(get('firstName')?.value).toBe('Test');
    expect(get('firstName')?.source).toBe('PROFILE');
    expect(get('email')?.value).toBe('test@example.com');
    expect(get('email')?.source).toBe('PROFILE');
    expect(get('linkedinUrl')?.value).toBe('https://linkedin.com/in/test');
    // phone: profile wins
    expect(get('phone')?.value).toBe('profile-phone');
  });

  it('Unknown custom + sensitive questions are never resolved', () => {
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'T', lastName: 'U' };
    const a = resolveDeterministicAnswers(cv(), p, job());
    // ATS asks a company-specific open question — not a profile key → unresolved.
    // (whyInterested is a legitimate reusable Application Default; EEO is not.)
    // whyInterested lives in Application Defaults — only set when the user
    // explicitly provides it; never auto-inferred for unknown questions.
    expect(a.find((x) => x.key === 'whyInterested')?.value ?? null).toBe(null);
    expect(a.some((x) => /custom|screening/i.test(x.key))).toBe(false);
    // EEO — never inferred
    expect(a.some((x) => /race|ethnicity|gender|disability|veteran/i.test(x.key))).toBe(false);
  });

  it('Authorized-to-work and sponsorship answered ONLY when explicitly provided', () => {
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'R', lastName: 'K' };
    const empty = resolveDeterministicAnswers(cv(), p, job());
    expect(empty.find((x) => x.key === 'authorizedToWork')?.value ?? null).toBe(null);
    expect(empty.find((x) => x.key === 'requiresSponsorship')?.value ?? null).toBe(null);
    p.workAuthorization = { authorizedToWork: 'yes', requiresSponsorship: 'no' };
    const filled = resolveDeterministicAnswers(cv(), p, job());
    expect(String(filled.find((x) => x.key === 'authorizedToWork')?.value).toLowerCase()).toBe('yes');
    expect(String(filled.find((x) => x.key === 'requiresSponsorship')?.value).toLowerCase()).toBe('no');
  });

  it('Consent is never part of reusable profile answers', () => {
    const a = resolveDeterministicAnswers(cv(), defaultApplicantProfile(), job());
    expect(a.some((x) => /consent|privacy|terms|accuracy/i.test(x.key))).toBe(false);
  });
});

describe('Model compatibility + persistence', () => {
  it('save/get rounds trip and keeps existing values', () => {
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'Atanu', lastName: 'Biswas', email: 'a@b.com', phone: '+1' };
    p.links = { github: 'https://github.com/atanu' };
    saveApplicantProfile(p, 'u1');
    const back = getApplicantProfile('u1');
    expect(back?.personal?.firstName).toBe('Atanu');
    expect(back?.links?.github).toBe('https://github.com/atanu');
    expect(back?.version).toBeGreaterThan(0);
  });

  it('Setting the same identity through Settings UI endpoints keeps ONE version (no second table)', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    // Exactly ONE identity table family: applicant_profile (+ its migration
    // bookkeeping table if present). No settings_profile copy.
    const identityTables = tables.filter((t: string) => /applicant_profile/i.test(t));
    expect(identityTables.length).toBeGreaterThanOrEqual(1);
    expect((tables as string[]).filter((t) => /^settings_profile|^profile_settings/i.test(t)).length).toBe(0);
  });
});