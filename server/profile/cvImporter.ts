// Master CV → Applicant Profile import.
//
// DETERMINISTIC mapping (the Master CV is already structured JSON — no LLM
// needed). The source CV is treated as DATA; nothing here executes content.
// Overwrite protection: only fields that are currently empty/unset get
// filled — an existing populated profile is never silently replaced.

import type { MasterCv } from '../../src/types.js';
import type { ApplicantProfile, ProfileExperience, ProfileEducation, ProfileSkill, ProfileCertification } from '../../src/types.js';
import { parseCvDate, isCvDateCurrent } from '../storage/applicantProfile.js';

function splitFullName(name: string): { firstName?: string; middleName?: string; lastName?: string } {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined, lastName: parts[parts.length - 1] };
}

function fill<T>(target: T | undefined, value: T | undefined): T | undefined {
  return target === undefined || target === null || target === '' ? value : target;
}

export function importMasterCvIntoProfile(profile: ApplicantProfile, cv: MasterCv): ApplicantProfile {
  const out: ApplicantProfile = JSON.parse(JSON.stringify(profile));
  const name = splitFullName(cv.fullName || '');
  out.personal = {
    ...out.personal,
    firstName: fill(out.personal.firstName, name.firstName),
    middleName: fill(out.personal.middleName, name.middleName),
    lastName: fill(out.personal.lastName, name.lastName),
    email: fill(out.personal.email, cv.email || undefined),
    phone: fill(out.personal.phone, cv.phone || undefined),
  };
  out.contact = {
    ...out.contact,
    city: fill(out.contact.city, cv.location ? cv.location.split(',')[0].trim() : undefined),
    country: fill(out.contact.country, cv.location && cv.location.includes(',') ? cv.location.split(',').slice(-1)[0].trim() : undefined),
  };
  out.links = {
    ...out.links,
    linkedin: fill(out.links.linkedin, cv.linkedin || undefined),
    github: fill(out.links.github, cv.github || undefined),
    website: fill(out.links.website, cv.website || undefined),
  };

  // Experience: preserve user wording — raw date string is kept in summary
  // context via parsed dates only; unparseable ranges stay null (never
  // invented).
  const existingExp = new Set(out.experience.map((e) => `${e.company}|${e.title}`));
  for (const x of cv.experiences || []) {
    if (existingExp.has(`${x.company}|${x.title}`)) continue;
    const entry: ProfileExperience = {
      company: x.company,
      title: x.title,
      location: x.location || undefined,
      startDate: parseCvDate(x.dates) || undefined,
      endDate: isCvDateCurrent(x.dates) ? undefined : parseCvDate(x.dates?.split(/[-–—]/)[1]) || undefined,
      isCurrent: isCvDateCurrent(x.dates) || undefined,
      achievements: x.responsibilities?.length ? x.responsibilities : undefined,
      source: 'master_cv',
    };
    out.experience.push(entry);
  }

  const existingEdu = new Set(out.education.map((e) => `${e.institution}|${e.degree}`));
  for (const e of cv.education || []) {
    if (existingEdu.has(`${e.institution}|${e.degree}`)) continue;
    const entry: ProfileEducation = {
      institution: e.institution,
      degree: e.degree || undefined,
      startDate: parseCvDate(e.dates) || undefined,
      endDate: isCvDateCurrent(e.dates) ? undefined : parseCvDate(e.dates?.split(/[-–—]/)[1]) || undefined,
      description: e.details || undefined,
    };
    out.education.push(entry);
  }

  const existingSkill = new Set(out.skills.map((s) => s.name.toLowerCase()));
  for (const group of cv.skills || []) {
    for (const item of group.items || []) {
      const key = String(item).toLowerCase();
      if (existingSkill.has(key)) continue;
      const skill: ProfileSkill = { name: item, category: group.category || undefined, source: 'master_cv' };
      out.skills.push(skill);
      existingSkill.add(key);
    }
  }

  const existingCert = new Set(out.certifications.map((c) => c.name.toLowerCase()));
  for (const c of cv.certifications || []) {
    const key = String(c.name || '').toLowerCase();
    if (!key || existingCert.has(key)) continue;
    const cert: ProfileCertification = { name: c.name };
    out.certifications.push(cert);
    existingCert.add(key);
  }

  return out;
}