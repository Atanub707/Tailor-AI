// Tailor V2 Engine — grounded tailoring pipeline.
//
// Master CV + Applicant Profile + Job + JD + deterministic FitResult
//   → Candidate Fact Ledger (deterministic)
//   → LLM Drafter (structured, non-fabrication rules)
//   → Deterministic Verifier (mandatory)
//   → Bounded repair (MAX 2 attempts; deterministic cleanup; FAIL CLOSED)
//   → Keyword coverage + versioning
//   → PDF + text-layer verification
//
// TAILORING MAY REWRITE, REORDER, CONDENSE, EMPHASIZE AND SELECT.
// TAILORING MUST NOT INVENT.

import type { MasterCv, ApplicantProfile, Job, TailoredCv } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import { parseJobRequirements } from '../fit/requirementsParser.js';
import { draftResume, parseDraftJson, type TailorDraft } from './drafter.js';
import { verifyDraft, type TailorVerification } from './verifier.js';
import { buildCandidateFactLedger } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';
import { storeTailorVersion, markTailorVersionsStale, getLatestTailorVersion } from './versionStore.js';
import { generatePdfBuffer } from '../builder/docxGenerator.js';
import { verifyPdfTextLayer } from './pdfText.js';

export const MAX_GENERATION_ATTEMPTS = 2;

export class TailorVerificationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TailorVerificationFailedError';
  }
}

export function jdSkillTerms(jd: string): string[] {
  const reqs = parseJobRequirements(jd, {});
  return [...new Set([...reqs.requiredSkills, ...reqs.preferredSkills])];
}

/** Deterministic cleanup: drop claims the ledger does not support. */
async function deterministicRepair(draft: TailorDraft, cv: MasterCv, profile: ApplicantProfile): Promise<TailorDraft> {
  const ledger = buildCandidateFactLedger(cv, profile);
  const supported = (s: string) => ledger.explicitSkills.some((x) => skillCovered(s, [x]).covered) || ledger.technologies.some((x) => skillCovered(s, [x]).covered);
  const cleaned: TailorDraft = {
    ...draft,
    summary: await repairSummary(draft.summary || '', supported),
    skills: (draft.skills || []).filter(supported),
    certifications: (draft.certifications || []).filter((c) => ledger.certifications.some((lc) => lc.includes(c.toLowerCase()) || c.toLowerCase().includes(lc))),
  };
  return cleaned;
}

