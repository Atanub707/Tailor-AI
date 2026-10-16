import { BaseCvBuilder } from './baseBuilder.js';
import { Job, MasterCv, TailoredCv } from '../../src/types.js';
import { askJson } from '../llm/askJson.js';
import { containsKeyword } from '../tailor/keywordMatch.js';
import { extractDraftNumbers, extractNumericTokens } from '../tailor/generatedTextSafety.js';
import { TailorVerificationFailedError } from '../tailor/tailorTypes.js';

// ── Integrity gate (frozen invariant: never invent values) ──────────────
// Credentials, tenure numbers and role titles are verifiable FACTS, not
// skills. The JD may ask for them, the CV must never claim them unless the
// candidate's own data already says so.
const HARD_CLAIM_PATTERNS: RegExp[] = [
  /\bcertified\b/i,
  /\bcertification(?:s)?\b/i,
  /\bCKA\b|\bCKAD\b|\bCKS\b|\bCCNSE\b|\bCISA\b|\bCISSP\b|\bCEH\b/i,
  /\b(?:AZ|DVA|DP|AI|PL|SC|MD|MS)-\d{2,4}\b/i,
  /\bpractitioner\b/i,
  /\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\b/i,
];
const ROLE_TITLE_PATTERN = /\b(?:engineer|developer|architect|analyst|specialist|consultant|administrator|professional|associate|expert|ingeniero|desarrollador|arquitecto|analista|especialista|consultor|administrador|ingenieur|entwickler|entwicklerin|berater|developpeur|développeur)\b|(?<!secrets? |certificate |key |access |package |endpoint |device )\bmanager\b/i;
// Output-scan variant: only a TITLE-shaped skill line trips it ("Senior
// DevOps Engineer" as a skill), never a compound category ("Developer
// Tools"). The broad pattern above stays for INPUT gating (isUnsupportedClaim).
const JOB_TITLE_LEAK_PATTERN = /^(?:senior |staff |lead |principal |junior |sr\.? |jr\.? |head of |chief |director of )?(?:.*\s)?(?:engineer|developer|architect|manager|analyst|specialist|consultant|administrator)s?$/im;
const UNSUPPORTED_CLAIM_PATTERNS: RegExp[] = [...HARD_CLAIM_PATTERNS, ROLE_TITLE_PATTERN];

export function isUnsupportedClaim(term: string): boolean {
  const t = String(term || '').trim();
  if (!t) return false;
  return UNSUPPORTED_CLAIM_PATTERNS.some((re) => re.test(t));
}

// ── Consent gate: named tools/technologies (frozen product decision) ────
// A JD asking for "Linux" or "Datadog" is not evidence the candidate has it.
// Auto paths may only weave GENERIC capability wording (all words from the
// allowlist below — e.g. "incident readiness", "CI/CD"); named products,
// languages and acronyms are consent-gated: the user must explicitly select
// them (Manual JD checkboxes) before the engine will claim them.
const GENERIC_STOPWORDS = new Set(['and', 'or', 'of', 'for', 'with', 'to', 'the', 'a', 'an', 'in', 'on']);
const GENERIC_WORDS = new Set([
  // delivery & engineering
  'ci', 'cd', 'cicd', 'devops', 'devsecops', 'automation', 'automated', 'build', 'release',   'delivery', 'deployment',
  'deployments', 'pipeline', 'pipelines', 'tooling', 'workflow', 'workflows', 'process', 'processes', 'engineering',
  'development', 'operations', 'integration', 'implementation', 'provisioning', 'configuration', 'orchestration',
  'containerization', 'virtualization', 'migration', 'migrations', 'modernization', 'optimization', 'optimisation',
  'scaling', 'capacity', 'forecasting', 'tuning', 'hardening', 'testing', 'quality', 'documentation', 'standards',
  'best', 'practices', 'frameworks', 'methodologies', 'principles', 'patterns', 'strategies', 'strategy', 'roadmap',
  // security & compliance
  'security', 'secure', 'compliance', 'governance', 'risk', 'audit', 'audits', 'controls', 'control', 'policies',
  'policy', 'vulnerability', 'vulnerabilities', 'threat', 'threats', 'incident', 'incidents', 'response', 'readiness',
  'remediation', 'resilience', 'integrity', 'signing', 'scanning', 'scan', 'sbom', 'zero', 'trust', 'least',
  'blameless', 'postmortem', 'postmortems', 'post', 'runbook', 'runbooks', 'playbook', 'playbooks',
  'posture', 'hygiene', 'triage', 'escalation', 'review', 'reviews', 'baselining', 'root', 'cause', 'causes',
  'privilege', 'defense', 'defence', 'depth', 'shift', 'left', 'supply', 'chain', 'artifact', 'artifacts', 'access',
  'identity', 'authorization', 'authentication', 'encryption', 'secrets',
  // platform & ops
  'cloud', 'platform', 'infrastructure', 'infra', 'systems', 'system', 'networking',
  'network', 'storage', 'backup', 'recovery', 'availability', 'reliability', 'performance', 'observability',
  'monitoring', 'alerting', 'logging', 'telemetry', 'dashboards', 'metrics', 'analytics', 'analysis', 'reporting',
  'data', 'databases', 'toil', 'oncall', 'on-call', 'sre', 'gitops', 'microservices', 'serverless', 'distributed',
  // management & collaboration
  'management', 'stakeholder', 'stakeholders', 'communication', 'collaboration', 'leadership', 'mentoring',
  'coaching', 'training', 'enablement', 'ownership', 'planning', 'roadmaps', 'prioritization',
  'agile', 'scrum', 'kanban', 'solutions', 'solution', 'services', 'service', 'request',
  'requests', 'change', 'support', 'maintenance', 'guidance', 'cost', 'finops',
]);

