// Cover-letter validation — deterministic checks run AFTER the LLM writes and
// BEFORE the letter is marked verified. A cover letter is only uploadable when
// every check passes; otherwise it is stored with verified:false and the
// issues surfaced in the UI. No user-facing letter is ever silently broken.

import { CoverLetter, CoverLetterJobFacts } from '../../src/types.js';
import { checkGeneratedTextSafety } from '../tailor/generatedTextSafety.js';
import { MasterCv, ApplicantProfile } from '../../src/types.js';

export const MIN_WORDS = 120;
export const MAX_WORDS = 400;

const CLICHES = [
  'i am writing to express my interest',
  'i am writing to apply',
  'perfect candidate',
  'ideal candidate',
  'team player',
  'hit the ground running',
  'think outside the box',
  'go-getter',
  'detail-oriented',
  'results-driven',
  'self-starter',
  'passionate professional',
  'dynamic professional',
  'proven track record',
  'wealth of experience',
  'synergy',
  'leverage my',
  'i believe i would be a great fit',
  'i am confident that i would be',
];

/** Extra technology/credential terms that the generic SKILL_TERMS scan does
 *  not cover. A letter may only name one when the Master CV or profile
 *  actually contains it — the JD is never evidence. */
const EXTRA_TECH_TERMS = [
  'yaml', 'gitflow', 'active directory', 'azure active directory', 'entra id',
  'prince2', 'waterfall', 'itil', 'scrum', 'kanban', 'rbac', 'office 365',
  'microsoft 365', 'sharepoint', 'servicenow', 'jira', 'confluence',
  'bitbucket', 'gradle', 'maven', 'jenkins', 'circleci', 'github actions',
  'gitlab ci', 'argocd', 'argo cd', 'flux', 'helm', 'istio', 'linkerd',
  'envoy', 'nginx', 'tomcat', 'kafka', 'rabbitmq', 'redis', 'mongodb',
  'postgresql', 'mysql', 'oracle', 'sql server', 'dynamodb', 'lambda',
  'cloudformation', 'pulumi', 'ansible', 'puppet', 'chef', 'vagrant',
  'packer', 'vault', 'consul', 'nomad', 'openshift', 'rancher', 'prometheus',
  'grafana', 'datadog', 'splunk', 'elasticsearch', 'logstash', 'kibana',
  'new relic', 'pagerduty', 'opsgenie', 'sonarqube', 'checkmarx', 'veracode',
  'snyk', 'trivy', 'falco', 'wazuh', 'suricata', 'snort', 'wireshark', 'nmap',
  'burp suite', 'metasploit', 'owasp zap', 'keycloak', 'oauth', 'saml',
  'openid', 'ldap', 'kerberos', 'vpn', 'firewall', 'waf', 'siem', 'sox',
  'pci dss', 'hipaa', 'gdpr', 'iso 27001', 'nist', 'fedramp',
];

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

/** Remarks every extra technology term the letter names but the candidate's
 *  own record does not support. */
export function unsupportedNamedTerms(text: string, sourceText: string): string[] {
  const out: string[] = [];
  const source = String(sourceText || '').toLowerCase();
  for (const term of EXTRA_TECH_TERMS) {
    if (!termPattern(term).test(text)) continue;
    if (new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i').test(source)) continue;
    out.push(term);
  }
  return out;
}

const PLACEHOLDER_RE = /\[[^\]\n]{2,60}\]|\{\{[^}\n]{2,60}\}\}|\b(TBD|Company Name|Hiring Manager Name)\b/i;
const SALUTATION_RE = /^\s*dear\s+[^\n,]{2,80}[,:]/i;
const SIGN_OFF_RE = /^\s*(sincerely|best regards|kind regards|regards|yours (sincerely|faithfully))[,]?\s*$/im;

const GENERIC_ROLE_WORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief', 'manager',
  'director', 'engineer', 'developer', 'specialist', 'analyst', 'consultant',
  'associate', 'intern', 'and', 'or', 'of', 'the', 'a', 'an', 'for', 'with',
]);