/** Remove unsupported skill terms from free text (minimal, safe repair). */
async function repairSummary(summary: string, supported: (s: string) => boolean): Promise<string> {
  const { SKILL_TERMS } = await import('../fit/requirementsParser.js');
  let out = String(summary || '');
  for (const term of SKILL_TERMS) {
    if (supported(term)) continue;
    out = out.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

export interface TailorV2Result {
  version: number;
  draft: TailorDraft;
  verification: TailorVerification;
  jdTerms: string[];
  pdfOk: boolean;
  pdfCheck: { ok: boolean; missing: string[]; textLength: number };
}

export async function runTailorV2(
  userId: string,
  cv: MasterCv,
  profile: ApplicantProfile,
  job: Job,
  jd: string,
  fit: FitResult,
  keys: { masterCvUpdatedAt?: string; profileUpdatedAt?: string; jdHash: string; fitEngineVersion?: number },
  llmDraft: (cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult, violations?: string[]) => Promise<TailorDraft> = defaultLlmDraft
): Promise<TailorV2Result> {
  const terms = jdSkillTerms(jd);

  let draft: TailorDraft | undefined;
  let verification: TailorVerification | undefined;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const violations = verification && verification.issues.length ? verification.issues.map((i) => `${i.type}: ${i.claim}`).slice(0, 12) : undefined;
    draft = await llmDraft(cv, profile, job, jd, fit, violations);
    verification = await verifyDraft(toVerifierDraft(draft), cv, profile, terms);
    if (verification.passed) break;
  }

  if (!verification || !draft) throw new TailorVerificationFailedError('Tailoring failed factual verification.');
  if (!verification.passed) {
    // Deterministic cleanup pass — drop unsupported additive claims.
    const cleaned = await deterministicRepair(draft, cv, profile);
    const recheck = await verifyDraft(toVerifierDraft(cleaned), cv, profile, terms);
    if (!recheck.passed) {
      const history = recheck.issues.filter((i) => ['employer', 'title', 'dates', 'education'].includes(i.type));
      if (history.length) {
        // History claims can never be repaired by deletion → FAIL CLOSED.
        throw new TailorVerificationFailedError('Tailoring failed factual verification: unsupported employment/education claims remain.');
      }
      verification = recheck;
      draft = cleaned;
    } else {
      verification = recheck;
      draft = cleaned;
    }
  }

  // Persist version (v1+; mark older versions stale when inputs change).
  const latest = getLatestTailorVersion(userId, job.id);
  if (latest) {
    const inputChanged =
      latest.masterCvUpdatedAt !== keys.masterCvUpdatedAt ||
      latest.profileUpdatedAt !== keys.profileUpdatedAt ||
      latest.jdHash !== keys.jdHash;
    if (inputChanged) markTailorVersionsStale(userId, job.id, undefined);
  }
  const stored = storeTailorVersion(userId, job.id, draft, verification, keys);

  // PDF + text-layer verification (deterministic).
  const tailCv = toTailoredCv(draft, cv.fullName || '');
  let pdfCheck: { ok: boolean; missing: string[]; textLength: number };
  let pdfOk = false;
  {
    const buf = await generatePdfBuffer(tailCv).catch((err: any) => {
      throw new Error(`PDF generation failed: ${String(err?.message || err).slice(0, 200)}`);
    });
    const recent = draft.experience?.[0];
    pdfCheck = await verifyPdfTextLayer(buf, draft, { employer: recent?.company, title: recent?.title }, cv.fullName || profile.personal?.firstName || '');
    if (!pdfCheck.ok) throw new TailorVerificationFailedError(`PDF text-layer verification failed: ${pdfCheck.missing.join(', ')}`);
    pdfOk = true;
  }

  return { version: stored.version, draft, verification, jdTerms: terms, pdfOk, pdfCheck };
}

async function defaultLlmDraft(cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult, violations?: string[]): Promise<TailorDraft> {
  const raw = await (await import('./drafter.js')).askForDraft(cv, profile, job, jd, fit, violations);
  return parseDraftJson(raw);
}

/** Map a TailorDraft into the verifier/TailoredCv-compatible shape. */
export function toVerifierDraft(draft: TailorDraft): { professionalSummary: string; coreCompetencies: string[]; workExperience: TailorDraft['experience']; education: TailorDraft['education']; technicalSkills: Array<{ category: string; skills: string[] }>; certifications: string[] } {
  return {
    professionalSummary: draft.summary || '',
    coreCompetencies: draft.skills || [],
    workExperience: draft.experience || [],
    education: draft.education || [],
    technicalSkills: draft.skills?.length ? [{ category: 'Skills', skills: draft.skills }] : [],
    certifications: draft.certifications || [],
  };
}

export function toTailoredCv(draft: TailorDraft, fullName: string): TailoredCv {
  return {
    candidateName: fullName,
    targetRole: draft.experience?.[0]?.title || '',
    professionalSummary: draft.summary || '',
    coreCompetencies: draft.skills || [],
    workExperience: (draft.experience || []).map((w) => ({
      title: w.title || '',
      company: w.company || '',
      location: w.location || '',
      dates: w.dates || '',
      highlights: w.highlights || [],
    })),
    education: (draft.education || []).map((e) => ({
      degree: e.degree || '',
      institution: e.institution || '',
      dates: e.dates || '',
      details: e.details || '',
    })),
    technicalSkills: draft.skills?.length ? [{ category: 'Skills', skills: draft.skills }] : [],
    certifications: draft.certifications || [],
    projects: draft.projects || [],
  } as unknown as TailoredCv;
}