/** Generic check with naive plural tolerance — 'analytics platforms' must be
 *  generic capability wording, not a "tool" ('platform' is allowlisted, the
 *  plural was not: real false-gate that failed tailoring runs). */
function isGenericWord(w: string): boolean {
  if (GENERIC_WORDS.has(w) || GENERIC_STOPWORDS.has(w)) return true;
  if (w.endsWith('es') && (GENERIC_WORDS.has(w.slice(0, -2)) || GENERIC_STOPWORDS.has(w.slice(0, -2)))) return true;
  if (w.endsWith('s') && (GENERIC_WORDS.has(w.slice(0, -1)) || GENERIC_STOPWORDS.has(w.slice(0, -1)))) return true;
  return false;
}

export function isNamedTechTerm(term: string): boolean {
  const words = String(term || '')
    .toLowerCase()
    .split(/[\s/&()+,\-–]+/)
    .filter(Boolean);
  if (!words.length) return false;
  return words.some((w) => !isGenericWord(w));
}

/** Terms that must NOT appear in the output unless explicitly selected. */
export function namedTermLeaks(parsed: any, terms: string[]): string[] {
  if (!terms.length) return [];
  const text = outputSurfaceText(parsed);
  return [...new Set(terms.filter((t) => t && containsKeyword(text, t)))];
}

function outputSurfaceText(parsed: any): string {
  return [
    String(parsed?.professionalSummary || ''),
    ...(parsed?.coreCompetencies || []),
    ...(parsed?.technicalSkills || []).flatMap((t: any) => [t?.category, ...(t?.skills || [])]),
    ...(parsed?.workExperience || []).flatMap((w: any) => w?.highlights || []),
  ].filter(Boolean).join(' \n ');
}

/** Scan the LLM output for credential/tenure/title claims the candidate's
 *  own data does not contain. Returns the offending phrases (deduped).
 *  Hard facts (credentials, tenure) are scanned everywhere; role titles are
 *  scanned only in the skills sections (where junk titles get planted) so
 *  ordinary bullet wording doesn't trigger false positives. */
