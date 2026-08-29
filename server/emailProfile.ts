import { CandidateProfile } from './storage/fileStorage.js';
import type { ApplicantProfile } from '../src/types.js';

// CANONICAL candidate context for cold emails / AI matching. Reads the SAME
// facts Auto-Apply reads (applicant_profile) plus professional history from
// the Master CV. Legacy CandidateProfile is only a transition fallback when
// canonical values are entirely absent.
export function buildProfileText(profile: ApplicantProfile, cv: any, legacy?: CandidateProfile): string {
  const p = profile || {} as any;
  const prefs = p.preferences || {};
  const loc = p.locationPrefs || {};
  const wa = p.workAuthorization || {};
  const line = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value) && value.length === 0) return '';
    return `${label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`;
  };

  // Master CV derived professional facts (never a Candidate Profile copy)
  const experiences = cv?.experiences || [];
  const latest = experiences[0] || null;
  const yearsOfExperience = (() => {
    let minY = Infinity, maxY = 0, any = false;
    for (const e of experiences) {
      const range = String(e?.dates || e?.startDate || '');
      const s = Number(range.slice(0, 4) || 0);
      const endMatch = String(range).match(/(?:-|—|–|to|until)\s*(20\d{2})/);
      const isOpen = /present|now|current|ongoing/i.test(range) || !endMatch;
      const en = endMatch ? Number(endMatch[1]) : (isOpen ? new Date().getFullYear() : 0);
      if (s) { minY = Math.min(minY, s); any = true; }
      if (en) { maxY = Math.max(maxY, en); any = true; }
    }
    return any ? `${maxY - minY}+` : '';
  })();

  // Work mode from canonical remotePreference (was CandidateProfile.workModes)
  const workModeLabel = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', flexible: 'Flexible' }[loc.remotePreference || ''] || '';

  // Transition fallback: legacy values only when the canonical side is empty.
  const pick = (a: unknown, b: unknown) => (a === undefined || a === null || a === '' ? b : a);
  const legacyList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]).filter(Boolean) : []);

  return [
    line('Notice period', pick(prefs.noticePeriod, legacy?.noticePeriod)),
    line('Available from', pick(prefs.earliestStartDate, legacy?.availableFrom)),
    line('Work mode preference', workModeLabel || (legacy?.workModes?.length ? legacy.workModes.join(', ') : '')),
    line('Preferred locations', loc.preferredLocations?.length ? loc.preferredLocations : legacyList(legacy?.preferredLocations)),
    line('Employment type preference', prefs.preferredEmploymentTypes?.length ? prefs.preferredEmploymentTypes : legacyList(legacy?.employmentTypes)),
    line('Job search status', pick(prefs.jobSearchStatus, legacy?.jobSearchStatus)),
    line('Years of experience', yearsOfExperience || legacy?.yearsExperience || ''),
    line('Current role', latest?.title || legacy?.currentRole || ''),
    line('Current company', latest?.company || legacy?.currentCompany || ''),
    line('Work authorization', pick(wa.country, legacy?.workAuthorization) || ''),
    line('Requires sponsorship', wa.requiresSponsorship === 'yes' ? 'Yes' : wa.requiresSponsorship === 'no' ? 'No' : (legacy?.needsSponsorship ? 'Yes' : '')),
    line('Willing to relocate', loc.willingToRelocate === 'yes' ? 'Yes' : loc.willingToRelocate === 'no' ? 'No' : (legacy?.willingToRelocate || '')),
    line('Willing to travel (%)', pick(prefs.travelPercentage, legacy?.willingToTravelPct ? Number(legacy.willingToTravelPct) : undefined) ?? ''),
    // Compensation stays OUT of the drafted email copy (privacy). Matching
    // context may consume it via the canonical profile directly.
    pick(prefs.recruiterNote, legacy?.recruiterNote) ? `Recruiter note: ${pick(prefs.recruiterNote, legacy?.recruiterNote)}` : '',
    legacyList(pick(prefs.languages, legacy?.languages)).length ? `Languages: ${legacyList(pick(prefs.languages, legacy?.languages)).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}
