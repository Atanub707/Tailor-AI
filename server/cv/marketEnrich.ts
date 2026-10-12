// Market-gap AI enrichment for the Master CV ("Enrich with AI").
//
// The Master CV is the single source of truth and it must stay TRUE. This
// module turns the aggregated market gaps (skills most frequently missing
// across scored jobs) into a PROPOSAL:
//   - the LLM classifies each gap as supported / adjacent / unsupported and
//     must cite a basis copied from the CV;
//   - a deterministic grounding check re-verifies every "supported" verdict
//     against the CV text and DEMOTES anything it cannot find;
//   - credentials / tenure / titles (never-claim facts) are filtered out
//     before the LLM ever sees them;
//   - NOTHING is written until the user explicitly applies the proposal.
//
// Applying is pure and user-scoped: skills are placed into the CV's own
// categories, project tags append to existing technologies, and the summary
// rewrite is accepted only when it passes the same grounding checks.

import type { MasterCv } from '../../src/types.js';
import { askJson } from '../llm/askJson.js';
import { isUnsupportedClaim, unsupportedClaimLeaks } from '../builder/llmCvTailor.js';
import { containsKeyword } from '../tailor/keywordMatch.js';
import { extractNumericTokens } from '../tailor/generatedTextSafety.js';

export interface MarketGap {
  skill: string;
  count: number;
  totalScored: number;
}

export interface EnrichItem {
  gap: string;
  count: number;
  verdict: 'supported' | 'adjacent' | 'unsupported';
  basis: string;
  category: string;
  /** grounding strength 0..1 (deterministic, post-LLM) */
  grounding: number;
}

export interface EnrichProposal {
  id: string;
  createdAt: string;
  items: EnrichItem[];
  summaryRewrite: { text: string; reason: string } | null;
  projectTags: Array<{ project: string; tag: string; basis: string }>;
  stats: {
    scannedJobs: number;
    gapsConsidered: number;
    supported: number;
    adjacent: number;
    unsupported: number;
    droppedClaims: number;
  };
}

// ── deterministic helpers ────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'across', 'using', 'used', 'your', 'their',
  'they', 'them', 'have', 'has', 'had', 'was', 'were', 'are', 'is', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'an',
  'a', 'or', 'it', 'its', 'be', 'been', 'will', 'would', 'can', 'could', 'should', 'not', 'but', 'also', 'while',
  'which', 'where', 'when', 'who', 'whom', 'than', 'then', 'there', 'these', 'those', 'each', 'both', 'any', 'all',
]);

