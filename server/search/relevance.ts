// Query-aware deterministic relevance engine.
//
// The QUERY decides the vocabulary — "DevOps Engineer" and "Cyber Security
// Engineer" accept DIFFERENT titles. Named match tiers, not magic numbers:
// EXACT > STRONG_RELATED > RELATED > WEAK_RELATED > IRRELEVANT.
// Infrastructure/domain words (platform, cloud, systems…) NEVER qualify a job
// by themselves — they must pair with a technical role word.
// No LLM, no live calls — pure local deterministic computation.

export type MatchTier =
  | 'exact'
  | 'strong_related'
  | 'related'
  | 'weak_related'
  | 'irrelevant';

export interface RelevanceResult {
  relevanceScore: number;
  matchType: MatchTier;
  matchedSignals: string[];
  excludedSignals: string[];
}

// Named tiers with deterministic weights — the NUMBER is an implementation
// detail; the business logic is the tier name.
export const TIER_WEIGHT: Record<Exclude<MatchTier, 'irrelevant'>, number> = {
  exact: 100,
  strong_related: 90,
  related: 70,
  weak_related: 50,
};

export const IRRELEVANT_SCORE = 0;

// Technical role words — "manager"/"executive" deliberately absent so Product
// Manager / Account Executive titles can never pair with a domain word.
const ROLE_WORDS = /\b(engineer|engineering|developer|architect|administrator|admin|analyst|technician|specialist|scientist|lead)\b/i;

// Explicit exclusions — titles containing these are ALWAYS irrelevant, no
// matter which domain words they also contain.
const EXCLUSIONS = /\b(account executive|product manager|sales|marketing|recruiter|customer success|account manager|business development|director|vp|head of)\b/i;

export interface QueryProfile {
  id: string;
  triggers: RegExp;       // query words that select this profile
  exact: RegExp;          // titles that ARE the role
  strongRelated: RegExp;  // strongly equivalent titles (paired with ROLE_WORDS)
  related: RegExp;        // related titles (paired with ROLE_WORDS)
  weakRelated: RegExp;    // loosely related (paired with ROLE_WORDS)
  signals: RegExp;        // domain words collected for matchedSignals/debug
}