export function normalizeCoverLetterText(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u2014\u2013]/g, ' - ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roleTokens(role: string): string[] {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !GENERIC_ROLE_WORDS.has(t));
}

/** Full company name, or its conventional acronym ("UK Civil Aviation
 *  Authority" → "CAA") when the name has enough meaningful words. */
function mentionsCompany(lowerText: string, company: string): boolean {
  const companyLower = company.toLowerCase();
  if (lowerText.includes(companyLower)) return true;
  const words = company
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(the|of|and|for|a|an)$/i.test(w));
  const acronym = words.map((w) => w[0]).join('').toLowerCase();
  return words.length >= 3 && acronym.length >= 3 && new RegExp(`\\b${acronym}\\b`, 'i').test(lowerText);
}

export function validateCoverLetter(
  letter: Pick<CoverLetter, 'text'>,
  job: CoverLetterJobFacts,
  cv: MasterCv,
  profile: ApplicantProfile,
): Promise<string[]> {
  const text = normalizeCoverLetterText(letter.text);
  const lower = text.toLowerCase();
  const issues: string[] = [];

  if (!text) issues.push('Cover letter is empty.');
  if (text) {
    const words = countWords(text);
    if (words < MIN_WORDS) issues.push(`Cover letter is too short (${words} words; minimum ${MIN_WORDS}).`);
    if (words > MAX_WORDS) issues.push(`Cover letter is too long (${words} words; maximum ${MAX_WORDS}).`);
  }

  if (PLACEHOLDER_RE.test(text)) issues.push('Cover letter contains an unresolved placeholder.');

  if (text && !SALUTATION_RE.test(text)) issues.push('Cover letter must begin with a salutation (for example "Dear Hiring Team,").');
  if (text && !SIGN_OFF_RE.test(text)) issues.push('Cover letter must end with a sign-off (for example "Sincerely,").');

  if (text && !job.hasRecipientName) {
    const generic = /^\s*dear\s+(hiring|the hiring|recruiting|recruitment)/i.test(text) ||
      (job.company ? new RegExp(`^\\s*dear\\s+${escapeRegExp(job.company)}\\s+team`, 'i').test(text) : false);
    if (!generic) issues.push('Salutation must be "Dear Hiring Team" when no recruiter name is known.');
  }

  if (text && job.company && !mentionsCompany(lower, job.company)) {
    issues.push(`Cover letter must mention the company name (${job.company}).`);
  }

  if (text && job.role) {
    const roleLower = job.role.toLowerCase();
    const tokens = roleTokens(job.role);
    const hit = lower.includes(roleLower) || (tokens.length > 0 && tokens.filter((t) => lower.includes(t)).length >= Math.min(2, tokens.length));
    if (!hit) issues.push(`Cover letter must reference the target role (${job.role}).`);
  }

  for (const c of CLICHES) {
    if (lower.includes(c)) issues.push(`Cover letter contains a cliché phrase: "${c}".`);
  }

  const name = (cv.fullName || '').trim();
  if (text && name) {
    const last = name.split(/\s+/).slice(-1)[0];
    const tail = text.slice(-240);
    if (!tail.toLowerCase().includes(last.toLowerCase())) {
      issues.push(`Cover letter must be signed with the candidate's name (${name}).`);
    }
  }

  if (!text) return Promise.resolve(issues);

  // Only the candidate's own record supports a technology claim. The tailored
  // resume can legitimately contain JD terms (auto-add), so it is NOT used here.
  const candidateSource = `${JSON.stringify(cv)}\n${JSON.stringify(profile)}`;
  for (const term of unsupportedNamedTerms(text, candidateSource)) {
    issues.push(`Unverified claim: "${term}" is not in your Master CV or profile.`);
  }

  return checkGeneratedTextSafety(text, cv, profile).then((safety) => {
    if (!safety.ok) {
      for (const issue of safety.issues) issues.push(`Unverified claim: ${issue}`);
    }
    return issues;
  });
}
