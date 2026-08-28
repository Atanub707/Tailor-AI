// Job requirements parser — deterministic extraction from JD text.
// The JD is UNTRUSTED DATA: everything here treats it as plain text tokens.
// No execution, no prompts, no navigation.

export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  unknownStrengthSkills: string[];
  minYears?: number;
  yearsWorded?: string;
  education?: { level?: string; field?: string; required: boolean };
  location?: { required?: string; remote?: boolean; onsite?: boolean; hybrid?: boolean };
  workMode?: 'remote' | 'hybrid' | 'onsite' | undefined;
  authorization?: { country?: string; required?: boolean; sponsorship?: boolean };
  compensation?: { amount?: number; currency?: string; period?: string; explicit: boolean };
}

const REQUIRED_MARKERS = /\b(must|required|mandatory|need to|needs to|minimum|at least|eligible|shall|essential|require)\b/i;
const PREFERRED_MARKERS = /\b(preferred|nice to have|bonus|plus|desirable|advantage|good to have|would be great)\b/i;

const REQUIRED_SKILL_RE = /(?:must|required|mandatory|essential|need|needs|minimum|at least|proficiency in|experience with|knowledge of|expertise in|skills? in)\s*[:,\-]?\s*([^;\n]{2,120})/gi;
const PREFERRED_SKILL_RE = /(?:preferred|nice to have|bonus|plus|desirable|advantage|good to have)\b[^;\n]{0,30}?[:,\-]?\s*([^;\n]{2,120})/gi;

export const SKILL_TERMS = new Set([
  'kubernetes', 'k8s', 'docker', 'terraform', 'aws', 'azure', 'gcp', 'gke', 'eks', 'aks', 'ci/cd', 'cicd', 'gitlab',
  'github actions', 'jenkins', 'argo', 'helm', 'prometheus', 'grafana', 'datadog', 'linux', 'python', 'go', 'golang',
  'java', 'typescript', 'javascript', 'node', 'react', 'sql', 'postgres', 'mysql', 'mongodb', 'redis', 'kafka',
  'pulumi', 'ansible', 'bash', 'powershell', 'cloudformation', 'serverless', 'lambda', 's3', 'istio', 'vault',
  'spark', 'airflow', 'dbt', 'pytorch', 'tensorflow', 'ml', 'llm', 'terraform', 'iac', 'networking', 'tcp/ip',
  'oauth', 'saml', 'ldap', 'okta', 'snowflake', 'bigquery', 'elasticsearch', 'nginx', 'rest', 'grpc', 'graphql',
  'model training', 'model serving', 'model integration', 'api integration', 'mlops', 'rag', 'langchain',
  'vector database', 'embeddings', 'evaluation', 'accessibility', 'next.js', 'node.js', 'html/css', 'html', 'css',
  'rest apis', 'testing', 'react', 'nursing', 'patient care', 'rn license', 'nursing license', 'licensed',
  'accounting', 'gaap', 'bookkeeping', 'tax', 'cpa', 'figma', 'photoshop', 'illustrator', 'graphic design',
  'sales', 'crm', 'outbound', 'cold calling', 'data entry', 'typing', 'excel',
]);

function extractSkillPhrases(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1].toLowerCase().trim().replace(/\.$/, '');
    for (const term of SKILL_TERMS) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(phrase)) {
        if (!out.includes(term)) out.push(term);
      }
    }
  }
  return out;
}

function extractYears(text: string): number | undefined {
  // Years only count as a REQUIREMENT when tied to experience context —
  // company history blurbs ("for more than 25 years…") must never set a
  // fake years requirement.
  const m = text.match(
    /(?:experience|must have|must|requires?|required|minimum|at least|work(?:ing)? with)[^.;\n]{0,60}?(\d+(?:\.\d+)?)\s*\+?\s*(?:years|yrs)/i
  );
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 && v <= 60 ? v : undefined;
}