function sigTokens(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9+#./-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Fraction of the basis's significant tokens that appear in the evidence. */
export function basisGrounding(basis: string, evidenceText: string): number {
  const toks = sigTokens(basis);
  if (!toks.length) return 0;
  const ev = evidenceText.toLowerCase();
  const hits = toks.filter((t) => ev.includes(t)).length;
  const frac = hits / toks.length;
  // A quoted excerpt that literally exists in the CV is maximum grounding.
  const q = String(basis || '').match(/["“]([^"”]{20,})["”]/);
  if (q) {
    const quote = q[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (ev.replace(/\s+/g, ' ').includes(quote)) return 1;
  }
  return frac;
}

/** Values-only evidence text — what the candidate can honestly claim. */
export function masterCvEvidenceText(cv: MasterCv): string {
  return [
    cv.summary,
    cv.designation,
    ...(cv.experiences || []).flatMap((e) => [e.title, e.company, ...(e.responsibilities || [])]),
    ...(cv.skills || []).flatMap((g) => [g.category, ...(g.items || [])]),
    ...(cv.certifications || []).map((c) => (typeof c === 'string' ? c : `${c.name} ${c.issuer || ''} ${c.date || ''}`)),
    ...(cv.projects || []).flatMap((p) => [p.name, p.description, ...(p.technologies || [])]),
    ...(cv.education || []).flatMap((e) => [e.degree, e.institution]),
  ]
    .filter(Boolean)
    .join(' \n ');
}

/** Market gaps worth enriching on: drop never-claim facts, drop anything the
 *  CV already states, rank by market frequency, cap the LLM input. */
export function selectGapsForEnrichment(gaps: MarketGap[], evidenceText: string, max = 40): MarketGap[] {
  const seen = new Set<string>();
  return (gaps || [])
    .filter((g) => g && g.skill && !isUnsupportedClaim(g.skill) && !containsKeyword(evidenceText, g.skill))
    .filter((g) => {
      const k = g.skill.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

/** Deterministic re-verification of LLM verdicts. */
export function groundEnrichItems(
  rawItems: any[],
  candidates: MarketGap[],
  evidenceText: string,
  categories: string[]
): { items: EnrichItem[]; droppedClaims: number } {
  const byGap = new Map(candidates.map((g) => [g.skill.toLowerCase(), g]));
  const items: EnrichItem[] = [];
  let droppedClaims = 0;
  for (const raw of rawItems || []) {
    const gap = String(raw?.gap || '').trim();
    if (!gap) continue;
    if (isUnsupportedClaim(gap)) {
      droppedClaims++;
      continue;
    }
    const candidate = byGap.get(gap.toLowerCase());
    if (!candidate) continue; // never propose gaps that weren't on the list
    const basis = String(raw?.basis || '').trim();
    const grounding = basis ? basisGrounding(basis, evidenceText) : 0;
    let verdict: EnrichItem['verdict'] =
      raw?.verdict === 'supported' || raw?.verdict === 'adjacent' || raw?.verdict === 'unsupported'
        ? raw.verdict
        : 'unsupported';
    // Demotion rules — the LLM cannot self-certify.
    if (verdict === 'supported' && grounding < 0.6) verdict = grounding >= 0.3 ? 'adjacent' : 'unsupported';
    else if (verdict === 'adjacent' && grounding < 0.3) verdict = 'unsupported';
    const suggested = String(raw?.category || '').trim();
    const category = categories.find((c) => c.toLowerCase() === suggested.toLowerCase()) || 'Core Competencies';
    items.push({ gap, count: candidate.count, verdict, basis, category, grounding: Math.round(grounding * 100) / 100 });
  }
  // Present in market order, useful and stable for the UI.
  items.sort((a, b) => b.count - a.count);
  return { items, droppedClaims };
}

function groundSummaryRewrite(raw: any, cv: MasterCv, evidenceText: string): { text: string; reason: string } | null {
  const text = String(raw?.text || '').trim();
  if (!text) return null;
  const words = text.split(/\s+/).length;
  if (words < 25 || words > 95) return null;
  // No credential/tenure/title claims.
  if (unsupportedClaimLeaks({ professionalSummary: text }, evidenceText).length > 0) return null;
  // Every number in the rewrite must exist in the CV's own text.
  const cvNumbers = new Set(extractNumericTokens(evidenceText));
  for (const n of extractNumericTokens(text)) {
    if (!cvNumbers.has(n)) return null;
  }
  const reason = String(raw?.reason || 'Rewritten summary grounded in your existing experience.').slice(0, 200);
  return { text, reason };
}

function groundProjectTags(raw: any[], cv: MasterCv, evidenceText: string): EnrichProposal['projectTags'] {
  const projects = cv.projects || [];
  const out: EnrichProposal['projectTags'] = [];
  for (const t of raw || []) {
    const projectName = String(t?.project || '').trim();
    const tag = String(t?.tag || '').trim();
    if (!projectName || !tag) continue;
    if (isUnsupportedClaim(tag)) continue;
    const project = projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase() || p.name.toLowerCase().includes(projectName.toLowerCase()));
    if (!project) continue;
    const projectText = [project.name, project.description, ...(project.technologies || [])].join(' \n ');
    if (!containsKeyword(projectText, tag) && basisGrounding(String(t?.basis || ''), evidenceText) < 0.6) continue;
    out.push({ project: project.name, tag, basis: String(t?.basis || '').slice(0, 200) });
  }
  return out;
}

// ── proposal building ────────────────────────────────────────────────────

export async function buildEnrichmentProposal(cv: MasterCv, gaps: MarketGap[]): Promise<EnrichProposal> {
  const evidenceText = masterCvEvidenceText(cv);
  const totalScored = gaps[0]?.totalScored || 0;
  const candidates = selectGapsForEnrichment(gaps, evidenceText);
  const categories = (cv.skills || []).map((g) => g.category);

  if (!candidates.length) {
    return {
      id: `enrich-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      items: [],
      summaryRewrite: null,
      projectTags: [],
      stats: { scannedJobs: totalScored, gapsConsidered: 0, supported: 0, adjacent: 0, unsupported: 0, droppedClaims: 0 },
    };
  }

  const gapLines = candidates.map((g) => `  - ${g.skill} — missing from ${g.count} of ${g.totalScored} scored jobs`).join('\n');
  const prompt = `You are a meticulous career-data auditor. You are enriching a candidate's MASTER CV with skills the job market most frequently asks for — but ONLY where the candidate's own CV already evidences the skill. You never invent.

MARKET GAPS (most frequent first):
${gapLines}

MASTER CV:
Name: ${cv.fullName}
Summary: ${cv.summary}
Experiences:
${JSON.stringify((cv.experiences || []).map((e) => ({ title: e.title, company: e.company, dates: e.dates, bullets: e.responsibilities })), null, 2)}
Skills (categories): ${JSON.stringify(cv.skills || [])}
Projects: ${JSON.stringify((cv.projects || []).map((p) => ({ name: p.name, description: p.description, technologies: p.technologies })), null, 2)}
Certifications: ${JSON.stringify((cv.certifications || []).map((c) => (typeof c === 'string' ? c : `${c.name} (${c.issuer || ''})`)))}
Education: ${JSON.stringify((cv.education || []).map((e) => `${e.degree} — ${e.institution}`))}

For EACH market gap above, classify it:
- "supported": the CV text ALREADY demonstrates it. basis MUST quote or closely paraphrase the exact CV line that proves it.
- "adjacent": the CV strongly implies it through related work. basis explains which real work implies it.
- "unsupported": there is no evidence in the CV — the candidate must learn or earn it.

HARD RULES:
- basis is REQUIRED for supported/adjacent and must come from the CV text — never invented, never from the job market.
- NEVER propose certifications, licenses, experience-years or job titles.
- category: place supported/adjacent gaps into one of the CV's EXISTING skill categories: ${JSON.stringify(categories)} (or "Core Competencies" if none fits).

Then, optionally:
- "summaryRewrite": ONLY if the current summary can be strengthened by mentioning supported skills — realize it with 2-3 lines (30-80 words), keeping every number EXACTLY as in the CV, adding no new facts. Otherwise null.
- "projectTags": for supported technologies that belong to an existing project but are missing from its technologies list; only when the project text evidences it.

Return valid JSON only — NO markdown:
{
  "items": [ { "gap": string, "verdict": "supported" | "adjacent" | "unsupported", "basis": string, "category": string } ],
  "summaryRewrite": { "text": string, "reason": string } | null,
  "projectTags": [ { "project": string, "tag": string, "basis": string } ]
}`;

  const parsed = await askJson<any>(prompt, { temperature: 0.2 });
  const { items, droppedClaims } = groundEnrichItems(parsed?.items, candidates, evidenceText, categories);
  const summaryRewrite = groundSummaryRewrite(parsed?.summaryRewrite, cv, evidenceText);
  const projectTags = groundProjectTags(parsed?.projectTags, cv, evidenceText);

  return {
    id: `enrich-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    items,
    summaryRewrite,
    projectTags,
    stats: {
      scannedJobs: totalScored,
      gapsConsidered: candidates.length,
      supported: items.filter((i) => i.verdict === 'supported').length,
      adjacent: items.filter((i) => i.verdict === 'adjacent').length,
      unsupported: items.filter((i) => i.verdict === 'unsupported').length,
      droppedClaims,
    },
  };
}

// ── applying (pure; nothing persisted here) ──────────────────────────────

export interface ApplyEnrichOptions {
  acceptedGaps: string[];
  applySummary?: boolean;
  projectTags?: Array<{ project: string; tag: string }>;
}

export function applyEnrichment(
  cv: MasterCv,
  proposal: EnrichProposal,
  opts: ApplyEnrichOptions
): { next: MasterCv; applied: { skills: string[]; summary: boolean; projectTags: number } } {
  const next: MasterCv = JSON.parse(JSON.stringify(cv));
  const applied = { skills: [] as string[], summary: false, projectTags: 0 };
  const accepted = new Set((opts.acceptedGaps || []).map((s) => String(s).toLowerCase()));
  const itemByGap = new Map(proposal.items.map((i) => [i.gap.toLowerCase(), i]));

  const allItems = new Set((next.skills || []).flatMap((g) => (g.items || []).map((i) => i.toLowerCase())));
  for (const gapLower of accepted) {
    const item = itemByGap.get(gapLower);
    if (!item || item.verdict === 'unsupported') continue;
    if (allItems.has(gapLower)) continue;
    let group = (next.skills || []).find((g) => g.category.toLowerCase() === item.category.toLowerCase());
    if (!group) {
      group = { category: item.category || 'Core Competencies', items: [] };
      next.skills = [...(next.skills || []), group];
    }
    group.items = [...group.items, item.gap];
    allItems.add(gapLower);
    applied.skills.push(item.gap);
  }

  if (opts.applySummary && proposal.summaryRewrite?.text) {
    next.summary = proposal.summaryRewrite.text;
    applied.summary = true;
  }

  const proposalTags = new Set(proposal.projectTags.map((t) => `${t.project.toLowerCase()}::${t.tag.toLowerCase()}`));
  for (const wanted of opts.projectTags || []) {
    const key = `${String(wanted.project).toLowerCase()}::${String(wanted.tag).toLowerCase()}`;
    if (!proposalTags.has(key)) continue;
    const project = (next.projects || []).find(
      (p) => p.name.toLowerCase() === String(wanted.project).toLowerCase() || p.name.toLowerCase().includes(String(wanted.project).toLowerCase())
    );
    if (!project) continue;
    const existing = new Set((project.technologies || []).map((t) => t.toLowerCase()));
    if (existing.has(String(wanted.tag).toLowerCase())) continue;
    project.technologies = [...(project.technologies || []), wanted.tag];
    applied.projectTags++;
  }

  return { next, applied };
}

// ── market aggregation (shared by /skill-gaps and /enrich) ───────────────

export function aggregateMarketGapsFromJobs(
  jobs: Array<{ gapAnalysis?: { missingSkills?: string[]; missingKeywords?: string[] } }>
): { gaps: MarketGap[]; totalScored: number } {
  const scored = (jobs || []).filter((j) => (j?.gapAnalysis?.missingSkills?.length || 0) > 0);
  const counts: Record<string, { count: number; totalScored: number }> = {};
  for (const job of scored) {
    const allMissing = [...(job.gapAnalysis?.missingSkills || []), ...(job.gapAnalysis?.missingKeywords || [])];
    for (const skill of allMissing) {
      const key = String(skill || '').toLowerCase().trim();
      if (!key) continue;
      if (!counts[key]) counts[key] = { count: 0, totalScored: scored.length };
      counts[key].count++;
    }
  }
  const gaps = Object.entries(counts)
    .map(([skill, data]) => ({ skill, count: data.count, totalScored: data.totalScored }))
    .sort((a, b) => b.count - a.count);
  return { gaps, totalScored: scored.length };
}

// ── short-lived proposal store (user-scoped) ─────────────────────────────

interface StoredProposal {
  userId: string;
  proposal: EnrichProposal;
  expiresAt: number;
}

const proposals = new Map<string, StoredProposal>();
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export function storeEnrichProposal(userId: string, proposal: EnrichProposal): void {
  for (const [id, p] of proposals) {
    if (p.expiresAt < Date.now()) proposals.delete(id);
  }
  proposals.set(proposal.id, { userId, proposal, expiresAt: Date.now() + PROPOSAL_TTL_MS });
}

export function getEnrichProposal(userId: string, id: string): EnrichProposal | null {
  const hit = proposals.get(String(id));
  if (!hit || hit.userId !== userId || hit.expiresAt < Date.now()) return null;
  return hit.proposal;
}