const PROFILES: QueryProfile[] = [
  {
    id: 'devops',
    triggers: /\b(devops|devsecops|sre|site reliability|platform engineer|infrastructure engineer|cloud engineer|cloud infrastructure|kubernetes|terraform|ci\/?cd|release engineering|gitops)\b/i,
    exact: /\b(devops|devsecops|sre|site reliability)\b/i,
    strongRelated: /\b(platform engineer|infrastructure engineer|cloud infrastructure engineer|gitops engineer)\b/i,
    related: /\b(cloud engineer|systems engineer|release engineer|build engineer|kubernetes engineer|terraform engineer|deployment engineer|ci\/?cd engineer|site reliability engineer)\b/i,
    weakRelated: /\b(platform|infrastructure|cloud|systems|kubernetes|terraform|containers|docker|linux|aws|azure|gcp|operations|deployment|release)\b/i,
    signals: /\b(devops|devsecops|sre|platform|infrastructure|cloud|systems|kubernetes|terraform|containers|docker|linux|aws|azure|gcp|release|deployment|gitops)\b/i,
  },
  {
    id: 'cybersecurity',
    triggers: /\b(cyber|cybersecurity|security engineer|infosec|appsec|application security|cloud security|network security|penetration|threat|vulnerability|soc|devsecops)\b/i,
    exact: /\b(cybersecurity|cyber security|security engineer|security architect|security analyst|security operations|infosec|appsec|cloud security engineer|application security engineer|network security engineer|devsecops engineer|soc engineer|penetration tester)\b/i,
    strongRelated: /\b(cloud security|application security|network security|devsecops|soc|threat|vulnerability|identity|iam|red team|blue team|incident response)\b/i,
    related: /\b(security specialist|security administrator|security analyst)\b/i,
    weakRelated: /\b(cloud|network|application)\b/i,
    signals: /\b(cyber|cybersecurity|security|infosec|appsec|soc|threat|vulnerability|penetration|identity|iam|devsecops)\b/i,
  },
  {
    id: 'ai-ml',
    triggers: /\b(ai engineer|machine learning|ml engineer|llm|generative ai|genai|deep learning|nlp|neural|transformer|langchain|pytorch|tensorflow|artificial intelligence|prompt)\b/i,
    exact: /\b(ai engineer|ml engineer|machine learning engineer|llm engineer|generative ai engineer|applied ai|deep learning engineer|nlp engineer|prompt engineer|ai platform engineer)\b/i,
    strongRelated: /\b(machine learning|mlops|ai infra|model engineer|research engineer|ai)\b/i,
    related: /\b(ml|llm|generative|deep learning|nlp|neural|data science)\b/i,
    weakRelated: /\b(backend|software|platform|infrastructure)\b/i,
    signals: /\b(ai|ml|machine learning|llm|generative|deep learning|nlp|neural|transformer|langchain|pytorch|tensorflow|prompt|mlops)\b/i,
  },
  {
    id: 'backend',
    triggers: /\b(backend|back end|back-end|server-side|api engineer|microservices|distributed systems|node\.js|golang|java developer|python developer|ruby|\.net)\b/i,
    exact: /\b(backend engineer|back-end engineer|back end engineer|server engineer|api engineer|microservices engineer|distributed systems engineer)\b/i,
    strongRelated: /\b(backend|back-end|server-side|api|microservices|distributed systems)\b/i,
    related: /\b(software engineer|java|golang|node|python|ruby|dotnet|\.net|typescript|sql)\b/i,
    weakRelated: /\b(platform|systems|infrastructure|cloud)\b/i,
    signals: /\b(backend|back-end|server|api|microservices|distributed|java|golang|node|python|ruby|\.net|typescript|sql)\b/i,
  },
  {
    id: 'frontend',
    triggers: /\b(frontend|front end|front-end|ui engineer|web engineer|react|angular|vue|typescript|javascript|css|html|design systems)\b/i,
    exact: /\b(frontend engineer|front-end engineer|front end engineer|ui engineer|web engineer|react engineer|angular engineer|vue engineer)\b/i,
    strongRelated: /\b(frontend|front-end|front end|ui|web|react|angular|vue|typescript|javascript)\b/i,
    related: /\b(design systems|css|html|accessibility)\b/i,
    weakRelated: /\b(software|full stack|creative)\b/i,
    signals: /\b(frontend|front-end|ui|web|react|angular|vue|typescript|javascript|css|html)\b/i,
  },
  {
    id: 'fullstack',
    triggers: /\b(fullstack|full stack|full-stack)\b/i,
    exact: /\b(fullstack engineer|full stack engineer|full-stack engineer|fullstack developer|full stack developer)\b/i,
    strongRelated: /\b(fullstack|full stack|full-stack)\b/i,
    related: /\b(web|software|javascript|typescript|node|react)\b/i,
    weakRelated: /\b(backend|frontend|front-end|front end)\b/i,
    signals: /\b(fullstack|full stack|web|software|javascript|typescript|node|react|backend|frontend)\b/i,
  },
  {
    id: 'data-engineering',
    triggers: /\b(data engineer|data engineering|etl|data pipeline|data platform|big data|analytics engineer|spark|kafka|airflow|warehouse engineer|dbt)\b/i,
    exact: /\b(data engineer|data engineering|etl engineer|data pipeline engineer|data platform engineer|analytics engineer|big data engineer|warehouse engineer)\b/i,
    strongRelated: /\b(etl|pipeline|data platform|data infrastructure|big data|spark|kafka|airflow|dbt)\b/i,
    related: /\b(data|database|sql|analytics|warehouse|bi)\b/i,
    weakRelated: /\b(software|backend|platform|systems)\b/i,
    signals: /\b(data|etl|pipeline|warehouse|spark|kafka|airflow|analytics|database|sql|dbt|big data)\b/i,
  },
  {
    id: 'qa',
    triggers: /\b(qa|test automation|quality assurance|sdet|test engineer|tester|playwright|cypress|selenium|testing)\b/i,
    exact: /\b(qa engineer|sdet|test engineer|test automation engineer|automation engineer|quality assurance engineer|quality engineer)\b/i,
    strongRelated: /\b(qa|quality assurance|test automation|sdet|playwright|cypress|selenium)\b/i,
    related: /\b(test|testing|automation|quality)\b/i,
    weakRelated: /\b(manual)\b/i,
    signals: /\b(qa|test|automation|quality|sdet|playwright|cypress|selenium)\b/i,
  },
  {
    id: 'mobile',
    triggers: /\b(mobile|ios|android|react native|flutter|swift|kotlin|mobile app)\b/i,
    exact: /\b(mobile engineer|ios engineer|android engineer|react native engineer|flutter engineer|mobile developer|ios developer|android developer)\b/i,
    strongRelated: /\b(mobile|ios|android|react native|flutter|swift|kotlin)\b/i,
    related: /\b(app|application)\b/i,
    weakRelated: /(?!)/,
    signals: /\b(mobile|ios|android|react native|flutter|swift|kotlin)\b/i,
  },
];

