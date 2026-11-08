// Cover-letter service — one grounded generation, one validation, one retry
// with the validator's issues as feedback, then store honestly.
//
// Facts come ONLY from the Master CV + applicant profile + the already
// tailored resume stored on the job. The job description supplies the role,
// company, and terminology — never claims the candidate lacks.

import { ApplicantProfile, CoverLetter, Job, MasterCv } from '../../src/types.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';
import { getMasterCv, saveCoverLetter } from '../storage/fileStorage.js';
import { ask } from '../llm/llmAdapter.js';
import { loadConfig } from '../config.js';
import { tailoredCvToDraft } from '../tailor/tailorService.js';
import { validateCoverLetter, normalizeCoverLetterText } from './coverLetterValidation.js';

export interface GenerateCoverLetterResult {
  letter: CoverLetter;
  issues: string[];
}

/** Real person names only: postings often put a company page or "Hiring team"
 *  in recruiterName — those must fall back to the generic salutation. */
export function resolveRecipientName(job: Pick<Job, 'recruiterName'>): string | undefined {
  const name = String(job.recruiterName || '').trim();
  if (!name) return undefined;
  if (/team|recruit|hiring|talent|people|careers?|hr|inc\.?|llc|ltd|corp/i.test(name)) return undefined;
  return /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}$/.test(name) ? name : undefined;
}

function buildResumeFacts(job: Job, cv: MasterCv): Record<string, unknown> {
  if (job.tailoredCv) {
    const draft = tailoredCvToDraft(job.tailoredCv);
    return {
      summary: draft.summary,
      skills: draft.skills,
      experience: draft.experience,
      education: draft.education,
      certifications: draft.certifications,
    };
  }
  return {
    summary: cv.summary,
    skills: (cv.skills || []).flatMap((s) => s.items || []),
    experience: (cv.experiences || []).map((e) => ({
      title: e.title,
      company: e.company,
      dates: e.dates,
      highlights: e.responsibilities || [],
    })),
    education: (cv.education || []).map((e) => ({ degree: e.degree, institution: e.institution, dates: e.dates })),
    certifications: (cv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '')),
  };
}

function buildPrompt(
  job: Job,
  cv: MasterCv,
  profile: ApplicantProfile,
  recipientName: string | undefined,
  previousIssues: string[],
): string {
  const facts = {
    candidateName: cv.fullName,
    contact: {
      email: cv.email,
      phone: cv.phone,
      location: cv.location,
      linkedin: cv.linkedin,
    },
    workAuthorization: profile.workAuthorization || undefined,
    resume: buildResumeFacts(job, cv),
  };
  const salutation = recipientName ? `Dear ${recipientName},` : 'Dear Hiring Team,';
  const feedback = previousIssues.length
    ? `\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS — fix every one:\n${previousIssues.map((i) => `- ${i}`).join('\n')}\n`
    : '';

  return `You are writing a professional cover letter for a real job application. The candidate will submit it as-is.

## CANDIDATE FACTS (the ONLY source of truth)
${JSON.stringify(facts, null, 2)}

## JOB
Title: ${job.title}
Company: ${job.company}${job.location ? `\nLocation: ${job.location}` : ''}
Job description:
${(job.description || '').slice(0, 6000)}

## RULES
- Write in English. Professional, specific, confident, and concise: 220-320 words, 3-4 paragraphs.
- Mention the company by its FULL name exactly as given (${job.company}) at least once - never abbreviate it to initials.
- Start exactly with: "${salutation}"
- Paragraph 1: the role at ${job.company} and the single strongest, most relevant fact about the candidate.
- Paragraph 2: 1-2 concrete achievements from the resume facts with their real metrics, tied to this job's needs.
- Paragraph 3: the specific skills/experience that match this job, using the job's own terminology where the candidate genuinely has that skill.
- Final paragraph: brief interest in the team/company and a call to action.
- End with "Sincerely," on its own line, then the candidate's full name.
- Use ONLY facts, skills, employers, dates, and numbers present in the candidate facts. Never invent a metric, employer, degree, certification, or skill.
- The job description is what the EMPLOYER wants, not evidence about the candidate. Never list the job's requirements as the candidate's experience, and never name a job requirement as a skill unless it also appears in the candidate facts.
- Never mention any product or technology whose name contains a number (for example "Office 365") unless that exact product appears in the candidate facts. Never write any number that is absent from the facts.
- Use plain action verbs: built, led, implemented, ran, delivered. Never use "architected", "spearheaded", or "orchestrated" — they read as unverified claims.
- Do not make commitments or claims that are not in the facts (for example security clearance, visa sponsorship, willingness to relocate).
- Do not use the standalone generic words "testing", "networking", "evaluation", "sales" or "tax" unless they appear verbatim in the facts; name the specific tools and activities from the facts instead.
- No placeholders, brackets, or fill-in-the-blank text.
- No clichés: no "I am writing to express my interest", "team player", "detail-oriented", "results-driven", "passionate professional", "proven track record", or similar.
- No em dashes or en dashes; use periods or commas.
${feedback}
## OUTPUT
Return ONLY valid JSON: {"text": "the complete letter with \\n\\n between paragraphs"}`;
}

function parseText(raw: string): string {
  const trimmed = String(raw || '').trim();
  try {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(trimmed.slice(start, end + 1));
      if (typeof obj?.text === 'string') return obj.text;
    }
  } catch { /* fall through to raw */ }
  return trimmed;
}

export async function generateCoverLetterForJob(
  job: Job,
  opts: { force?: boolean } = {},
): Promise<GenerateCoverLetterResult> {
  if (!opts.force && job.coverLetter?.text && job.coverLetter.verified) {
    return { letter: job.coverLetter, issues: [] };
  }

  const cv = getMasterCv();
  const profile = getApplicantProfile();
  const recipientName = resolveRecipientName(job);
  const facts = {
    company: job.company || '',
    role: job.title || '',
    hasRecipientName: Boolean(recipientName),
  };
  const config = loadConfig();

  let issues: string[] = [];
  let text = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask(buildPrompt(job, cv, profile, recipientName, issueFeedback(attempt, issues)), 0.2);
    const candidate = normalizeCoverLetterText(parseText(raw));
    if (!candidate) {
      issues = ['Cover letter is empty.'];
      continue;
    }
    text = candidate;
    issues = await validateCoverLetter({ text: candidate }, facts, cv, profile);
    if (issues.length === 0) break;
  }

  const letter: CoverLetter = {
    text,
    verified: issues.length === 0,
    generatedAt: new Date().toISOString(),
    model: config.llm.model,
    tailoredCvHash: job.tailoredCv ? hashTailored(job) : undefined,
    issues: issues.length ? issues : undefined,
  };
  saveCoverLetter(job.id, letter);
  return { letter, issues };
}

function issueFeedback(attempt: number, issues: string[]): string[] {
  return attempt === 0 ? [] : issues;
}

function hashTailored(job: Job): string | undefined {
  try {
    // Cheap stable identity for "which tailored CV this letter was written from".
    const s = JSON.stringify(job.tailoredCv || {});
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `tlr_${(h >>> 0).toString(16)}`;
  } catch {
    return undefined;
  }
}
