import { askJson } from '../llm/askJson.js';
import { MasterCv, TailoredCv } from '../../src/types.js';
import { getMarketData, STOPWORDS } from './marketData.js';

export interface CompressGuidance {
  sections: { name: string; changes: { type: 'tighten' | 'merge' | 'keep'; bulletIndexes: number[]; reason: string }[] }[];
}

export interface CompressResult {
  guidance: CompressGuidance;
  compressedCv: TailoredCv;
  verification: { preserved: string[]; dropped: string[] };
  marketSummary: { jobCount: number; topKeywords: string[] };
  wordCountBefore: number;
  wordCountAfter: number;
}

function experienceLevel(masterCv: MasterCv): 'entry' | 'mid' | 'senior' {
  const totalYrs = masterCv.experiences.reduce((acc, e) => {
    const m = e.dates.match(/(\d{4})/g);
    if (m && m.length >= 2) return acc + (parseInt(m[1], 10) - parseInt(m[0], 10));
    return acc;
  }, 0);
  if (totalYrs < 3) return 'entry';
  if (totalYrs < 8) return 'mid';
  return 'senior';
}

function countWords(s: string): number {
  return (s || '').split(/\s+/).filter(Boolean).length;
}

function extractKeywords(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9+.#-]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function compressCv(
  masterCv: MasterCv,
  targetRole: string,
  marketData: ReturnType<typeof getMarketData>
): Promise<CompressResult> {
  const level = experienceLevel(masterCv);
  const targetPages = level === 'entry' ? 1 : 2;

  const marketBlock = marketData.jobCount > 0
    ? `LIVE MARKET DATA (${marketData.jobCount} recent job postings matching "${targetRole}"):
Top keywords by frequency: ${marketData.topKeywords.join(', ') || '(none)'}
Sample requirement lines:
${marketData.sampleRequirements.map((s) => `- ${s}`).join('\n')}`
    : `No live market data available for "${targetRole}". Use your professional knowledge of the role's current market.`;

  const cvBlock = `CANDIDATE MASTER CV (current, ${countWords(JSON.stringify(masterCv))} words):
${JSON.stringify(masterCv, null, 2)}`;

  // ── Phase 1: analyze ──
  const analyzePrompt = `You are a senior executive resume consultant with deep knowledge of the ${targetRole} market.

${marketBlock}

${cvBlock}

TASK — ANALYZE ONLY. Return valid JSON (no markdown, no code fences):
{
  "sections": [
    {
      "name": "Work Experience" | "Summary" | "Skills" | "Projects" | "Education" | "Certifications",
      "changes": [
        { "type": "tighten" | "merge" | "keep", "bulletIndexes": [indices of experience bullets or 0 for single-block sections], "reason": "short English explanation of what to change and why, preserving meaning" }
      ]
    }
  ]
}

RULES:
- Tighten = shorten wording, keep every keyword and metric. Merge = combine overlapping bullets into one, keeping both keywords/metrics. Keep = leave untouched.
- Never recommend dropping meaning, metrics, or keywords. Every statement's meaning must survive.
- Use the market keywords to suggest which skills to surface or add to Skills.
- Target ${targetPages} page${targetPages > 1 ? 's' : ''} for this candidate (${level} level).
- Be concrete and specific.`;

  let guidance: CompressGuidance;
  try {
    guidance = await askJson<CompressGuidance>(analyzePrompt, { temperature: 0.2 });
  } catch {
    throw new Error('AI returned invalid JSON.');
  }

  // ── Phase 2: rewrite ──
  const rewritePrompt = `You are a senior executive resume writer. Rewrite the candidate's CV to fit ${targetPages} page${targetPages > 1 ? 's' : ''} WITHOUT losing any meaning, keyword, or metric.

${marketBlock}

${cvBlock}

Guidance from the analysis phase:
${JSON.stringify(guidance, null, 2)}

Return valid JSON ONLY (no markdown, no code fences) in EXACTLY this shape:
{
  "candidateName": string,
  "contactInfo": { "email": string, "phone": string, "location": string, "linkedin": string, "github": string, "website": string },
  "professionalSummary": string,
  "targetRole": string,
  "coreCompetencies": string[],
  "workExperience": [{ "title": string, "company": string, "location": string, "dates": string, "highlights": string[] }],
  "education": [{ "degree": string, "institution": string, "dates": string, "details": string }],
  "technicalSkills": [{ "category": string, "skills": string[] }],
  "projects": [{ "name": string, "description": string, "technologies": string[], "link": string, "dates": string }],
  "certifications": string[]
}

STRICT RULES:
- Keep the candidate's real title ("${masterCv.experiences[0]?.title || targetRole}") as targetRole. Never rename.
- Every original bullet's meaning and metrics must survive — tighten/merge, never drop substance.
- Weave the market keywords into bullets and skills naturally.
- Target role: ${targetRole}. Target: ${targetPages} page${targetPages > 1 ? 's' : ''}.`;

  let compressedCv: TailoredCv;
  try {
    compressedCv = await askJson<TailoredCv>(rewritePrompt, { temperature: 0.2 });
  } catch {
    throw new Error('AI returned invalid JSON.');
  }

  // ── Phase 3: verify (deterministic) ──
  const originalBullets = masterCv.experiences.flatMap((e) => e.responsibilities);
  const originalText = originalBullets.join(' ') + ' ' + masterCv.summary + ' ' +
    masterCv.skills.flatMap((s) => s.items).join(' ') + ' ' +
    (masterCv.projects || []).map((p) => [p.name, p.description, (p.technologies || []).join(' ')].join(' ')).join(' ') + ' ' +
    masterCv.education.map((e) => [e.degree, e.institution].join(' ')).join(' ');
  const compressedText = [
    compressedCv.professionalSummary || '',
    ...(compressedCv.workExperience || []).flatMap((w) => w.highlights || []),
    ...(compressedCv.coreCompetencies || []),
    ...(compressedCv.technicalSkills || []).flatMap((t) => t.skills || []),
    ...(compressedCv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name)),
    ...(compressedCv.projects || []).map((p) => [p.name, p.description, (p.technologies || []).join(' ')].join(' ')),
    ...(compressedCv.education || []).map((e) => [e.degree, e.institution].join(' ')),
  ].join(' ');

  const originalKeywords = extractKeywords(originalText);
  const keywordChecks = originalKeywords.map((k) => ({ kw: k, re: new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i') }));
  const preserved = keywordChecks.filter(({ re }) => re.test(compressedText)).map(({ kw }) => kw);
  const dropped = keywordChecks.filter(({ re }) => !re.test(compressedText)).map(({ kw }) => kw);

  return {
    guidance,
    compressedCv,
    verification: { preserved, dropped },
    marketSummary: { jobCount: marketData.jobCount, topKeywords: marketData.topKeywords },
    wordCountBefore: countWords(JSON.stringify(masterCv)),
    wordCountAfter: countWords(JSON.stringify(compressedCv)),
  };
}