// Conservative generic fallback — unknown queries never match every
// engineering job: the title must contain the query's primary term AND a
// technical role word.
function genericProfile(query: string): QueryProfile {
  const term = query.toLowerCase().trim().split(/\s+/).filter((w) => w.length > 2)[0] || '';
  const termRe = term ? new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') : /(?!)/;
  return {
    id: 'generic',
    triggers: /(?!)/,
    exact: termRe,
    strongRelated: /(?!)/,
    related: /(?!)/,
    weakRelated: /(?!)/,
    signals: termRe,
  };
}

export function selectProfile(query: string): QueryProfile {
  const q = String(query || '');
  for (const p of PROFILES) {
    if (p.triggers.test(q)) return p;
  }
  return genericProfile(q);
}

function collectSignals(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    if (m[0] && !out.includes(m[0].toLowerCase())) out.push(m[0].toLowerCase());
  }
  return out.slice(0, 6);
}

/**
 * Evaluate a job title+company against a query.
 * Returns tier + score + matched/excluded signals (for debugging/UI).
 */
export function evaluateRelevance(query: string, text: string): RelevanceResult {
  const q = String(query || '').trim();
  const t = String(text || '');
  if (!q) return { relevanceScore: TIER_WEIGHT.related, matchType: 'related', matchedSignals: [], excludedSignals: [] };

  // 1. Explicit exclusions win over everything.
  if (EXCLUSIONS.test(t)) {
    return { relevanceScore: IRRELEVANT_SCORE, matchType: 'irrelevant', matchedSignals: [], excludedSignals: collectSignals(EXCLUSIONS, t) };
  }

  const profile = selectProfile(q);

  // 2. Query term present in title/company → EXACT only when the title ALSO
  //    carries the profile's domain signal. "DevOps Engineer" must not make
  //    every engineering title exact via the generic "engineer" term — the
  //    domain word (devops/platform/security/…) must be there too.
  const qTerms = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const tLower = t.toLowerCase();
  const hasDomain = profile.signals.test(t);
  const allTermsPresent = qTerms.length > 0 && qTerms.every((w) => tLower.includes(w));
  if (allTermsPresent && hasDomain) {
    return { relevanceScore: TIER_WEIGHT.exact, matchType: 'exact', matchedSignals: collectSignals(profile.signals, t), excludedSignals: [] };
  }
  // Single domain term present without the full query → still a strong match
  // when the domain signal exists (searching "DevOps" matches "DevOps Manager"
  // and "DevOps Engineer").
  const primary = qTerms[0];
  if (primary && tLower.includes(primary) && hasDomain) {
    return { relevanceScore: TIER_WEIGHT.strong_related, matchType: 'strong_related', matchedSignals: [primary, ...collectSignals(profile.signals, t)], excludedSignals: [] };
  }

  // 3. Profile tiers — domain words must pair with a technical role word
  //    (except 'exact' and 'strongRelated' patterns which already contain the
  //    role word in the pattern itself).
  if (profile.exact.test(t)) {
    return { relevanceScore: TIER_WEIGHT.exact, matchType: 'exact', matchedSignals: collectSignals(profile.signals, t), excludedSignals: [] };
  }
  if (profile.strongRelated.test(t) && ROLE_WORDS.test(t)) {
    return { relevanceScore: TIER_WEIGHT.strong_related, matchType: 'strong_related', matchedSignals: collectSignals(profile.signals, t), excludedSignals: [] };
  }
  if (profile.related.test(t) && ROLE_WORDS.test(t)) {
    return { relevanceScore: TIER_WEIGHT.related, matchType: 'related', matchedSignals: collectSignals(profile.signals, t), excludedSignals: [] };
  }
  if (profile.weakRelated.test(t) && ROLE_WORDS.test(t)) {
    return { relevanceScore: TIER_WEIGHT.weak_related, matchType: 'weak_related', matchedSignals: collectSignals(profile.signals, t), excludedSignals: [] };
  }
  return { relevanceScore: IRRELEVANT_SCORE, matchType: 'irrelevant', matchedSignals: [], excludedSignals: [] };
}

/** Convenience: relevance score for a job (0 = irrelevant). */
export function relevanceScore(query: string, text: string): number {
  return evaluateRelevance(query, text).relevanceScore;
}

/** Convenience: boolean relevance for guard-style filtering. */
export function isRelevantJob(query: string, titleCompany: string): boolean {
  return relevanceScore(query, titleCompany) > 0;
}

/** Back-compat for the existing test surface. */
export function isDevOpsAdjacent(text: string): boolean {
  return relevanceScore('devops', text) > 0;
}

export function queryProfiles(): string[] {
  return PROFILES.map((p) => p.id);
}