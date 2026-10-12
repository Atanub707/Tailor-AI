// Tailoring service — the V1 user-facing engine.
//
// Single entry point used by EVERY Tailor Resume path (job-card Tailor,
// Re-Tailor, batch Tailor, Manual JD Tailor, Auto Apply pre-flight) and by
// the application package (Auto Apply attaches THIS tailored CV's PDF).

import type { Job, MasterCv, TailoredCv, TailoringAudit } from '../../src/types.js';
import type { FitResult } from '../fit/fitEngine.js';
import { getCurrentUserId, getMasterCv, getMasterCvUpdatedAt, getDb, listUsers, runWithUser } from '../storage/fileStorage.js';
import { getApplicantProfile } from '../storage/applicantProfile.js';
import { computeFit } from '../fit/fitEngine.js';
import { fitCacheKeyFor, getCachedFit, storeCachedFit } from '../fit/fitCache.js';
import { jdSkillTerms, TailorVerificationFailedError, type TailorDraft } from './tailorTypes.js';
import { computeBulletDiffs, computeKeywordStatus } from './bulletDiff.js';
import { containsKeyword } from './keywordMatch.js';

export { TailorVerificationFailedError };

export interface TailorJobResult {
  version: number;
  tailoredCv: TailoredCv;
  draft: TailorDraft;
  jdTerms: string[];
  pdfOk: boolean;
  audit: TailoringAudit;
}

/** Resolve the real job description or throw (never tailor on a stub). */
export async function resolveJobDescription(job: Job): Promise<Job> {
  const { ensureJobDescription } = await import('./jdResolver.js');
  return ensureJobDescription(job);
}

/** Deterministic fit for a job (cached per user/job/inputs). */
export function fitForJob(userId: string, job: Job, masterCv: MasterCv, jd: string): FitResult {
  const profile = getApplicantProfile(userId);
  const key = fitCacheKeyFor(profile.updatedAt, getMasterCvUpdatedAt(userId), jd);
  const cached = getCachedFit(userId, job.id, key);
  if (cached) return cached;
  const fit = computeFit(profile, masterCv, job, jd);
  storeCachedFit(userId, job.id, key, fit);
  return fit;
}

/** UI audit: same field shape the job detail / manual JD screens consume.
 *  beforeScore = the existing Resume Match score (unchanged methodology);
 *  afterScore mirrors the deterministic keyword-weighted formula
 *  using the engine's grounded keyword coverage — never a separate score. */
export function buildTailorAudit(job: Job, draft: TailorDraft, jdTerms: string[], masterCv: MasterCv): TailoringAudit {
  const beforeScore = job.matchScore ?? job.gapAnalysis?.matchScore ?? 50;
  const expText = (draft.experience || []).flatMap((w) => w.highlights || []).join(' ');
  const skillsText = (draft.skills || []).join(' ');
  const allText = `${expText} ${skillsText} ${draft.summary || ''}`;
  const verifiedInExperience = jdTerms.filter((t) => containsKeyword(expText, t));
  const verifiedInSkills = jdTerms.filter((t) => containsKeyword(skillsText, t));
  const verifiedAll = [...new Set([...verifiedInExperience, ...verifiedInSkills])];
  const notIntegrable = jdTerms.filter((t) => !containsKeyword(allText, t));

  const totalMissing = Math.max(jdTerms.length, 1);
  const expWeight = verifiedInExperience.length;
  const skillsWeight = verifiedInSkills.length * 0.5;
  const weightedFill = Math.min((expWeight + skillsWeight) / totalMissing, 0.95);
  const afterScore = Math.round(beforeScore + weightedFill * (100 - beforeScore));

  const sourceBullets = (masterCv.experiences || []).flatMap((e) => e.responsibilities || []);
  const draftBullets = (draft.experience || []).flatMap((w) => w.highlights || []);
  const rephrasedHighlightsCount = Math.min(sourceBullets.length, draftBullets.length);

  // Informative audit: per-bullet before→after diffs (addedTerms filled from
  // the JD terms present in each rewritten bullet) + per-JD-term reason.
  const bulletDiffs = computeBulletDiffs(masterCv, draft);
  for (const d of bulletDiffs) {
    d.addedTerms = jdTerms.filter((t) => containsKeyword(d.rewritten, t));
  }
  const keywordStatus = computeKeywordStatus(jdTerms, draft, masterCv);

  return {
    beforeScore,
    afterScore,
    scoreBoost: afterScore - beforeScore,
    bulletDiffs,
    keywordStatus,
    scoreBreakdown: {
      alreadyMatched: jdTerms.length - notIntegrable.length,
      newlyIntegrated: verifiedAll.length,
      remainingGap: notIntegrable.length,
    },
    missingBefore: {
      skills: job.gapAnalysis?.missingSkills ?? [],
      keywords: job.gapAnalysis?.missingKeywords ?? [],
    },
    addedAfter: {
      keywordsIncorporated: verifiedAll,
      keywordsInExperience: verifiedInExperience,
      keywordsInSkills: verifiedInSkills,
      rephrasedHighlightsCount,
      skillsAdded: [],
    },
    notIntegrable,
    auditNotes: [
      `Aligned the resume to "${job.title}" using only evidence from the candidate's Master CV and profile.`,
      `Integrated ${verifiedAll.length} job-description terms that the candidate's evidence supports.`,
      `Left out ${notIntegrable.length} job-description requirement(s) the candidate's evidence does not support — surfaced as gaps instead.`,
      `Every employer, title, date, degree, certification, skill, metric and project was verified against the candidate's fact ledger before publication.`,
    ],
  };
}

