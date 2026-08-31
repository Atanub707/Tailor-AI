import { describe, it, expect, beforeAll } from 'vitest';
import { buildProfileText } from '../../server/emailProfile';
import { defaultApplicantProfile, ensureApplicantProfileSchema } from '../../server/storage/applicantProfile';
import type { MasterCv, ApplicantProfile } from '../../src/types';

function canonical(): ApplicantProfile {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'Ravi', lastName: 'Kumar', email: 'jobs@example.com', phone: '+91 90000 00000' };
  p.locationPrefs = { currentCity: 'Bengaluru', currentCountry: 'India', preferredLocations: ['Kolkata, West Bengal, India', 'Bengaluru, Karnataka, India'], remotePreference: 'hybrid' };
  p.preferences = {
    preferredEmploymentTypes: ['full-time', 'contract'],
    jobSearchStatus: 'Actively looking',
    travelPercentage: 25,
    noticePeriod: '30 days',
    earliestStartDate: '2026-09-01',
    languages: ['English', 'Hindi'],
    recruiterNote: 'Open to contract-to-hire.',
  };
  return p;
}

const cv: MasterCv = {
  fullName: 'Ravi Kumar', email: 'jobs@example.com', phone: '+91 90000 00000', location: 'B',
  summary: 'x',
  experiences: [
    { id: '1', title: 'Senior Engineer', company: 'ACME', location: 'B', dates: '2022-01 — Present', responsibilities: [] },
    { id: '2', title: 'Engineer', company: 'BETA', location: 'A', dates: '2019-01 — 2021-12', responsibilities: [] },
  ],
  education: [{ id: 'e1', degree: 'B.Tech', institution: 'NIT', details: '' }],
  skills: [{ category: 'skills', items: [] }],
  certifications: [],
} as unknown as MasterCv;

const emptyCanonical = defaultApplicantProfile();

beforeAll(() => { ensureApplicantProfileSchema(); });

describe('buildProfileText — canonical candidate context', () => {
  it('reads canonical profile + Master CV professional facts', () => {
    const text = buildProfileText(canonical(), cv);
    const lines = text.split('\n');
    expect(lines).toContain('Notice period: 30 days');
    expect(lines).toContain('Available from: 2026-09-01');
    expect(lines).toContain('Work mode preference: Hybrid');
    expect(lines).toContain('Preferred locations: Kolkata, West Bengal, India, Bengaluru, Karnataka, India');
    expect(lines).toContain('Employment type preference: full-time, contract');
    expect(lines).toContain('Job search status: Actively looking');
    expect(lines).toContain('Years of experience: 7+'); // derived from Master CV dates
    expect(lines).toContain('Current role: Senior Engineer'); // from Master CV, not profile
    expect(lines).toContain('Current company: ACME');
    expect(lines).toContain('Recruiter note: Open to contract-to-hire.');
    expect(lines).toContain('Languages: English, Hindi');
  });

  it('never leaks compensation into the drafted email text (privacy)', () => {
    const p = canonical();
    p.preferences = { ...p.preferences, currentSalary: 1400000, minimumSalary: 1200000, targetSalary: 1800000, salaryCurrency: 'INR' };
    const text = buildProfileText(p, cv);
    expect(text).not.toContain('14,00,000');
    expect(text).not.toContain('12,00,000');
    expect(text).not.toContain('18,00,000');
    expect(text).not.toContain('INR');
    expect(text.toLowerCase()).not.toContain('salary');
    expect(text.toLowerCase()).not.toContain('compensation');
  });

  it('returns an empty string when canonical is empty and no CV history exists', () => {
    const emptyCv = { ...cv, experiences: [] } as unknown as MasterCv;
    expect(buildProfileText(emptyCanonical, emptyCv)).toBe('');
  });
});