// Generic query-aware deterministic relevance engine.
//
// One engine for ANY query — no hard-coded profession profiles. The query is
// parsed into a QueryProfile (role phrase + specialization tokens +
// seniority), then every candidate title is scored by token overlap.
//
// Principles:
//   * Indexing is neutral — relevance happens at QUERY time.
//   * Specialization match matters MORE than a generic role word
//     ("Data Engineer" and "DevOps Engineer" share "Engineer" but are not
//     related; "Credit Operations Analyst" never qualifies as DevOps).
//   * Unknown queries (e.g. "Blockchain Engineer") work through the same
//     generic matching — no predefined category required.
//   * A small ROLE_RELATIONSHIPS map ENHANCES known domains (DevOps↔SRE,
//     Security↔AppSec…) but is never required for a query to work.
//   * Safe abbreviation expansion (SRE → site reliability, ML → machine
//     learning) is applied identically to queries AND titles.
//   * No LLM, no live calls — pure local deterministic computation.
//
// Tiers (kept for the existing rank/orchestrator ordering contract):
//   exact 100 > strong_related 90 > related 70 > weak_related 50 > irrelevant 0

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

// Explicit exclusions — titles containing these are ALWAYS irrelevant, no
// matter which other signals they carry. "data entry" is clerical work, never
// an engineering role.
const EXCLUSIONS = /\b(account executive|product manager|sales|marketing|recruiter|customer success|account manager|business development|director|vp|head of|data entry)\b/i;

// Generic role words — weak signals by themselves; they never qualify a job
// without a specialization token.
const GENERIC_ROLE_WORDS = /\b(engineer|engineering|developer|architect|administrator|admin|analyst|technician|specialist|scientist|lead|consultant|manager)\b/i;

// Seniority / modifier tokens — stripped from the exact-match phrase, matched
// against the title for near-exact credit.
const SENIORITY_WORDS = /\b(senior|staff|principal|lead|junior|mid|associate|entry|intern|head|chief|sr|jr)\b/i;

// Safe abbreviation expansions — applied to queries AND titles so "ML
// Engineer" ↔ "Machine Learning Engineer" both match. Only standalone tokens
// are expanded; expansions are never ambiguous in a tech-job context.
const ABBREVIATIONS: Record<string, string> = {
  sre: 'site reliability',
  ml: 'machine learning',
  ai: 'artificial intelligence',
  qa: 'quality assurance',
  ui: 'user interface',
  infosec: 'information security',
};

// Optional domain relationship knowledge — ENHANCES related matching for
// known specializations. Never required for an unknown query to work.
//   strong: near-synonyms that pair with a role word → strong_related
//   related: clearly-related roles → related
export interface RelationshipEntry {
  strong: string[];
  related: string[];
}

export const ROLE_RELATIONSHIPS: Record<string, RelationshipEntry> = {
  devops: {
    strong: ['devsecops', 'sre', 'site reliability', 'cloud infrastructure', 'gitops'],
    related: ['platform', 'infrastructure', 'systems', 'release', 'kubernetes', 'terraform', 'cloud'],
  },
  cybersecurity: {
    strong: ['application security', 'cloud security', 'network security', 'infosec', 'appsec', 'penetration'],
    related: ['soc', 'threat', 'identity', 'iam', 'devsecops'],
  },
  machine_learning: {
    strong: ['mlops', 'applied ai', 'deep learning', 'genai', 'machine learning'],
    related: ['nlp', 'llm', 'data science'],
  },
  frontend: {
    strong: ['ui', 'web'],
    related: ['react', 'angular', 'vue', 'typescript', 'javascript'],
  },
  data_engineering: {
    strong: ['etl', 'pipeline', 'data infrastructure'],
    related: ['warehouse', 'analytics', 'big data', 'sql', 'database'],
  },
  backend: {
    strong: ['server-side', 'microservices', 'distributed systems'],
    related: ['api', 'node'],
  },
  mobile: {
    strong: ['ios', 'android', 'react native', 'flutter'],
    related: ['swift', 'kotlin'],
  },
  qa: {
    strong: ['test automation', 'sdet', 'quality assurance'],
    related: ['test', 'testing', 'automation'],
  },
};

// Abbreviation → relationship-map key aliases.
const KEY_ALIASES: Record<string, string> = {
  ai: 'machine_learning',
  ml: 'machine_learning',
  sre: 'devops',
  qa: 'qa',
  ui: 'frontend',
  web: 'frontend',
  infosec: 'cybersecurity',
  appsec: 'cybersecurity',
};