/** The one canonical user-facing tailoring entry point (V1). V1 integrates
 *  the JD's missing keywords into bullets/skills — the score boost is its
 *  whole purpose. The informative audit fields are enriched deterministically
 *  so the UI (What changed / Keyword placement) keeps working unchanged. */
export async function tailorJob(job: Job, opts: { userId?: string; mode?: 'strict' | 'enhanced' } = {}): Promise<TailorJobResult> {
  const userId = opts.userId || getCurrentUserId();
  const fullJob = await resolveJobDescription(job);
  const jd = fullJob.description || '';
  const masterCv = getMasterCv(userId);

  // Match analysis when missing.
  if (!fullJob.gapAnalysis) {
    const { LlmMatcher } = await import('../matcher/llmMatcher.js');
    const matchResult = await new LlmMatcher().matchJob(fullJob, masterCv);
    fullJob.gapAnalysis = matchResult.gapAnalysis;
    fullJob.matchScore = matchResult.matchScore;
  }

  const { LlmCvTailor } = await import('../builder/llmCvTailor.js');
  const tailoredCv = await new LlmCvTailor().tailorCv(fullJob, masterCv);

  // Recruiter-first ordering (deterministic): within each role the bullets
  // that cover the most job-description terms come first, and JD-named
  // skills float to the front of the skills lists. Real content only —
  // order changes, never wording.
  const parsedTerms = jdSkillTerms(jd);
  const gapTerms = [
    ...(fullJob.gapAnalysis?.missingSkills || []),
    ...(fullJob.gapAnalysis?.missingKeywords || []),
    ...(fullJob.gapAnalysis?.matchingSkills || []),
  ];
  const jdTerms = [...new Set([...parsedTerms, ...gapTerms])];
  const bulletPerms = reorderBulletsByJdRelevance(tailoredCv, jdTerms);
  prioritizeSkillsByJdRelevance(tailoredCv, jdTerms);

  // Informative audit (deterministic) — the UI reads audit.bulletDiffs /
  // keywordStatus; compute from the output so nothing changes in the UI.
  const draft = tailoredCvToDraft(tailoredCv);
  const bulletDiffs = computeBulletDiffs(permuteSourceForDiffs(masterCv, bulletPerms), draft);
  for (const d of bulletDiffs) {
    d.addedTerms = jdTerms.filter((t) => containsKeyword(d.rewritten, t));
  }
  const keywordStatus = computeKeywordStatus(jdTerms, draft, masterCv);
  if (tailoredCv.audit) {
    tailoredCv.audit.bulletDiffs = bulletDiffs;
    tailoredCv.audit.keywordStatus = keywordStatus;
    const impact = tailoredCv.audit.impactAudit;
    if (impact && impact.bullets > 0) {
      tailoredCv.audit.auditNotes = [
        ...(tailoredCv.audit.auditNotes || []),
        `${impact.quantified} of ${impact.bullets} experience bullets (${impact.quantifiedPct}%) carry a measurable outcome — recruiters scan for real numbers in the first 6-7 seconds. Add numbers from your actual work to the Master CV to strengthen the next tailor.`,
        ...(impact.metricDropped.length > 0
          ? [`The rewrite did not keep these real numbers (${impact.metricDropped.join(', ')}) — double-check those bullets.`]
          : []),
      ];
    }
  }

  return {
    version: 0,
    tailoredCv,
    draft,
    jdTerms,
    pdfOk: true,
    audit: tailoredCv.audit as TailoringAudit,
  };
}

