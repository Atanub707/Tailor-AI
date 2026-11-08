import { describe, it, expect } from 'vitest';
import type { ApplicantProfile, MasterCv } from '../../src/types.js';
import { validateCoverLetter, normalizeCoverLetterText, unsupportedNamedTerms } from '../../server/coverLetter/coverLetterValidation.js';

const cv: MasterCv = {
  fullName: 'Atanu Biswas',
  email: 'atanu@example.com',
  phone: '+91 90000 00000',
  location: 'Kolkata, India',
  summary: 'DevOps engineer with 7+ years experience.',
  experiences: [
    {
      id: '1',
      title: 'Senior DevSecOps Engineer',
      company: 'Human Managed',
      location: 'Bengaluru',
      dates: 'Jan 2021 - Present',
      responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'],
    },
  ],
  education: [{ id: '1', degree: 'B.Tech', institution: 'IIT', dates: '2012 - 2016' }],
  skills: [{ category: 'Infra', items: ['Kubernetes', 'AWS', 'Terraform', 'GitLab CI'] }],
  certifications: [{ id: '1', name: 'CKA' }],
};

const profile = {} as ApplicantProfile;
const facts = { company: 'FitCo', role: 'DevOps Engineer', hasRecipientName: false };

const goodLetter = `Dear Hiring Team,

I am applying for the DevOps Engineer role at FitCo. Over the past seven years I have built and operated secure cloud platforms, most recently as a Senior DevSecOps Engineer at Human Managed. In that role I reduced deployment time by 70% while running production clusters on AWS with Kubernetes and Terraform.

My work centres on reliable delivery infrastructure. I automated release pipelines with GitLab CI and moved production workloads onto managed Kubernetes, so teams ship smaller changes with less risk. Those projects required close collaboration with application and security teams, and they gave me a practical understanding of how to keep platforms fast without weakening controls.

FitCo's focus on dependable engineering matches how I work. I would welcome the chance to discuss how I can help your team improve delivery speed and platform reliability.

Sincerely,
Atanu Biswas`;

describe('cover letter validation', () => {
  it('accepts a grounded, complete letter', async () => {
    await expect(validateCoverLetter({ text: goodLetter }, facts, cv, profile)).resolves.toEqual([]);
  });

  it('rejects missing company, role, placeholder and cliché', async () => {
    const bad = goodLetter
      .replace(/at FitCo/g, 'at [Company Name]')
      .replace(/FitCo's focus/g, "the company's focus")
      .replace(/DevOps Engineer role/g, 'open role')
      .replace('My work centres', 'I am a detail-oriented team player. My work centres');
    const issues = await validateCoverLetter({ text: bad }, facts, cv, profile);
    expect(issues.join('\n')).toMatch(/placeholder/);
    expect(issues.join('\n')).toMatch(/company name/);
    expect(issues.join('\n')).toMatch(/target role/);
    expect(issues.join('\n')).toMatch(/cliché/);
  });

  it('flags unsupported numbers against the Master CV', async () => {
    const issues = await validateCoverLetter({ text: goodLetter.replace('70%', '95%') }, facts, cv, profile);
    expect(issues.join('\n')).toMatch(/unsupported number: 95%/);
  });

  it('requires the generic salutation when no recruiter name is known', async () => {
    const issues = await validateCoverLetter(
      { text: goodLetter.replace('Dear Hiring Team,', 'Dear Sarah,') },
      facts,
      cv,
      profile,
    );
    expect(issues.join('\n')).toMatch(/Dear Hiring Team/);
  });

  it('accepts a named recipient when one is known', async () => {
    const issues = await validateCoverLetter(
      { text: goodLetter.replace('Dear Hiring Team,', 'Dear Sarah,') },
      { ...facts, hasRecipientName: true },
      cv,
      profile,
    );
    expect(issues).toEqual([]);
  });

  it('rejects short letters and missing sign-off', async () => {
    const issues = await validateCoverLetter({ text: 'Dear Hiring Team,\n\nFitCo is great.\n\nSincerely,' }, facts, cv, profile);
    expect(issues.join('\n')).toMatch(/too short/);
    expect(issues.join('\n')).toMatch(/signed/);
  });

  it('normalizes dashes and quotes', () => {
    expect(normalizeCoverLetterText('I led — and won — the “project”.')).toBe('I led - and won - the "project".');
  });
});

describe('extra named-term guard', () => {
  it('flags JD technologies that are absent from the candidate record', () => {
    const terms = unsupportedNamedTerms(
      'I work daily with YAML pipelines, Gitflow branching, Azure RBAC and PRINCE2 delivery.',
      JSON.stringify(cv),
    );
    expect(terms).toEqual(expect.arrayContaining(['yaml', 'gitflow', 'prince2']));
  });

  it('accepts terms the candidate record actually contains', () => {
    expect(unsupportedNamedTerms('Kubernetes, AWS and Terraform', JSON.stringify(cv))).toEqual([]);
  });
});