export interface QueryProfile {
  originalQuery: string;
  normalizedQuery: string;
  roleTerms: string[];            // full role phrases from the query
  specializationTerms: string[];  // meaningful non-role, non-seniority tokens
  seniorityTerms: string[];       // seniority/modifier tokens
  strongSignals: string[];        // relationship near-synonyms (map)
  relatedSignals: string[];       // relationship clearly-related (map)
}

export function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Expand safe abbreviations in a normalized text (standalone tokens only). */
export function expandAbbreviations(text: string): string {
  const words = text.split(' ');
  const out: string[] = [];
  for (const w of words) {
    const exp = ABBREVIATIONS[w];
    if (exp) out.push(...exp.split(' '));
    else out.push(w);
  }
  return out.join(' ');
}

function compactKey(s: string): string {
  return s.replace(/[\s_]+/g, '').toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary phrase match — "ai" must not match "train", "test" must not match "latest". */
function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return new RegExp(`\\b${escapeRe(phrase)}\\b`).test(text);
}

/** Find the relationship-map key for a specialization, if any. */
function relationshipKey(specialization: string[]): string | undefined {
  if (specialization.length === 0) return undefined;
  const keys = Object.keys(ROLE_RELATIONSHIPS);
  const compacted = keys.map((k) => ({ k, c: compactKey(k) }));
  const joined = compactKey(specialization.join(' '));
  const match = compacted.find(({ c }) => c === joined || c.startsWith(joined) || joined.startsWith(c));
  if (match) return match.k;
  for (const token of specialization) {
    const alias = KEY_ALIASES[token];
    if (alias) return alias;
    const t = compactKey(token);
    const tm = compacted.find(({ c }) => c === t || c.startsWith(t) || t.startsWith(c));
    if (tm) return tm.k;
  }
  return undefined;
}

/**
 * Parse any query into a QueryProfile. Derived FROM THE QUERY — no global
 * profession assumptions.
 */
export function parseQuery(query: string): QueryProfile {
  const normalized = normalizeText(query);
  const expanded = expandAbbreviations(normalized);
  const words = normalized.split(' ').filter(Boolean);
  const seniority = words.filter((w) => SENIORITY_WORDS.test(w));
  const senSet = new Set(seniority);

  // Specialization = every meaningful query token (raw + expanded) minus
  // seniority words and generic role words.
  const specSet = new Set<string>();
  for (const w of [...words, ...expanded.split(' ')]) {
    if (!senSet.has(w) && !GENERIC_ROLE_WORDS.test(w) && w.length > 1) {
      specSet.add(w);
    }
  }
  const specialization = [...specSet];

  const key = relationshipKey(specialization);
  const rel = key ? ROLE_RELATIONSHIPS[key] : undefined;

  return {
    originalQuery: String(query || '').trim(),
    normalizedQuery: normalized,
    roleTerms: [],
    specializationTerms: specialization,
    seniorityTerms: seniority,
    strongSignals: rel ? rel.strong : [],
    relatedSignals: rel ? rel.related : [],
  };
}

function collectSignals(terms: string[], tRaw: string, tExp: string): string[] {
  const found: string[] = [];
  for (const term of terms) {
    if (term && (containsPhrase(tRaw, term) || containsPhrase(tExp, term)) && !found.includes(term)) found.push(term);
  }
  return found.slice(0, 8);
}

/**
 * Generic deterministic scorer.
 *   exact          100  full query phrase (minus seniority) present in title,
 *                       or identical title via abbreviation expansion
 *   strong_related 90   specialization + role word, or strong synonym + role word
 *   related        70   specialization only, or related synonym (+ role word)
 *   weak_related   50   partial specialization, or bare generic query
 *   irrelevant      0   no signal / exclusion
 */