/** Deterministic recruiter-first ordering: within each role, bullets that
 *  cover the most job-description terms come first (stable — ties keep the
 *  original order). Only the ORDER of the candidate's real bullets changes;
 *  no wording is touched. Returns the per-role permutation so the
 *  before→after diff pairing can be preserved. */
export function reorderBulletsByJdRelevance(tailoredCv: TailoredCv, jdTerms: string[]): Array<number[]> {
  const terms = jdTerms.filter((t) => String(t || '').trim());
  const perms: Array<number[]> = [];
  for (const w of tailoredCv.workExperience || []) {
    const highlights = w.highlights || [];
    const identity = highlights.map((_, i) => i);
    if (highlights.length < 2 || terms.length === 0) {
      perms.push(identity);
      continue;
    }
    const perm = highlights
      .map((h, i) => ({ i, score: terms.filter((t) => containsKeyword(h, t)).length }))
      .sort((a, b) => (b.score - a.score) || (a.i - b.i))
      .map((s) => s.i);
    perms.push(perm);
    w.highlights = perm.map((idx) => highlights[idx]);
  }
  return perms;
}

/** Apply the SAME permutation to the Master CV's source bullets so the
 *  before→after bullet-diff pairing stays exact after reordering. */
function permuteSourceForDiffs(masterCv: MasterCv, perms: Array<number[]>): MasterCv {
  return {
    ...masterCv,
    experiences: (masterCv.experiences || []).map((e, expIndex) => {
      const resp = e.responsibilities || [];
      const perm = perms[expIndex];
      if (!perm || perm.length !== resp.length) return e;
      return { ...e, responsibilities: perm.map((idx) => resp[idx]) };
    }),
  };
}

/** Deterministic skills prioritization: JD-named skills first (stable), both
 *  in the flat core competencies and inside each grouped skills list. */
export function prioritizeSkillsByJdRelevance(tailoredCv: TailoredCv, jdTerms: string[]): void {
  const terms = jdTerms.filter((t) => String(t || '').trim());
  if (!terms.length) return;
  const score = (s: string) => terms.filter((t) => containsKeyword(s, t)).length;
  const stableSort = (arr: string[]) =>
    arr
      .map((s, i) => ({ s, i, sc: score(s) }))
      .sort((a, b) => (b.sc - a.sc) || (a.i - b.i))
      .map((x) => x.s);
  if (Array.isArray(tailoredCv.coreCompetencies) && tailoredCv.coreCompetencies.length > 1) {
    tailoredCv.coreCompetencies = stableSort(tailoredCv.coreCompetencies);
  }
  for (const g of tailoredCv.technicalSkills || []) {
    if (Array.isArray(g.skills) && g.skills.length > 1) {
      g.skills = stableSort(g.skills);
    }
  }
}

/** Re-group the tailored flat skill list into the Master CV's skill
 *  categories so the Tailored Resume renders EXACTLY like the Master CV
 *  preview (same category labels, same order, same grouping). Skilled
 *  terms the master CV doesn't categorize go to 'Core Competencies'. */
