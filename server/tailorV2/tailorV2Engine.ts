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
import { parseEnhancementAnnotations, stripEnhancementAnnotations, type EnhancementLedger } from './enhancementLedger.js';
import { buildCandidateFactLedger } from './candidateLedger.js';
import { skillCovered } from '../fit/skillAliases.js';
import { storeTailorVersion, markTailorVersionsStale, getLatestTailorVersion } from './versionStore.js';
import { generatePdfBuffer } from '../builder/docxGenerator.js';
import { verifyPdfTextLayer } from './pdfText.js';

export const MAX_GENERATION_ATTEMPTS = 2;

// Task 2: verifyDraft gained an opts param (mode + enhancementLedger). The
// engine call sites stay strict-mode (4 args) until Task 4 plumbs the mode;
// this re-export gives the mode plumbing a stable type surface.
export type { EnhancementLedger };

/** Ratio of draft highlights that are byte-identical to the source
 *  responsibility at the same position (verbatim copies = not tailored). */
export function verbatimBulletRatio(draft: TailorDraft, cv: MasterCv): number {
  const srcByCompany = new Map<string, string[]>();
  for (const e of cv.experiences || []) {
    const key = String(e.company || '').toLowerCase().trim();
    srcByCompany.set(key, (e.responsibilities || []).map((r) => String(r || '').trim()));
  }
  let total = 0, verbatim = 0;
  for (const w of draft.experience || []) {
    const src = srcByCompany.get(String(w.company || '').toLowerCase().trim()) || [];
    (w.highlights || []).forEach((h, i) => {
      total++;
      if (src[i] && String(h || '').trim() === src[i]) verbatim++;
    });
  }
  return total === 0 ? 0 : verbatim / total;
}

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
    // Projects are additive sections: an invented project is DROPPED (never
    // auto-rewritten). Bullet-level achievements are NOT repairable here —
    // they fail closed in the engine.
    projects: (draft.projects || []).filter((p) => {
      const name = String(p?.name || '').toLowerCase().trim();
      return !!name && (ledger.projects.some((lp) => lp.includes(name) || name.includes(lp)) || JSON.stringify({ cv, profile }).toLowerCase().includes(name));
    }),
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
  enhancementLedger?: EnhancementLedger;
}

export async function runTailorV2(
  userId: string,
  cv: MasterCv,
  profile: ApplicantProfile,
  job: Job,
  jd: string,
  fit: FitResult,
  keys: { masterCvUpdatedAt?: string; profileUpdatedAt?: string; jdHash: string; fitEngineVersion?: number },
  llmDraft?: (cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult, violations?: string[]) => Promise<TailorDraft>,
  opts: { mode?: 'strict' | 'enhanced' } = {}
): Promise<TailorV2Result> {
  const mode = opts.mode ?? 'strict';
  const terms = jdSkillTerms(jd);
  const llm = llmDraft ?? ((cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult, violations?: string[]) => defaultLlmDraft(cv, profile, job, jd, fit, violations, mode));

  let draft: TailorDraft | undefined;
  let verification: TailorVerification | undefined;
  let verbatimNote: string | undefined;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const violations = verification && verification.issues.length ? verification.issues.map((i) => `${i.type}: ${i.claim}`).slice(0, 12) : undefined;
    const retryNotes = [...(violations || []), ...(verbatimNote ? [verbatimNote] : [])];
    verbatimNote = undefined;
    draft = await llm(cv, profile, job, jd, fit, retryNotes.length ? retryNotes : undefined);
    verification = await verifyDraft(toVerifierDraft(draft), cv, profile, terms, { mode, enhancementLedger: { entries: parseEnhancementAnnotations(draft) } });
    if (!verification.passed) continue;
    // If the draft passed fact verification but copied source bullets
    // verbatim, it was NOT tailored — demand a rewrite on the next attempt.
    const ratio = verbatimBulletRatio(draft, cv);
    if (ratio > 0.5 && attempt + 1 < MAX_GENERATION_ATTEMPTS) {
      verbatimNote = `REWRITE REQUIRED: ${Math.round(ratio * 100)}% of your experience bullets are byte-identical copies of the source. Rephrase EVERY bullet in fresh, job-specific wording (same facts, new wording).`;
      continue;
    }
    break;
  }

  if (!verification || !draft) throw new TailorVerificationFailedError('Tailoring failed factual verification.');
  if (!verification.passed) {
    // Deterministic cleanup pass — drop unsupported additive claims.
    const cleaned = await deterministicRepair(draft, cv, profile);
    const recheck = await verifyDraft(toVerifierDraft(cleaned), cv, profile, terms, { mode, enhancementLedger: { entries: parseEnhancementAnnotations(cleaned) } });
    if (!recheck.passed) {
      // FAIL CLOSED: any remaining error-severity violation means the resume
      // is not grounded in the candidate's facts. It is never persisted or
      // published. No fallback to any other tailoring engine.
      const summary = recheck.issues.slice(0, 5).map((i) => `${i.type}: ${i.claim}`).join('; ');
      throw new TailorVerificationFailedError(`Tailoring failed factual verification after cleanup: ${summary}`);
    }
    verification = recheck;
    draft = cleaned;
  }

  // Accepted draft: capture the enhancement ledger from the UNSTRIPPED draft
  // (it carries the claims for the UI), then strip the annotation suffixes
  // before anything is persisted or rendered.
  const enhancementLedger: EnhancementLedger | undefined = mode === 'enhanced'
    ? { entries: parseEnhancementAnnotations(draft) }
    : undefined;
  if (enhancementLedger) verification = { ...verification, enhancementLedger };
  draft = stripEnhancementAnnotations(draft);

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

  return { version: stored.version, draft, verification, jdTerms: terms, pdfOk, pdfCheck, enhancementLedger };
}

async function defaultLlmDraft(cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult, violations?: string[], mode: 'strict' | 'enhanced' = 'strict'): Promise<TailorDraft> {
  const raw = await (await import('./drafter.js')).askForDraft(cv, profile, job, jd, fit, violations, mode);
  return parseDraftJson(raw);
}

/** Map a TailorDraft into the verifier/TailoredCv-compatible shape. */
export function toVerifierDraft(draft: TailorDraft): { professionalSummary: string; coreCompetencies: string[]; workExperience: TailorDraft['experience']; education: TailorDraft['education']; technicalSkills: Array<{ category: string; skills: string[] }>; certifications: string[]; projects?: Array<{ name?: string; description?: string }> } {
  return {
    professionalSummary: draft.summary || '',
    coreCompetencies: draft.skills || [],
    workExperience: draft.experience || [],
    education: draft.education || [],
    technicalSkills: draft.skills?.length ? [{ category: 'Skills', skills: draft.skills }] : [],
    certifications: draft.certifications || [],
    projects: draft.projects || [],
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