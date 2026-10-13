// Question-INTENT harness — the "generic questions" layer for auto-fill.
//
// Every observed form question is classified into a canonical intent BEFORE
// any value resolution. The intent carries the decision policy:
//   - entity: WHO the question is about. Only SELF questions may ever be
//     answered with the applicant's own identity (name/email/phone/…); a
//     referrer/emergency/spouse/manager question can NEVER receive the
//     applicant's name (the "Who is actually referring? → own name" bug).
//   - exactOnly: questions that may only be answered by an EXACT previously
//     stored answer for that same question (conditional follow-ups such as
//     "If yes, where in the US do you live?", EEO, citizenship/clearance) —
//     never from generic concept/prefix/fuzzy matching.
//   - sensitive: EEO/legal topics — never auto-filled by generic engines.
//   - canonicalKeys: the bank keys a non-SELF intent may legitimately reuse
//     (e.g. a referrer NAME answer reused across referral forms).

export type IntentEntity = 'SELF' | 'REFERRER' | 'EMERGENCY' | 'SPOUSE' | 'RELATIVE' | 'MANAGER' | 'REFERENCE';

export interface QuestionIntent {
  id: string;
  category: string;
  entity: IntentEntity;
  conditional: boolean;
  exactOnly: boolean;
  sensitive: boolean;
  /** The applicant's own identity may never resolve a non-SELF question. */
  forbidsSelfIdentity: boolean;
  /** Bank canonical keys an auto-match may come from (non-SELF semantics). */
  canonicalKeys: string[];
}

interface Rule {
  re: RegExp;
  id: string;
  category: string;
  entity?: IntentEntity;
  keys?: string[];
  exactOnly?: boolean;
  sensitive?: boolean;
}