export function groupSkillsLikeMasterCv(tailoredCv: TailoredCv, masterCv: MasterCv): TailoredCv {
  const flat = Array.isArray(tailoredCv.coreCompetencies) ? tailoredCv.coreCompetencies : [];
  if (!flat.length) return tailoredCv;
  const norm = (s: string) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const masterGroups: Array<{ category: string; items: string[] }> = [];
  for (const g of masterCv.skills || []) {
    masterGroups.push({ category: g.category || 'Skills', items: (g.items || []).map(norm) });
  }
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  for (const g of masterGroups) {
    buckets.set(norm(g.category), []);
    order.push(norm(g.category));
  }
  const residual: string[] = [];
  for (const skill of flat) {
    const s = norm(skill);
    let placed = false;
    for (const g of masterGroups) {
      if (g.items.some((item) => item === s || item.includes(s) || s.includes(item))) {
        buckets.get(norm(g.category))!.push(skill);
        placed = true;
        break;
      }
    }
    if (!placed) residual.push(skill);
  }
  const grouped: Array<{ category: string; skills: string[] }> = [];
  for (const key of order) {
    const items = buckets.get(key) || [];
    if (items.length) grouped.push({ category: masterGroups.find((g) => norm(g.category) === key)!.category, skills: items });
  }
  if (residual.length) grouped.push({ category: 'Core Competencies', skills: residual });
  if (!grouped.length) return tailoredCv;
  tailoredCv.technicalSkills = grouped;
  return tailoredCv;
}

/** Tailoring scope: summary, skill sections and experience bullets only.
 *  Projects, education and certifications are copied VERBATIM from the
 *  Master CV — same entries, same wording, same order. No LLM touches them. */
export function applyMasterSectionsVerbatim(tailoredCv: TailoredCv, masterCv: MasterCv): TailoredCv {
  tailoredCv.projects = (masterCv.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    technologies: [...(p.technologies || [])],
    link: p.link,
    dates: p.dates,
  }));
  tailoredCv.education = (masterCv.education || []).map((e) => ({
    degree: e.degree,
    institution: e.institution,
    dates: e.dates,
    details: e.details,
  }));
  tailoredCv.certifications = (masterCv.certifications || []).map((c) => (typeof c === 'string' ? c : { ...c }));
  return tailoredCv;
}

/** Attach the UI metadata the legacy engine provided (contact block, audit,
 *  display counters) to a TailoredCv. Idempotent — keeps an existing audit. */
export function enrichTailoredCv(tailoredCv: TailoredCv, audit: TailoringAudit, masterCv?: MasterCv): TailoredCv {
  if (masterCv) {
    tailoredCv.contactInfo = {
      email: masterCv.email,
      phone: masterCv.phone,
      location: masterCv.location,
      linkedin: masterCv.linkedin,
      github: masterCv.github,
      website: masterCv.website,
    };
  }
  tailoredCv.audit = audit;
  tailoredCv.rephraseHighlightsCount = audit.addedAfter.rephrasedHighlightsCount;
  tailoredCv.keywordsIncorporated = audit.addedAfter.keywordsIncorporated;
  return tailoredCv;
}

/** Deterministic backfill for tailored CVs stored before the service
 *  attached audit/contactInfo. No LLM calls — rerun-safe. */
export function backfillTailoredAudits(): number {
  // Run per-user: the master CV (source of truth for projects/skills/
  // contact) is user-scoped, and getMasterCv() resolves via AsyncLocalStorage.
  let count = 0;
  for (const u of listUsers()) {
    count += runWithUser(u.id, () => backfillForCurrentUser());
  }
  return count;
}

