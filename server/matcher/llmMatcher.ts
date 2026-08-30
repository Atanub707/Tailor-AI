import { BaseMatcher, MatchResult } from './baseMatcher.js';
import { Job, MasterCv, GapAnalysis } from '../../src/types.js';
import { ask } from '../llm/llmAdapter.js';
import { extractJsonObject } from '../llm/jsonExtract.js';

export class LlmMatcher extends BaseMatcher {
  async matchJob(job: Job, masterCv: MasterCv, earlyBlockThreshold = 30): Promise<MatchResult> {
    const prompt = `You are a real-world ATS (Applicant Tracking System) scoring engine and a Technical Recruiter. Your job is to score how well a candidate's CV would rank when processed by an actual ATS (Greenhouse, Workday, Lever, Taleo, iCIMS, SmartRecruiters).

Rules of real ATS scoring:
- ATS does NOT "understand" context like a human. It parses text and matches exact keywords.
- Boolean search is the primary filter: recruiters search ("Senior" AND "DevOps" AND "AWS"). If exact combos are missing, the resume is invisible regardless of skill.
- Section-weighting: keywords from job TITLES and SUMMARY count 2x more than keywords from a skills list.
- Recency weighting: skills demonstrated in the most recent role count more than skills from 5+ years ago.
- Keyword density matters: a skill mentioned multiple times across different roles scores higher than a skill listed once.
- Hard skills (AWS, Docker, Terraform, Kubernetes, Python) count toward score. Soft skills (leadership, communication) do NOT move the ATS score.
- Contextual relevance matters: "Led Kubernetes migration for 200 nodes" scores higher than listing "Kubernetes" 5 times.
- Quantification (metrics, numbers, percentages, scale) is a bonus signal in modern AI-enhanced ATS.
- Exact certification names must match ("AWS Certified Solutions Architect" not just "AWS").
- Years of experience: calculate from actual dates in experience entries, not just stated years.

SCORING METHODOLOGY (weighted):
1. Boolean Title Match (20%): Does the CV have the exact title or standard variants? "DevOps Engineer" vs "DevOps Engineer II", "Platform Engineer", "SRE"
2. Hard Skills Overlap (35%): Extract every hard skill/tool/technology from the JD. Count how many appear in the CV. Weight by section (title/summary 2x, experience 1.5x, skills list 1x).
3. Years of Experience Fit (15%): Calculate total years from dates. Compare to JD requirement. Score drops if underqualified.
4. Keyword Density & Recency (15%): For each JD keyword, count how many times it appears across different roles. Penalize if only in one old role.
5. Certification Match (5%): Does the CV contain exact certification names from the JD?
6. Quantification Bonus (10%): Do experience bullets contain metrics, numbers, percentages, or scale indicators?

CANDIDATE MASTER CV:
Name: ${masterCv.fullName}
Summary: ${masterCv.summary}
Skills: ${masterCv.skills.map((s) => `${s.category}: ${s.items.join(', ')}`).join(' | ')}
Experience (with dates):
${masterCv.experiences.map((e) => `- ${e.title} at ${e.company} (${e.dates}): ${e.responsibilities.join('; ')}`).join('\n')}
Education:
${masterCv.education.map((e) => `- ${e.degree} from ${e.institution} (${e.dates})`).join('\n')}
Certifications:
${(masterCv.certifications || []).map((c) => `- ${typeof c === 'string' ? c : c.name + (c.issuer ? ' (' + c.issuer + ')' : '')}`).join('\n') || 'None listed'}

TARGET JOB DESCRIPTION:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Salary: ${job.salaryText || 'Not specified'}
Description: ${job.description}

Return valid JSON only with these exact fields — NO markdown, NO code fences, pure JSON:
{
  "matchScore": number (0-100, weighted using the methodology above),
  "matchingSkills": string[] (hard skills from JD found in CV),
  "missingSkills": string[] (hard skills from JD NOT found in CV),
  "matchedKeywords": string[] (exact keyword matches found in CV),
  "missingKeywords": string[] (JD keywords absent from CV),
  "salaryFit": "below" | "matched" | "above" | "unknown",
  "experienceFit": "entry" | "mid" | "senior" | "overqualified" | "ideal",
  "yearsOfExperience": number (calculated from dates),
  "yearsRequired": number (estimated from JD),
  "booleanSearchResult": "pass" | "borderline" | "fail" (would a boolean search for the target title + top 3 hard skills find this CV?),
  "keyRecommendations": string[] (3-5 specific, actionable CV changes to pass ATS screening),
  "summaryAnalysis": string (2 sentences: what the ATS sees and the critical gap)
}`;

    try {
      const jsonText = await ask(prompt, 0.1);
      const parsed = extractJsonObject(jsonText);

      const score = Math.min(100, Math.max(0, Math.round(parsed.matchScore || 50)));
      const isEarlyBlocked = score < earlyBlockThreshold;

      const gapAnalysis: GapAnalysis = {
        matchScore: score,
        matchingSkills: parsed.matchingSkills || [],
        missingSkills: parsed.missingSkills || [],
        matchedKeywords: parsed.matchedKeywords || parsed.matchingSkills || [],
        missingKeywords: parsed.missingKeywords || parsed.missingSkills || [],
        salaryFit: (['below', 'matched', 'above', 'unknown'].includes(parsed.salaryFit)
          ? parsed.salaryFit
          : 'matched') as any,
        experienceFit: (['entry', 'mid', 'senior', 'overqualified', 'ideal'].includes(parsed.experienceFit)
          ? parsed.experienceFit
          : 'ideal') as any,
        keyRecommendations: parsed.keyRecommendations || [
          'Highlight relevant keywords in work experience bullet points.',
          'Quantify accomplishments with metrics aligned with job requirements.',
        ],
        summaryAnalysis: parsed.summaryAnalysis || `Match score calculated at ${score}%.`,
        yearsOfExperience: parsed.yearsOfExperience,
        yearsRequired: parsed.yearsRequired,
        booleanSearchResult: (['pass', 'borderline', 'fail'].includes(parsed.booleanSearchResult)
          ? parsed.booleanSearchResult
          : undefined) as any,
      };

      return {
        matchScore: score,
        gapAnalysis,
        isEarlyBlocked,
      };
    } catch (err) {
      // No silent fallback: LLM failures (missing/expired key, provider
      // errors) propagate to the route, which returns a structured alert.
      throw err;
    }
  }

}
