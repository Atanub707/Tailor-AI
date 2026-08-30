import { BaseCvBuilder } from './baseBuilder.js';
import { Job, MasterCv, TailoredCv } from '../../src/types.js';
import { ask } from '../llm/llmAdapter.js';
import { extractJsonObject } from '../llm/jsonExtract.js';

export class LlmCvTailor extends BaseCvBuilder {
  async tailorCv(
    job: Job,
    masterCv: MasterCv,
    opts?: { includeSkills?: string[] }
  ): Promise<TailoredCv> {
    const candidateTitle = masterCv.experiences[0]?.title || masterCv.summary?.split(/[.,\n]/)[0]?.trim() || job.title;

    const missingSkills = job.gapAnalysis?.missingSkills || [];
    const missingKeywords = job.gapAnalysis?.missingKeywords || [];

    // User-controlled tailoring: when an explicit selection is provided
    // (Manual JD), only the selected missing items are incorporated and
    // anything not selected is explicitly skipped. Without a selection
    // (job-card Tailor / Re-Tailor), EVERYTHING missing is integrated —
    // never exclude the whole set, or the prompt contradicts itself.
    const hasSelection = Array.isArray(opts?.includeSkills) && opts.includeSkills.length > 0;
    const allowList = (opts?.includeSkills || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allowedSet = new Set(allowList);
    // Single, deduplicated universe of every missing keyword.
    const allMissing = [...new Set([...missingSkills, ...missingKeywords])];
    const selectedList = hasSelection ? allMissing.filter((s) => allowedSet.has(s.toLowerCase())) : allMissing;
    const excludedList = hasSelection ? allMissing.filter((s) => !allowedSet.has(s.toLowerCase())) : [];

    const missingKeywordsStr = selectedList.length > 0
      ? selectedList.map(k => `  - ${k}`).join('\n')
      : '  (none selected)';

    const prompt = `You are an elite Executive Resume Writer and ATS Optimization Specialist.

STRICT RULES:
- NEVER fabricate companies, dates, degrees, or work experience.
- The candidate's actual job title ("${candidateTitle}") MUST remain exactly as stated.
- ${selectedList.length > 0
      ? `INCORPORATE ONLY these selected missing keywords: ${selectedList.join(', ')} — DO NOT add or mention any other missing keyword.`
      : 'Integrate all missing keywords identified in the JD.'}
${excludedList.length > 0 ? `- EXCLUDED (do NOT add, do NOT mention): ${excludedList.join(', ')}` : ''}

MISSING JD KEYWORDS TO INTEGRATE:
These keywords from the job description are NOT currently in the candidate's CV.
For EACH keyword, choose the best placement:

1. IN EXPERIENCE BULLETS (preferred): Rephrase an existing responsibility to include the keyword naturally.
   Example: "Managed vulnerability prioritization using CVSS scoring" — the candidate DID manage vulnerabilities, you're adding the methodology name.

2. IN SKILLS / COMPETENCIES (fallback): If the keyword cannot fit into any existing bullet, add it to coreCompetencies or technicalSkills.
   Example: Add "CISA KEV" as a technical skill the candidate is familiar with.

Every keyword MUST be placed in at least one category (inExperience or inSkills). None should be skipped.

${missingKeywordsStr}

CRITICAL: Rephrase existing experience — never invent new projects or roles. Adding a methodology name to a real responsibility is NOT fabrication. Adding a skill to the skills list is NOT fabrication.

CANDIDATE MASTER CV:
Name: ${masterCv.fullName}
Email: ${masterCv.email} | Phone: ${masterCv.phone} | Location: ${masterCv.location}
Current Role: ${candidateTitle}
Summary: ${masterCv.summary}
Experiences:
${JSON.stringify(masterCv.experiences, null, 2)}
Education:
${JSON.stringify(masterCv.education, null, 2)}
Skills:
${JSON.stringify(masterCv.skills, null, 2)}
Certifications:
${JSON.stringify((masterCv.certifications || []).map(c => typeof c === 'string' ? c : c.name + (c.issuer ? ' (' + c.issuer + ')' : '')), null, 2)}

TARGET JOB DETAILS:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description}

Return valid JSON only — NO markdown, NO code fences, pure JSON:
{
  "candidateName": "${masterCv.fullName}",
  "targetRole": "${candidateTitle}",
  "professionalSummary": string,
  "coreCompetencies": string[],
  "workExperience": [{ "title": string, "company": string, "location": string, "dates": string, "highlights": string[] }],
  "education": [{ "degree": string, "institution": string, "dates": string, "details": string }],
  "technicalSkills": [{ "category": string, "skills": string[] }],
  "inExperience": string[] (missing keywords integrated into experience bullets),
  "inSkills": string[] (missing keywords added to skills/competencies — placed here because they couldn't fit naturally into experience bullets),
  "afterScore": number,
  "auditNotes": string[]
}`;

    try {
      let jsonText = await ask(prompt, 0.2);
      let parsed;
      try {
        parsed = extractJsonObject(jsonText);
      } catch (parseErr: any) {
        // ONE retry with the syntax error surfaced — an occasional stray
        // LLM parse failure should never fail a Tailor run visibly.
        jsonText = await ask(
          `${prompt}\n\nIMPORTANT: your previous response was not valid JSON (${String(parseErr?.message || parseErr).slice(0, 200)}). Return ONLY the JSON object — no thinking, no comments, no markdown, every key double-quoted.`,
          0.2,
        );
        parsed = extractJsonObject(jsonText);
      }

      const beforeScore = job.matchScore || job.gapAnalysis?.matchScore || 50;

      const cvText = [
        parsed.professionalSummary || '',
        ...(parsed.workExperience || []).flatMap((w: any) => w.highlights || []),
        ...(parsed.coreCompetencies || []),
        ...(parsed.technicalSkills || []).flatMap((t: any) => t.skills || []),
      ].join(' ').toLowerCase();


      // Normalize both sides (lowercase, strip punctuation) so "NodeJS"
      // matches "Node.js", "CI/CD" matches "CI CD", etc.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const cvNorm = norm(cvText);
      const contains = (kw: string) => cvNorm.includes(norm(kw));

      const verifiedInExperience = (parsed.inExperience || []).filter((kw: string) => contains(kw));
      const verifiedInSkills = (parsed.inSkills || []).filter((kw: string) => contains(kw));
      const verifiedAll = [...new Set([...verifiedInExperience, ...verifiedInSkills])];

      const notIntegrable = missingKeywords.filter((kw: string) => {
        const lower = norm(kw);
        return !verifiedInExperience.some((v: string) => norm(v) === lower)
            && !verifiedInSkills.some((v: string) => norm(v) === lower);
      });

      const totalMissing = missingKeywords.length || 1;
      const expWeight = verifiedInExperience.length;
      const skillsWeight = verifiedInSkills.length * 0.5;
      const weightedFill = (expWeight + skillsWeight) / totalMissing;
      const weightedFillCapped = Math.min(weightedFill, 0.95);

      const afterScore = Math.round(beforeScore + weightedFillCapped * (100 - beforeScore));
      const scoreBoost = afterScore - beforeScore;

      const rephrasedCount = (parsed.workExperience || []).reduce(
        (acc: number, item: any) => acc + (item.highlights?.length || 0), 0
      );

      const auditNotes = [
        `Maintained candidate's title as "${candidateTitle}" (not changed to "${job.title}").`,
        `Integrated ${verifiedInExperience.length} keywords into experience bullets, added ${verifiedInSkills.length} to skills section.`,
        `Rephrased ~${rephrasedCount} bullet points to naturally incorporate target keywords.`,
        ...(parsed.auditNotes || []).slice(0, 3),
      ];

      return {
        candidateName: masterCv.fullName,
        contactInfo: {
          email: masterCv.email,
          phone: masterCv.phone,
          location: masterCv.location,
          linkedin: masterCv.linkedin,
          github: masterCv.github,
          website: masterCv.website,
        },
        targetRole: candidateTitle,
        professionalSummary: parsed.professionalSummary || '',
        coreCompetencies: parsed.coreCompetencies || [],
        workExperience: parsed.workExperience || [],
        education: parsed.education || [],
        technicalSkills: parsed.technicalSkills || [],
        projects: masterCv.projects || [],
        certifications: (masterCv.certifications || []).map((c) =>
          typeof c === 'string' ? c : `${c.name}${c.issuer ? ' (' + c.issuer + ')' : ''}`
        ),
        rephraseHighlightsCount: rephrasedCount,
        keywordsIncorporated: verifiedAll,
          audit: {
          beforeScore,
          afterScore,
          scoreBoost,
          scoreBreakdown: {
            alreadyMatched: beforeScore,
            newlyIntegrated: scoreBoost,
            remainingGap: 100 - afterScore,
          },
          missingBefore: {
            skills: missingSkills,
            keywords: missingKeywords,
          },
          addedAfter: {
            keywordsIncorporated: verifiedAll,
            keywordsInExperience: verifiedInExperience,
            keywordsInSkills: verifiedInSkills,
            rephrasedHighlightsCount: rephrasedCount,
            // Honest: only the SELECTED skills that actually appear in the
            // resulting CV (never a wholesale echo of every missing skill).
            skillsAdded: (selectedList.length > 0 ? selectedList : allMissing).filter((s) =>
              JSON.stringify({ p: parsed.professionalSummary, e: parsed.workExperience, t: parsed.technicalSkills }).toLowerCase().includes(s.toLowerCase())
            ),
          },
          notIntegrable,
          auditNotes,
        },
      };
    } catch (err) {
      // No silent fallback: LLM failures (missing/expired key, provider
      // errors) propagate to the route, which returns a structured alert.
      console.error('Tailor CV LLM error:', err);
      throw err;
    }
  }

}