export function evaluateRelevance(query: string, text: string): RelevanceResult {
  const q = String(query || '').trim();
  const rawTitle = String(text || '');
  if (!q) return { relevanceScore: TIER_WEIGHT.related, matchType: 'related', matchedSignals: [], excludedSignals: [] };

  // 1. Explicit exclusions win over everything.
  if (EXCLUSIONS.test(rawTitle)) {
    const normalized = normalizeText(rawTitle);
    return {
      relevanceScore: IRRELEVANT_SCORE,
      matchType: 'irrelevant',
      matchedSignals: [],
      excludedSignals: collectSignals(['account executive', 'product manager', 'sales', 'marketing', 'recruiter', 'customer success'], normalized, normalized),
    };
  }

  const tRaw = normalizeText(rawTitle);
  const tExp = expandAbbreviations(tRaw);
  const profile = parseQuery(q);
  const hasRoleWord = GENERIC_ROLE_WORDS.test(tRaw) || GENERIC_ROLE_WORDS.test(tExp);

  // 2. Exact / near-exact: the full query phrase (minus seniority) appears in
  //    the title — raw or abbreviation-expanded on BOTH sides. This is
  //    generic: "Software Engineer"↔"Senior Software Engineer",
  //    "ML Engineer"↔"Machine Learning Engineer", "Cassandra Administrator"
  //    all resolve without any role-specific rule.
  const queryCore = profile.normalizedQuery.split(' ').filter((w) => !new Set(profile.seniorityTerms).has(w)).join(' ');
  const queryCoreExp = expandAbbreviations(queryCore);
  if (
    tRaw.includes(queryCore) ||
    tExp.includes(queryCore) ||
    tRaw.includes(queryCoreExp) ||
    tExp.includes(queryCoreExp)
  ) {
    const seniorityGap =
      profile.seniorityTerms.length > 0 &&
      !profile.seniorityTerms.some((s) => tRaw.includes(s) || tExp.includes(s));
    return {
      relevanceScore: seniorityGap ? 95 : TIER_WEIGHT.exact,
      matchType: 'exact',
      matchedSignals: [queryCore],
      excludedSignals: [],
    };
  }

  // 3. Specialization matching — the core of the engine. Specialization
  //    counts more than the generic role word.
  const spec = profile.specializationTerms;
  if (spec.length > 0) {
    const present = spec.filter((s) => containsPhrase(tRaw, s) || containsPhrase(tExp, s));
    const full = present.length === spec.length;
    if (full && hasRoleWord) {
      return { relevanceScore: TIER_WEIGHT.strong_related, matchType: 'strong_related', matchedSignals: present, excludedSignals: [] };
    }
    if (full) {
      return { relevanceScore: TIER_WEIGHT.related, matchType: 'related', matchedSignals: present, excludedSignals: [] };
    }
    if (present.length > 0 && hasRoleWord) {
      return { relevanceScore: TIER_WEIGHT.related, matchType: 'related', matchedSignals: present, excludedSignals: [] };
    }
    if (present.length > 0) {
      return { relevanceScore: TIER_WEIGHT.weak_related, matchType: 'weak_related', matchedSignals: present, excludedSignals: [] };
    }
  }

  // 4. Domain relationship knowledge (enhancement only).
  const strongRel = profile.strongSignals.filter((s) => containsPhrase(tRaw, s) || containsPhrase(tExp, s));
  if (strongRel.length > 0) {
    return {
      relevanceScore: hasRoleWord ? TIER_WEIGHT.strong_related : TIER_WEIGHT.related,
      matchType: hasRoleWord ? 'strong_related' : 'related',
      matchedSignals: strongRel,
      excludedSignals: [],
    };
  }
  const relSig = profile.relatedSignals.filter((s) => containsPhrase(tRaw, s) || containsPhrase(tExp, s));
  if (relSig.length > 0) {
    return {
      relevanceScore: hasRoleWord ? TIER_WEIGHT.related : TIER_WEIGHT.weak_related,
      matchType: hasRoleWord ? 'related' : 'weak_related',
      matchedSignals: relSig,
      excludedSignals: [],
    };
  }

  // 5. Bare generic query (e.g. just "Engineer"): a role word in the title is
  //    a defensible weak match; no specialization is claimed.
  if (spec.length === 0 && hasRoleWord) {
    return { relevanceScore: TIER_WEIGHT.weak_related, matchType: 'weak_related', matchedSignals: ['role word'], excludedSignals: [] };
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

/**
 * The V1 relevance guard. UNCONDITIONAL: when the query yields zero relevant
 * jobs, the result is [] — a fully-irrelevant slice must never survive into
 * persistence.
 */
export function applyRelevanceGuard<T extends { title?: string; company?: string }>(
  jobs: T[],
  query: string
): T[] {
  const q = String(query || '').trim();
  if (!q) return jobs;
  return jobs.filter((j) => isRelevantJob(q, `${j.title || ''} ${j.company || ''}`));
}

/** Back-compat for the existing test surface. */
export function isDevOpsAdjacent(text: string): boolean {
  return relevanceScore('devops', text) > 0;
}

/** Back-compat: profile id for a query (relationship key or 'generic'). */
export function selectProfile(query: string): { id: string } {
  const p = parseQuery(query);
  const key = relationshipKey(p.specializationTerms);
  return { id: key || 'generic' };
}

export function queryProfiles(): string[] {
  return Object.keys(ROLE_RELATIONSHIPS);
}