export function unsupportedClaimLeaks(parsed: any, masterText: string): string[] {
  const summaryText = String(parsed?.professionalSummary || '');
  const skillsText = [
    ...(parsed?.coreCompetencies || []),
    ...(parsed?.technicalSkills || []).flatMap((t: any) => [t?.category, ...(t?.skills || [])]),
  ].filter(Boolean).join(' \n ');
  const expText = (parsed?.workExperience || []).flatMap((w: any) => w?.highlights || []).filter(Boolean).join(' \n ');
  const allText = `${summaryText} \n ${skillsText} \n ${expText}`;
  const allowed = (phrase: string) => containsKeyword(masterText, phrase) || masterText.toLowerCase().includes(phrase.toLowerCase());
  const out: string[] = [];
  const scan = (text: string, patterns: RegExp[]) => {
    for (const re of patterns) {
      const matches = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (!matches) continue;
      for (const raw of matches) {
        const phrase = String(raw).trim();
        if (!allowed(phrase)) out.push(phrase);
      }
    }
  };
  scan(allText, HARD_CLAIM_PATTERNS);
  scan(skillsText, [JOB_TITLE_LEAK_PATTERN]);
  return [...new Set(out)];
}

export class LlmCvTailor extends BaseCvBuilder {
  async tailorCv(
    job: Job,
    masterCv: MasterCv,
    opts?: { includeSkills?: string[] }
  ): Promise<TailoredCv> {
    const candidateTitle = masterCv.experiences[0]?.title || masterCv.summary?.split(/[.,\n]/)[0]?.trim() || job.title;

    // ---- Deterministic ground truth about the master CV ----
    const masterText = [
      masterCv.summary,
      ...(masterCv.experiences || []).flatMap((e) => [e.title, e.company, ...(e.responsibilities || [])]),
      ...(masterCv.skills || []).flatMap((g) => g.items || []),
      ...(masterCv.projects || []).flatMap((p) => [p.name, p.description, ...(p.technologies || [])]),
      ...(masterCv.education || []).flatMap((e) => [e.degree, e.institution]),
      ...(masterCv.certifications || []).map((c) => (typeof c === 'string' ? c : c.name)),
    ].join(' ');

    // The gap analysis is LLM output and can flag keywords the CV ALREADY has
    // (e.g. "CI/CD" while a bullet says "CI/CD pipeline"). Only genuinely
    // absent keywords are "missing" — present ones are already_present and
    // must never be re-fed to the LLM as something to add.
    const allMissingRaw = [
      ...new Set([
        ...(job.gapAnalysis?.missingSkills || []),
        ...(job.gapAnalysis?.missingKeywords || []),
      ]),
    ].filter((k) => k && !containsKeyword(masterText, k));

    // INTEGRITY GATE — claims the engine may NEVER plant, even when the JD
    // asks for them: verifiable credentials, tenure numbers and role titles
    // are FACTS, not skills. Planting them fabricates the candidate's
    // record. They stay visible as gaps (notIntegrable) instead.
    const blockedClaims = allMissingRaw.filter((k) => isUnsupportedClaim(k));
    const afterClaims = allMissingRaw.filter((k) => !isUnsupportedClaim(k));

    // User-controlled tailoring: when an explicit selection is provided
    // (Manual JD), only the selected missing items are incorporated and
    // anything not selected is explicitly skipped. Without a selection
    // (job-card Tailor / Re-Tailor), only GENERIC wording is integrated —
    // named tools stay as honest gaps.
    const hasSelection = Array.isArray(opts?.includeSkills) && opts.includeSkills.length > 0;
    const allowList = (opts?.includeSkills || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allowedSet = new Set(allowList);
    // AUTO-ADD (product owner's setting): clicking Tailor integrates EVERY
    // non-blocked JD term — named tools included — with no manual consent.
    // The hard integrity gate (credentials / tenure / titles) still applies
    // absolutely: blockedClaims are never offered, never leaked, never kept.
    const selectedList = hasSelection ? afterClaims.filter((s) => allowedSet.has(s.toLowerCase())) : afterClaims;
    const excludedList = hasSelection ? afterClaims.filter((s) => !allowedSet.has(s.toLowerCase())) : [];
    const gapClaims = [...blockedClaims, ...(hasSelection ? excludedList : [])];
    const selectedLower = new Set(selectedList.map((s) => s.toLowerCase()));
    // Leak enforcement: terms NOT selected must never appear (relevant only
    // when the user explicitly restricted the selection).
    const namedMustNotAppear = (hasSelection ? afterClaims.filter((t) => isNamedTechTerm(t)) : []).filter(
      (t) => !selectedLower.has(t.toLowerCase())
    );

    const missingKeywordsStr = selectedList.length > 0
      ? selectedList.map((k) => `  - ${k}`).join('\n')
      : '  (none selected)';

    const basePrompt = `You are an elite Executive Resume Writer and ATS Optimization Specialist.

STRICT RULES:
- NEVER fabricate companies, dates, degrees, or work experience.
- NEVER claim certifications, licenses, years-of-experience numbers or job titles the candidate's CV does not state. Those are honest gaps the user can fill themselves — they are NOT keyword slots.
- The candidate's actual job title ("${candidateTitle}") MUST remain exactly as stated.
- You MUST REWRITE every experience bullet: no bullet may be returned word-for-word identical to the source. Rephrase it to sound natural AND weave in the missing keywords that fit it.
- You MUST REWRITE the professionalSummary so it differs from the source summary and weaves in up to 3 of the most relevant missing keywords that genuinely match the candidate's experience — never invent claims the CV does not support.

IMPACT & ACCURACY RULES (recruiters scan your resume for 6-7 seconds):
- Every rewritten bullet MUST keep EVERY number, percentage, currency amount and named tool from its source bullet EXACTLY (e.g. "70%" stays "70%", "$2M" stays "$2M"). NEVER invent a number the source does not contain.
- Lead each bullet with a strong action verb and frame the OUTCOME ("did X, which delivered Y") using only facts already present in the source bullet. "What changed because you did this?" — that is the test every bullet must pass.
- The professionalSummary MUST be 2-3 lines (35-60 words): who the candidate is (seniority + years), 1-2 REAL quantified achievements already present in the CV, and why they fit THIS role.
- When the job description names a specific tool or technology, use the job description's EXACT phrasing (never a synonym).
- The job description mentions MANY tools, technologies and certifications the candidate may not have. The ONLY keywords you may introduce are the ones listed below. Every other tool/technology/credential/number-of-years in the JD is FORBIDDEN in your output.
- ${selectedList.length > 0
      ? `INCORPORATE ONLY these selected missing keywords: ${selectedList.join(', ')} — DO NOT add or mention any other missing keyword.`
      : 'DO NOT add or mention ANY missing keyword — none are approved for this resume. Reword the candidate\'s own experience only.'}
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
${JSON.stringify((masterCv.certifications || []).map((c) => typeof c === 'string' ? c : c.name + (c.issuer ? ' (' + c.issuer + ')' : '')), null, 2)}

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

    // ---- Rewrite enforcement: an LLM that echoes the source is NOT a
    // tailor. Retry once with a sharper instruction; if the output still
    // contains none of the genuinely-missing keywords and no bullet changed,
    // fail closed (the route surfaces this as a clean alert) — never persist
    // an "identical" resume with an inflated score.
    const sourceBullets = (masterCv.experiences || []).flatMap((e) => e.responsibilities || []);
    const outputHasGain = (parsed: any) => {
      if (selectedList.length === 0) return true; // nothing genuinely missing -> nothing to gain
      const expText = (parsed.workExperience || []).flatMap((w) => w.highlights || []).join(' ');
      const skillsText = [
        ...(parsed.coreCompetencies || []),
        ...(parsed.technicalSkills || []).flatMap((t: any) => t.skills || []),
      ].join(' ');
      const summaryText = String(parsed.professionalSummary || '');
      return selectedList.some((kw) => containsKeyword(expText + ' ' + skillsText + ' ' + summaryText, kw));
    };
    const summaryChanged = (parsed: any) =>
      String(parsed.professionalSummary || '').trim() !== String(masterCv.summary || '').trim();
    const bulletsActuallyChanged = (parsed: any) => {
      const out = (parsed.workExperience || []).flatMap((w) => w.highlights || []);
      if (out.length === 0) return false;
      return out.some((h: string, i: number) => {
        const src = sourceBullets[i];
        return src === undefined || String(h).trim() !== String(src).trim();
      });
    };

    // ---- Metric preservation (deterministic, honest): a rewrite must never
    // DROP a real number from the candidate's bullets. Numbers may be
    // rephrased around, but the values themselves must survive verbatim.
    const sourceMetricTokens = extractNumericTokens(sourceBullets.join(' '));
    const droppedMetrics = (p: any): string[] => {
      const outText = (p.workExperience || []).flatMap((w: any) => w.highlights || []).join(' ');
      const outTokens = new Set(extractNumericTokens(outText));
      return sourceMetricTokens.filter((t) => !outTokens.has(t));
    };

    let parsed: any;
    let retried = false;
    let dropped: string[] = [];
    let claimsLeak: string[] = [];
    let namedLeak: string[] = [];
    for (let attempt = 0; attempt <= 2; attempt++) {
      const keywordRetry = attempt > 0 && selectedList.length > 0
        ? `\n- No genuinely-missing keyword (${selectedList.join(', ')}) appears anywhere in the output, and/or every bullet was returned unchanged.
- You MUST rewrite the bullets so the keywords above appear inside them (or in skills), and the bullet text must differ from the source.`
        : '';
      const metricRetry = attempt > 0 && dropped.length > 0
        ? `\n- Your previous rewrite DROPPED these real numbers from the candidate's bullets: ${dropped.join(', ')}. Every number that exists in a source bullet MUST survive the rewrite EXACTLY (same value, same unit). Restore them inside the rewritten bullets.`
        : '';
      const claimsRetry = attempt > 0 && claimsLeak.length > 0
        ? `\n- Your previous rewrite CLAIMED facts the candidate's CV does not contain: ${claimsLeak.join(', ')}. Certifications, licenses, years-of-experience numbers and job titles are NOT skills — REMOVE every one of them from the summary, skills and bullets. They are honest gaps, not to be filled.`
        : '';
      const namedRetry = attempt > 0 && namedLeak.length > 0
        ? `\n- Your previous rewrite added tools/technologies the candidate NEVER listed and that were NOT selected: ${namedLeak.join(', ')}. REMOVE them completely — mention only the candidate's own tools and the approved keywords. An ATS cannot be satisfied by claiming skills the candidate does not have.`
        : '';
      const prompt = attempt === 0 ? basePrompt : `${basePrompt}

RETRY — your previous resume was rejected:
${keywordRetry}${metricRetry}${claimsRetry}${namedRetry}
- Return the corrected JSON between the markers.`;
      parsed = await askJson<any>(prompt, { temperature: 0.2 });
      dropped = droppedMetrics(parsed);
      claimsLeak = unsupportedClaimLeaks(parsed, masterText);
      namedLeak = namedTermLeaks(parsed, namedMustNotAppear);
      const gainOk = selectedList.length === 0 || outputHasGain(parsed);
      const rewriteOk = selectedList.length === 0 || bulletsActuallyChanged(parsed) || summaryChanged(parsed);
      if (gainOk && rewriteOk && dropped.length === 0 && claimsLeak.length === 0 && namedLeak.length === 0) break;
      retried = attempt === 0;
    }
    // Skill-list hygiene: the auto-add can flood one category with generic
    // terms (real report: 'DevOps & Delivery Practices' with 27 items — a
    // keyword wall). Cap per-category items and the flat competencies list —
    // but PRIORITIZE the JD keywords first so capping can never silently cut
    // a verified requirement; verification below counts only what survives.
    const selectedLowerSet = new Set(selectedList.map((t: string) => String(t).toLowerCase()));
    const jdFirst = (items: unknown[]): unknown[] =>
      items
        .map((v, idx) => ({ v, idx, jd: selectedLowerSet.has(String(v).toLowerCase()) ? 1 : 0 }))
        .sort((a, b) => b.jd - a.jd || a.idx - b.idx)
        .map((x) => x.v);
    if (Array.isArray(parsed.coreCompetencies) && parsed.coreCompetencies.length > 16) {
      parsed.coreCompetencies = jdFirst(parsed.coreCompetencies).slice(0, 16);
    }
    if (Array.isArray(parsed.technicalSkills)) {
      parsed.technicalSkills = parsed.technicalSkills.map((g: any) => ({
        ...g,
        skills: Array.isArray(g.skills) && g.skills.length > 12 ? jdFirst(g.skills).slice(0, 12) : (g.skills || []),
      }));
    }

    // ── Deterministic AUTO-REPAIR (integrity-preserving, never inventing) ──
    // If the retries still leaked unsupported claims/tools, REMOVE the leaked
    // items from the skills sections and REVERT the affected bullets/summary
    // to the candidate's own master text. Nothing untrue is ever published —
    // but the tailor succeeds instead of failing closed (the retry-level
    // failure that surfaced as 422s in production).
    const repairNotes: string[] = [];
    const leakedAll = [...new Set([...claimsLeak, ...namedLeak])];
    if (leakedAll.length) {
      const isLeak = (v: unknown) => leakedAll.some((t) => containsKeyword(String(v || ''), t));
      const countSkills = () =>
        (parsed.coreCompetencies || []).length +
        (parsed.technicalSkills || []).reduce((n: number, g: any) => n + (g.skills || []).length, 0);
      const skillsBefore = countSkills();
      parsed.coreCompetencies = (parsed.coreCompetencies || []).filter((x: any) => !isLeak(x));
      parsed.technicalSkills = (parsed.technicalSkills || [])
        .filter((g: any) => !isLeak(g?.category))
        .map((g: any) => ({ ...g, skills: (g.skills || []).filter((x: any) => !isLeak(x)) }));
      let revertedBullets = 0;
      parsed.workExperience = (parsed.workExperience || []).map((w: any, ei: number) => {
        const src = masterCv.experiences?.[ei]?.responsibilities || [];
        return {
          ...w,
          highlights: (w.highlights || []).map((h: any, hi: number) => {
            if (isLeak(h) && typeof src[hi] === 'string' && String(src[hi]).trim()) {
              revertedBullets++;
              return src[hi];
            }
            return h;
          }),
        };
      });
      if (isLeak(parsed.professionalSummary)) parsed.professionalSummary = masterCv.summary || '';
      // Re-scan: the repair is verified like everything else.
      claimsLeak = unsupportedClaimLeaks(parsed, masterText);
      namedLeak = namedTermLeaks(parsed, namedMustNotAppear);
      if (!claimsLeak.length && !namedLeak.length) {
        const removedSkills = skillsBefore - countSkills();
        repairNotes.push(
          `Auto-corrected ${leakedAll.length} unsupported mention(s) (${leakedAll.slice(0, 4).join(', ')}) — removed ${removedSkills} skill(s)` +
            (revertedBullets ? ` and reverted ${revertedBullets} bullet(s) to your original wording` : '') +
            '; nothing untrue was kept.'
        );
      }
    }
    if (claimsLeak.length > 0) {
      throw new TailorVerificationFailedError(
        `The tailoring pass tried to claim credentials, experience years or titles that are not in your CV (${claimsLeak.slice(0, 4).join(', ')}). It was stopped so nothing untrue is published — add real certifications to your Master CV, or try again.`
      );
    }
    if (namedLeak.length > 0) {
      throw new TailorVerificationFailedError(
        `The tailoring pass tried to add tools the candidate never listed (${namedLeak.slice(0, 4).join(', ')}). It was stopped so nothing untrue is published — add them to your Master CV if you genuinely use them, or select them in Manual JD to opt in.`
      );
    }
    if (selectedList.length > 0 && (!outputHasGain(parsed) || (!bulletsActuallyChanged(parsed) && !summaryChanged(parsed)))) {
      throw new TailorVerificationFailedError(
        'The tailoring pass did not change your resume — the AI returned the same bullet points without adding the missing keywords. Please try again.'
      );
    }
    void retried;

    const beforeScore = job.matchScore || job.gapAnalysis?.matchScore || 50;

    // HEADLINE: the professional title under the candidate's name is a
    // POSITIONING statement — it matches the role being applied for. The
    // employment-history titles below stay factual (enforced right after):
    // changing them would falsify the record and contradict LinkedIn.
    const headlineTitle = (() => {
      const t = String(job.title || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
      return t ? t.slice(0, 80) : candidateTitle;
    })();

    // EMPLOYMENT TITLES: deterministic guard — each role keeps the EXACT
    // title from the Master CV, whatever the model returned.
    if (Array.isArray(parsed.workExperience)) {
      parsed.workExperience = parsed.workExperience.map((w: any, ei: number) => ({
        ...w,
        title: masterCv.experiences?.[ei]?.title || w?.title,
        company: masterCv.experiences?.[ei]?.company || w?.company,
      }));
    }

    // ---- Honest verification with the symbol-aware matcher ----
    const expText = (parsed.workExperience || []).flatMap((w: any) => w.highlights || []).join(' ').toLowerCase();
    const skillsText = [
      ...(parsed.coreCompetencies || []),
      ...(parsed.technicalSkills || []).flatMap((t: any) => t.skills || []),
    ].join(' ').toLowerCase();

    // Score moves ONLY from keywords that are genuinely missing from the
    // master CV AND genuinely present in the tailored output.
    const summaryText = String(parsed.professionalSummary || '');
    const verifiedInExperience = selectedList.filter((kw: string) => containsKeyword(expText, kw));
    const verifiedInSummary = selectedList.filter((kw: string) => containsKeyword(summaryText, kw));
    const verifiedInSkills = selectedList.filter((kw: string) => containsKeyword(skillsText, kw));
    const verifiedAll = [...new Set([...verifiedInExperience, ...verifiedInSummary, ...verifiedInSkills])];

    // Credential/tenure/title terms and unselected named tools are honest
    // GAPS: never integrated, but counted and surfaced so the user can learn,
    // earn or explicitly opt in to them for real.
    const notIntegrable = [
      ...selectedList.filter((kw: string) => !verifiedAll.includes(kw)),
      ...gapClaims.filter((c) => !selectedLower.has(c.toLowerCase())),
    ];

    const totalMissing = selectedList.length || 1;
    const expWeight = verifiedInExperience.length;
    const summaryWeight = verifiedInSummary.length * 0.5;
    const skillsWeight = verifiedInSkills.length * 0.5;
    const weightedFill = totalMissing > 0 ? (expWeight + summaryWeight + skillsWeight) / totalMissing : 0;
    const weightedFillCapped = Math.min(weightedFill, 0.95);
    const afterScore = totalMissing === 0
      ? beforeScore
      : Math.round(beforeScore + weightedFillCapped * (100 - beforeScore));
    const scoreBoost = afterScore - beforeScore;

    const rephrasedCount = (parsed.workExperience || []).reduce(
      (acc: number, item: any) => acc + (item.highlights?.length || 0), 0
    );

    // ---- Deterministic impact audit (recruiter 7-second scan) ----
    const outBullets = (parsed.workExperience || []).flatMap((w: any) => w.highlights || []);
    const quantifiedCount = outBullets.filter((h: string) => extractDraftNumbers(String(h)).length > 0).length;
    const impactAudit = {
      bullets: outBullets.length,
      quantified: quantifiedCount,
      quantifiedPct: outBullets.length > 0 ? Math.round((quantifiedCount / outBullets.length) * 100) : 0,
      metricDropped: dropped,
    };

    const auditNotes = [
      `Professional headline set to "${headlineTitle}" for this application; employment history keeps your actual titles${headlineTitle !== candidateTitle ? ` (current role: "${candidateTitle}")` : ''}.`,
      selectedList.length === 0
        ? 'Nothing was missing: every job-description keyword was already in the master CV, so the resume was returned unchanged (no score boost).'
        : `Integrated ${verifiedAll.length} genuinely-missing keywords (${verifiedInExperience.length} in experience bullets, ${verifiedInSummary.length} in the summary, ${verifiedInSkills.length} in skills).`,
      `Rewrote ${rephrasedCount} bullet points to naturally incorporate target keywords.`,
      ...repairNotes,
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
      targetRole: headlineTitle,
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
          skills: job.gapAnalysis?.missingSkills ?? [],
          keywords: job.gapAnalysis?.missingKeywords ?? [],
        },
        addedAfter: {
          keywordsIncorporated: verifiedAll,
          keywordsInExperience: verifiedInExperience,
          keywordsInSummary: verifiedInSummary,
          keywordsInSkills: verifiedInSkills,
          rephrasedHighlightsCount: rephrasedCount,
          // Honest: only the genuinely-missing keywords that actually appear
          // in the resulting CV (never a wholesale echo of the gap list).
          skillsAdded: verifiedInSkills,
        },
        notIntegrable,
        auditNotes,
        impactAudit,
      },
    };
  }
}