function extractEducation(text: string): JobRequirements['education'] | undefined {
  const normalized = String(text).replace(/\u2019|\u2018/g, "'"); // typographic quotes
  const levels: Array<{ level: string; re: RegExp }> = [
    { level: "master's", re: /master'?s|\bms\b|\bma\b|m\.?tech/i },
    { level: "bachelor's", re: /bachelor'?s|\bbs\b|\bba\b|b\.?tech|undergraduate/i },
    { level: 'phd', re: /ph\.?d|doctorate/i },
  ];
  for (const l of levels) {
    if (l.re.test(normalized)) {
      const idx = normalized.indexOf(l.re.exec(normalized)![0]);
      const required = REQUIRED_MARKERS.test(normalized.slice(Math.max(0, idx - 60), Math.min(normalized.length, idx + 80)));
      return { level: l.level, required };
    }
  }
  return undefined;
}

function extractAuthorization(text: string): JobRequirements['authorization'] | undefined {
  const auth = /(?:authorized|authorisation|authorization|eligible|right to work|work authorization)\s*(?:to work)?\s*(?:in\s+)?([A-Za-z\s]{2,25})/i.exec(text);
  const sponsorship = /\b(sponsorship|sponsor|visa sponsorship)\b/i.test(text);
  const country = auth ? auth[1].replace(/[.;,]/g, '').trim() : undefined;
  if (!country && !sponsorship) return undefined;
  return { country: country || undefined, required: !!country || sponsorship, sponsorship };
}

function extractCompensation(text: string): JobRequirements['compensation'] | undefined {
  const m = text.match(/(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:lakh|lpa|lakhs)?|\$(\d[\d,]*)\s*(?:k|,?\d{3})?\s*(?:-\s*(?:\$\d[\d,]*\s*)?)?(?:\/|per|a)?\s*(year|yr|annum|month|hour)?/i);
  const amountMatch = text.match(/(?:salary|compensation|pay|package)\s*(?:of|range|:)?\s*[$₹]?\s*([\d,]+)\s*(k|lakh|lpa)?/i);
  if (!amountMatch) return undefined;
  const raw = amountMatch[1].replace(/,/g, '');
  const unit = (amountMatch[2] || '').toLowerCase();
  let amount = Number(raw);
  if (unit === 'k') amount *= 1000;
  if (unit === 'lakh' || unit === 'lpa') amount *= 100000;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const currency = /\$/.test(text) ? 'USD' : /₹|lakh|lpa/.test(text) ? 'INR' : /€/.test(text) ? 'EUR' : /£/.test(text) ? 'GBP' : undefined;
  return { amount, currency, period: 'year', explicit: true };
  void m;
}

export function parseJobRequirements(description: string, metadata: { location?: string; workMode?: string } = {}): JobRequirements {
  const text = String(description || '');
  const reqs: JobRequirements = {
    requiredSkills: [],
    preferredSkills: [],
    unknownStrengthSkills: [],
  };

  reqs.requiredSkills = extractSkillPhrases(text, REQUIRED_SKILL_RE);
  reqs.preferredSkills = extractSkillPhrases(text, PREFERRED_SKILL_RE);
  // Bare skill mentions with no strength marker → unknown strength.
  const mentioned = extractSkillPhrases(text, /([^;\n]{2,120})/gi);
  reqs.unknownStrengthSkills = mentioned.filter((s) => !reqs.requiredSkills.includes(s) && !reqs.preferredSkills.includes(s));

  reqs.minYears = extractYears(text);
  reqs.yearsWorded = text.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years|yrs)/i)?.[0];
  reqs.education = extractEducation(text);
  reqs.authorization = extractAuthorization(text);
  reqs.compensation = extractCompensation(text);

  const wmText = (metadata.location || '') + ' ' + text.slice(0, 600);
  if (/\bremote\b|work from anywhere|fully remote|100% remote/i.test(wmText)) reqs.workMode = 'remote';
  else if (/\bhybrid\b/i.test(wmText)) reqs.workMode = 'hybrid';
  else if (/\bon-?site\b|in-?office\b/i.test(wmText)) reqs.workMode = 'onsite';
  if (metadata.location) reqs.location = { required: metadata.location };

  return reqs;
}