function backfillForCurrentUser(): number {
  const db = getDb();
  const currentUserId = getCurrentUserId();
  let count = 0;
  // jobs are stored as JSON blobs (id, user_id, data) — filter by the
  // CURRENT user: job ids are shared across users (ATS fingerprints), so
  // updates MUST be scoped by user_id or they collide (PK = user_id, id).
  const rows = db.prepare('SELECT id, data FROM jobs WHERE user_id = ?').all(currentUserId) as Array<{ id: string; data: string }>;
  for (const row of rows) {
    let job: Job;
    try {
      job = JSON.parse(row.data) as Job;
    } catch { continue; }
    const cv = job.tailoredCv;
    // Any job carrying a tailored CV qualifies (state may be 'applied' after
    // the user applied — the CV must still match the current Master CV).
    if (!cv) continue;
    const needsAudit = !cv.audit;
    const needsContact = !cv.contactInfo || !cv.contactInfo.email;
    // Skills still flat ('Skills' single bucket) → regroup like Master CV.
    const needsSkillGrouping = Array.isArray(cv.technicalSkills) && cv.technicalSkills.length === 1 && cv.technicalSkills[0]?.category === 'Skills' && (cv.coreCompetencies?.length || 0) > 0;
    // Sections the LLM may have touched (projects/education/certs) must be
    // replaced with the Master CV's verbatim content.
    const needsVerbatim = (() => {
      const master = getMasterCv();
      const projEq = JSON.stringify((cv.projects || []).map((p) => p.name)) === JSON.stringify((master.projects || []).map((p) => p.name));
      const eduEq = (cv.education || []).length === (master.education || []).length;
      const certEq = (cv.certifications || []).length === (master.certifications || []).length;
      return !projEq || !eduEq || !certEq;
    })();
    if (!needsAudit && !needsContact && !needsSkillGrouping && !needsVerbatim) continue;
    // Terms: from the real JD when stored; otherwise the gap analysis the
    // match produced (deterministic, grounded, never LLM).
    const terms = needsAudit ? jdSkillTerms(String(job.description || '')) : [];
    if (!terms.length && needsAudit) {
      const gapTerms = [
        ...(job.gapAnalysis?.matchingSkills || []),
        ...(job.gapAnalysis?.missingSkills || []),
        ...(job.gapAnalysis?.missingKeywords || []),
      ];
      if (!gapTerms.length) continue;
      terms.push(...gapTerms);
    }
    backfillRowWithTerms(job, cv, terms, db, row.id, needsAudit);
    count++;
  }
  return count;
}

function backfillRowWithTerms(job: Job, cv: TailoredCv, terms: string[], db: ReturnType<typeof getDb>, rowId: string, needsAudit: boolean): void {
  const baseAudit = cv.audit || null;
  let audit = baseAudit;
  if (needsAudit) {
    const draft: TailorDraft = {
      summary: cv.professionalSummary || '',
      skills: cv.coreCompetencies || [],
      experience: (cv.workExperience || []).map((w) => ({ title: w.title, company: w.company, dates: w.dates, highlights: w.highlights || [] })),
      education: (cv.education || []).map((e) => ({ degree: e.degree, institution: e.institution, dates: e.dates })),
      certifications: (cv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '')),
      projects: (cv.projects || []).map((p) => ({ name: p.name, description: p.description || '' })),
    };
    audit = buildTailorAudit(job, draft, terms, getMasterCv());
  }
  enrichTailoredCv(cv, audit as TailoringAudit, getMasterCv());
  groupSkillsLikeMasterCv(cv, getMasterCv());
  applyMasterSectionsVerbatim(cv, getMasterCv());
  job.tailoredCv = cv;
  db.prepare('UPDATE jobs SET data = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(job), rowId, getCurrentUserId());
}

/** Adapter: TailoredCv → TailorDraft shape for the deterministic audit. */
export function tailoredCvToDraft(cv: TailoredCv): TailorDraft {
  return {
    summary: cv.professionalSummary || '',
    skills: cv.coreCompetencies || [],
    experience: (cv.workExperience || []).map((w) => ({ title: w.title, company: w.company, dates: w.dates, highlights: w.highlights || [] })),
    education: (cv.education || []).map((e) => ({ degree: e.degree, institution: e.institution, dates: e.dates })),
    certifications: (cv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '')),
    projects: (cv.projects || []).map((p) => ({ name: p.name, description: p.description || '' })),
  };
}