// Order matters — most specific first. Third-party entities run on the
// LABEL ONLY (never on DOM name attributes), so a stray `name="fullName"`
// attribute can never turn a referrer field into a self-identity field.
const THIRD_PARTY_RULES: Rule[] = [
  { re: /\breferr(er|al|ed|ing)\b|\breferred by\b|\breferring\b|\bwho (is )?(actually )?(referring|referred)/i, id: 'referral.name', category: 'referral', entity: 'REFERRER', keys: ['referrerName'] },
  { re: /relationship (to|with)\b.*(referr|employee|associate)|how (do|does) you know/i, id: 'referral.relationship', category: 'referral', entity: 'REFERRER', keys: ['relationshipToReferrer'] },
  { re: /related to (anyone|an employee|a (current|current or former|former) employee|any)/i, id: 'referral.relative', category: 'referral', entity: 'RELATIVE', keys: ['hasReferralsAtCompany'] },
  { re: /family member|immediate family|\brelatives?\b|\bfamiliar\b|related by blood/i, id: 'referral.family', category: 'referral', entity: 'RELATIVE', keys: ['hasReferralsAtCompany', 'relationshipToReferrer'] },
  { re: /emergency contact|emergency.\b(name|contact|phone|person)\b|contact.*emergency/i, id: 'emergency.contact', category: 'third_party', entity: 'EMERGENCY', keys: ['emergencyContactName', 'emergencyContactPhone'] },
  { re: /\bspouse\b|\bhusband\b|\bwife\b|domestic partner|partner'?s name/i, id: 'spouse.name', category: 'third_party', entity: 'SPOUSE', keys: ['spouseName'] },
  { re: /(current |your )?(manager|supervisor)'?s? name|name of (your )?(current )?(manager|supervisor)|who (is|was) your (manager|supervisor)/i, id: 'manager.name', category: 'third_party', entity: 'MANAGER', keys: ['managerName'] },
  { re: /professional reference|reference'?s name|name of (your )?reference|references?\b.*\b(name|contact)/i, id: 'reference.name', category: 'third_party', entity: 'REFERENCE', keys: ['referenceName'] },
];

const INTENT_RULES: Rule[] = [
  // EEO / legal-sensitive — never auto-answered by generic engines.
  { re: /pronoun/i, id: 'eeo.pronouns', category: 'eeo', sensitive: true },
  { re: /\bgender\b|\bsex\b(?!ual)/i, id: 'eeo.gender', category: 'eeo', sensitive: true },
  { re: /race|ethnic|racial/i, id: 'eeo.race', category: 'eeo', sensitive: true },
  { re: /veteran|military service/i, id: 'eeo.veteran', category: 'eeo', sensitive: true },
  { re: /disabilit|handicap/i, id: 'eeo.disability', category: 'eeo', sensitive: true },
  { re: /sexual orientation|lgbtq|lgbt\b/i, id: 'eeo.orientation', category: 'eeo', sensitive: true },
  { re: /age range|date of birth|\bage\b.*\b(range|old)\b/i, id: 'eeo.age', category: 'eeo', sensitive: true },
  { re: /religio/i, id: 'eeo.religion', category: 'eeo', sensitive: true },
  // Citizenship / clearance — contradictions in real data; exact answers only.
  { re: /citizen(ship)?|\bus person\b|\bITAR\b|green card|permanent resident/i, id: 'workAuth.citizenship', category: 'work_auth', exactOnly: true, sensitive: true, keys: ['workAuthorization'] },
  { re: /security clearance|\bclearance\b|polygraph/i, id: 'workAuth.clearance', category: 'work_auth', exactOnly: true, sensitive: true, keys: ['securityClearance'] },
  { re: /visa (type|status|category)|type of (visa|sponsorship)|what (visa|type of sponsorship)/i, id: 'workAuth.visaType', category: 'work_auth', exactOnly: true, sensitive: true, keys: ['visaType'] },
  // Work authorization — reusable.
  { re: /\bsponsor/i, id: 'workAuth.sponsorship', category: 'work_auth', keys: ['requiresSponsorship'] },
  { re: /authoriz|work permit|right to work|legally (allowed|able|permitted)/i, id: 'workAuth.authorized', category: 'work_auth', keys: ['authorizedToWork'] },
  // Identity — SELF only (third-party rules above already took precedence).
  { re: /e-?mail/i, id: 'identity.email', category: 'identity', keys: ['email'] },
  { re: /phone\s*(country\s*)?code|dial\s*code|country\s*phone/i, id: 'identity.phoneCode', category: 'identity', keys: ['currentCountry'] },
  { re: /phone|mobile|cell(ular)?\b/i, id: 'identity.phone', category: 'identity', keys: ['phone'] },
  { re: /linkedin/i, id: 'identity.linkedin', category: 'identity', keys: ['linkedinUrl'] },
  { re: /github/i, id: 'identity.github', category: 'identity', keys: ['githubUrl'] },
  { re: /portfolio|personal website|website/i, id: 'identity.website', category: 'identity', keys: ['portfolioUrl', 'websiteUrl'] },
  { re: /first ?name|given ?name|preferred (first )?name|forename/i, id: 'identity.firstName', category: 'identity', keys: ['firstName'] },
  { re: /last ?name|family ?name|surname/i, id: 'identity.lastName', category: 'identity', keys: ['lastName'] },
  { re: /\b(full |legal )?name\b/i, id: 'identity.fullName', category: 'identity', keys: ['fullName'] },
  { re: /street address|mailing address|home address|\baddress\b/i, id: 'identity.address', category: 'identity', keys: ['streetAddress'] },
  { re: /country/i, id: 'identity.country', category: 'identity', keys: ['currentCountry'] },
  { re: /(current )?(location|city)|where .*based|which city|city\s*\/?\s*state|resid/i, id: 'identity.location', category: 'identity', keys: ['currentCity'] },
  // Compensation — keep the sub-intents apart (audit: expected/current mixups).
  { re: /(expected|desired|target|requested)\s+(annual\s+)?(salary|compensation|ctc|pay)|(salary|compensation|ctc|pay)\s*(expectation|expectations|expect|range|requirement)|pretens[ãa]o salarial/i, id: 'compensation.expected', category: 'compensation', keys: ['expectedSalary', 'targetSalary'] },
  { re: /(current|present)\s+(annual\s+)?(salary|compensation|ctc|pay)|last salary|último salário/i, id: 'compensation.current', category: 'compensation', keys: ['currentSalary'] },
  { re: /salary|compensation|\bctc\b|pay rate|remuneration|pretens[ãa]o/i, id: 'compensation.generic', category: 'compensation', keys: ['expectedSalary', 'targetSalary', 'minimumSalary', 'currentSalary'] },
  // Availability.
  { re: /notice period|period of notice|how much notice|notice required/i, id: 'availability.notice', category: 'availability', keys: ['noticePeriod'] },
  { re: /earliest start|when can you start|available to start|availability to start|start date|when (will|would|can) you (be able to )?(join|start)|date of availability|how soon can you join/i, id: 'availability.start', category: 'availability', keys: ['earliestStartDate'] },
  { re: /relocat/i, id: 'availability.relocation', category: 'availability', keys: ['willingToRelocate'] },
  { re: /remote|hybrid|on-?site|work (arrangement|model|preference)|commut/i, id: 'availability.onsite', category: 'availability', keys: ['remotePreference', 'onsiteAvailability'] },
  { re: /travel/i, id: 'availability.travel', category: 'availability', keys: ['willingToTravel'] },
  { re: /\bshift\b|\bschedule\b/i, id: 'availability.shift', category: 'availability', keys: ['shiftPreference'] },
  // Employment history. "Have you previously worked at X?" is company-specific → exact only.
  { re: /have you (previously|ever) (worked|been employed)|are you a former|former (employee|associate)|previously worked (for|at)|worked (at|for)\b.*(before|previously)/i, id: 'employer.previouslyWorkedHere', category: 'employer', exactOnly: true, keys: ['previouslyWorkedAtCompany'] },
  { re: /current (or most recent )?(company|employer)|current employer|company name|most recent (company|employer)/i, id: 'employer.current', category: 'employer', keys: ['currentCompany'] },
  { re: /previous (company|employer)/i, id: 'employer.previous', category: 'employer', keys: ['previousEmployer'] },
  { re: /school attended|name of (your )?(school|university|college)|\bschool\b|university|college/i, id: 'education.school', category: 'education', keys: ['schoolName'] },
  { re: /highest (level of )?education|education level|degree|study|graduat/i, id: 'education.level', category: 'education', keys: ['educationLevel'] },
  { re: /years of (relevant |professional |it )?experience|how many years|total years/i, id: 'experience.years', category: 'experience', keys: ['yearsOfExperience'] },
  { re: /how did you (hear|learn)|where did you (hear|find|learn)|hear about (us|our)|referral source|find out about (this|us)|keep hearing/i, id: 'source.hearAbout', category: 'source', keys: ['referralSource'] },
  { re: /why (are you interested|do you want|should we|this role|us)|what (interests|excites|motivates) you|cover letter/i, id: 'motivation.why', category: 'motivation', keys: ['whyInterested'] },
  { re: /tell us about yourself|about yourself|brief introduction|introduce yourself|about you|professional summary/i, id: 'about.self', category: 'motivation', keys: ['selfIntroduction'] },
];

const CONDITIONAL_RE = /^(if|caso|em caso|se )\b|\bif (yes|so|applicable|selected|referred|any|you (were|are|have|answered)|the (previous|above))\b/i;

const SELF_DEFAULT: QuestionIntent = {
  id: 'other.unknown',
  category: 'other',
  entity: 'SELF',
  conditional: false,
  exactOnly: false,
  sensitive: false,
  forbidsSelfIdentity: false,
  canonicalKeys: [],
};

export function classifyQuestionIntent(input: { label?: string; name?: string; groupLabel?: string }): QuestionIntent {
  const labelText = `${input.label || ''} ${input.groupLabel || ''}`.trim();
  const labelLower = labelText.toLowerCase();
  const conditional = CONDITIONAL_RE.test(labelLower);

  const finish = (rule: Rule | null): QuestionIntent => {
    const entity = rule?.entity ?? 'SELF';
    const exactOnly = !!(rule?.exactOnly || rule?.sensitive || conditional);
    return {
      id: rule?.id || (conditional ? 'conditional.followup' : 'other.unknown'),
      category: rule?.category || (conditional ? 'conditional' : 'other'),
      entity,
      conditional,
      exactOnly,
      sensitive: !!rule?.sensitive,
      forbidsSelfIdentity: entity !== 'SELF',
      canonicalKeys: rule?.keys || [],
    };
  };

  // Third-party entities first — they win over everything else.
  for (const rule of THIRD_PARTY_RULES) {
    if (rule.re.test(labelLower)) return finish(rule);
  }
  for (const rule of INTENT_RULES) {
    if (rule.re.test(labelLower)) return finish(rule);
  }
  return finish(conditional ? { re: /./, id: 'conditional.followup', category: 'conditional' } : null);
}

/** The applicant's own identity may never resolve a non-SELF question, and
 *  exactOnly questions never resolve from generic (concept/prefix/engine)
 *  stages at all. */
export function intentAllowsSelfIdentity(intent: QuestionIntent): boolean {
  return intent.entity === 'SELF' && !intent.exactOnly;
}

/** Concept/prefix stages: block canonical keys outside a non-SELF intent's
 *  own allow-list (so `fullName` can never answer a referrer question). */
export function intentBlocksCanonical(intent: QuestionIntent, canonicalKey: string | undefined): boolean {
  if (intent.entity === 'SELF') return false;
  const key = String(canonicalKey || '').trim();
  if (!key) return true;
  return !intent.canonicalKeys.includes(key);
}

/** Bank/engine match gate: EXACT is always allowed (the user answered THIS
 *  question); anything fuzzier must respect exactOnly and entity scoping. */
export function intentAllowsBankMatch(intent: QuestionIntent, canonicalKey: string | undefined, status: string): boolean {
  if (status === 'EXACT') return true;
  if (intent.exactOnly) return false;
  if (intent.entity === 'SELF') return true;
  const key = String(canonicalKey || '').trim();
  return !!key && intent.canonicalKeys.includes(key);
}
