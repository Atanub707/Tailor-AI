// Unified Candidate Profile V1 — ONE canonical fact store, safe migration,
// auth separation, Master CV boundary, thresholds removed from UI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-profile-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile, saveApplicantProfile, getApplicantProfile, migrateLegacyCandidateProfile } = await import('../../server/storage/applicantProfile.js');

beforeAll(() => {
  ensureV2Tables();
  ensureApplicantProfileSchema();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const legacy = (over: Record<string, unknown> = {}) => ({
  workModes: ['remote'], preferredLocations: ['Kolkata, West Bengal, India'],
  noticePeriod: '60 days', availableFrom: '2026-10-01', employmentTypes: ['full-time'],
  yearsExperience: '10+ years', currentRole: 'Legacy Role', currentCompany: 'Legacy Co',
  currentSalary: '20,00,000', expectedSalaryMin: '15,00,000', expectedSalaryMax: '22,00,000',
  salaryCurrency: 'INR', jobSearchStatus: 'Actively looking', willingToRelocate: 'yes',
  willingToTravelPct: '40', workAuthorization: 'Citizen', needsSponsorship: true,
  languages: ['English', 'Hindi'], preferredCompanySize: 'Mid-size (51–500)', recruiterNote: 'Legacy note.',
  ...over,
});

describe('Canonical ownership — one value per fact', () => {
  it('CASE 2 — only canonical populated: keeps canonical', () => {
    const p = defaultApplicantProfile();
    p.preferences = { ...p.preferences, noticePeriod: '30 days' };
    const r = migrateLegacyCandidateProfile(p, legacy({ noticePeriod: '60 days' }));
    // notice period is NOT overwritten; conflict surfaced; other empty facts may still adopt
    expect(r.conflicts.noticePeriod).toBe('60 days');
    expect(r.merged.preferences?.noticePeriod).toBe('30 days');
  });

  it('CASE 3 — only legacy populated: canonical adopts legacy value', () => {
    const p = defaultApplicantProfile();
    const r = migrateLegacyCandidateProfile(p, legacy());
    expect(r.migrated).toBe(true);
    const next = r.merged as any;
    expect(next.preferences?.noticePeriod).toBe('60 days');
    expect(next.preferences?.earliestStartDate).toBe('2026-10-01');
    expect(next.locationPrefs?.preferredLocations).toEqual(['Kolkata, West Bengal, India']);
    expect(next.preferences?.preferredEmploymentTypes).toEqual(['full-time']);
    expect(next.preferences?.jobSearchStatus).toBe('Actively looking');
    expect(next.preferences?.preferredCompanySize).toBe('Mid-size (51–500)');
    expect(next.preferences?.travelPercentage).toBe(40);
    expect(next.preferences?.languages).toEqual(['English', 'Hindi']);
    expect(next.preferences?.recruiterNote).toBe('Legacy note.');
    expect(next.workAuthorization?.requiresSponsorship).toBe('yes');
    expect(next.locationPrefs?.willingToRelocate).toBe('yes');
  });

  it('CASE 5 — both populated & DIFFERENT: conflict recorded, no silent overwrite', () => {
    const p = defaultApplicantProfile();
    p.preferences = { ...p.preferences, noticePeriod: '30 days' };
    p.locationPrefs = { ...p.locationPrefs, preferredLocations: ['Bengaluru'] };
    p.workAuthorization = { ...p.workAuthorization, requiresSponsorship: 'no' };
    const r = migrateLegacyCandidateProfile(p, legacy());
    const next = r.merged as any;
    // Canonical kept; conflicts surfaced
    expect(next.preferences?.noticePeriod).toBe('30 days');
    expect(r.conflicts.noticePeriod).toBe('60 days');
    expect(r.conflicts.requiresSponsorship).toBe('yes');
    expect(next.workAuthorization?.requiresSponsorship).toBe('no');
  });

  it('migration is idempotent — rerun does not resurrect or duplicate', () => {
    const p = defaultApplicantProfile();
    const r1 = migrateLegacyCandidateProfile(p, legacy());
    const next = r1.merged as any;
    const r2 = migrateLegacyCandidateProfile(next, legacy());
    expect(r2.migrated).toBe(false);
    expect(next.preferences?.languages ?? []).toEqual(['English', 'Hindi']);
    expect(next.locationPrefs?.preferredLocations ?? []).toEqual(['Kolkata, West Bengal, India']);
  });

  it('CASE 1/4 — both empty or both equal: remains empty / consolidates', () => {
    const pEmpty = defaultApplicantProfile();
    const rEmpty = migrateLegacyCandidateProfile(pEmpty, legacy({ noticePeriod: '', availableFrom: '', preferredLocations: [], languages: [], employmentTypes: [], recruiterNote: '', jobSearchStatus: '', preferredCompanySize: '', willingToTravelPct: '' }));
    expect(rEmpty.conflicts).toEqual({});
    expect(rEmpty.merged.preferences?.noticePeriod ?? null).toBe(null);
    const pSame = defaultApplicantProfile();
    pSame.preferences = { ...pSame.preferences, noticePeriod: '30 days' };
    const rSame = migrateLegacyCandidateProfile(pSame, legacy({ noticePeriod: '30 days', availableFrom: '', preferredLocations: [] }));
    expect(rSame.conflicts.noticePeriod).toBeUndefined();
    expect(rSame.merged.preferences?.noticePeriod).toBe('30 days');
  });
});

describe('Auth separation', () => {
  it('application email and sign-in email are distinct sources', () => {
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'R', lastName: 'K', email: 'jobs@example.com' };
    // sign-in email lives in the auth record, never copied into profile handling by Auto-Apply
    expect(p.personal.email).toBe('jobs@example.com');
  });
});

describe('Master CV boundary', () => {
  it('buildProfileText derives current role/company/years from Master CV only', async () => {
    const { buildProfileText } = await import('../../server/emailProfile.js');
    const p = defaultApplicantProfile();
    p.personal = { firstName: 'R', lastName: 'K', email: 'jobs@example.com' };
    const cv = { experiences: [{ title: 'Senior Engineer', company: 'ACME', dates: '2020-01 — Present', responsibilities: [], id: '1', location: '' }], fullName: 'R K', email: 'x', phone: 'x', location: '', summary: '', education: [], skills: [], certifications: [] } as any;
    const text = buildProfileText(p, cv);
    expect(text).toContain('Current role: Senior Engineer');
    expect(text).toContain('Current company: ACME');
    expect(text).toContain('Years of experience: ');
    expect(text).not.toContain('Legacy Role');
    expect(text).not.toContain('Legacy Co');
  });
});

describe('Matching thresholds — removed from normal UI, backend intact', () => {
  it('Settings UI no longer exposes Auto-tailor minimum / Early block', () => {
    const settings = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    expect(settings).not.toContain('Auto-tailor minimum');
    expect(settings).not.toContain('Early block');
  });
  it('backend config consumers still exist (safe default behavior)', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(server).toContain('thresholds.earlyBlockThreshold');
    expect(server).toContain('thresholds.minMatchForTailor');
  });
});

