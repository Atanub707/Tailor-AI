// Application Engine V1 — deterministic field mapping.
// EXACT → ALIAS → DETERMINISTIC RULE → UNRESOLVED. No LLM. EEO/consent are
// HARD SAFETY: never auto-mapped, never inferred, never auto-accepted.

import type { ApplicationField } from './contract.js';
import type { ApplicationPackage } from '../applicationPackage/packageModel.js';
import type { MappedField } from './contract.js';

export interface MappingResult {
  mapped: MappedField[];
  unresolved: Array<{ providerFieldId: string; label: string; required: boolean; reason: string }>;
  consent: Array<{ providerFieldId: string; label: string; required: boolean; status: 'REQUIRES_REVIEW' }>;
  manual: Array<{ providerFieldId: string; label: string; required: boolean; reason: string }>;
  files: Array<{ kind: 'RESUME' | 'COVER_LETTER' | 'OTHER'; artifactSha?: string }>;
}

function answerFor(pkg: ApplicationPackage, canonicalKey: string): { value: string | number | boolean | string[] | null; source: string } | undefined {
  const a = pkg.answers.find((x) => x.key === canonicalKey);
  if (!a || a.status !== 'RESOLVED' || a.value === null || a.value === undefined) return undefined;
  return { value: a.value, source: a.source };
}

const ALIAS_TO_CANONICAL: Array<{ aliases: string[]; canonical: string }> = [
  { aliases: ['name'], canonical: 'fullName' },
  { aliases: ['given name', 'firstname', 'first name'], canonical: 'firstName' },
  { aliases: ['family name', 'surname', 'lastname', 'last name'], canonical: 'lastName' },
  { aliases: ['email address', 'e-mail'], canonical: 'email' },
  { aliases: ['mobile', 'mobile number', 'telephone', 'phone number'], canonical: 'phone' },
  { aliases: ['linkedin profile', 'linkedin'], canonical: 'linkedinUrl' },
  { aliases: ['github'], canonical: 'githubUrl' },
  { aliases: ['portfolio'], canonical: 'portfolioUrl' },
  { aliases: ['personal website'], canonical: 'websiteUrl' },
  { aliases: ['are you legally authorized to work in', 'work authorization', 'authorized to work', 'work eligibility'], canonical: 'authorizedToWork' },
  { aliases: ['will you now or in the future require sponsorship', 'requires sponsorship', 'visa sponsorship', 'do you require sponsorship'], canonical: 'requiresSponsorship' },
  { aliases: ['notice period'], canonical: 'noticePeriod' },
  { aliases: ['expected salary', 'salary expectation', 'desired salary'], canonical: 'targetSalary' },
  { aliases: ['resume', 'resume/cv', 'cv'], canonical: 'resume' },
  { aliases: ['cover letter'], canonical: 'coverLetter' },
];

function aliasKey(label: string): string | undefined {
  const l = String(label || '').toLowerCase().trim().replace(/\s+/g, ' ');
  for (const e of ALIAS_TO_CANONICAL) {
    if (e.aliases.some((a) => l === a || l.startsWith(a))) return e.canonical;
  }
  return undefined;
}

function boolToSelect(value: unknown, options: string[] | undefined): string | undefined {
  if (!options?.length) return undefined;
  const yes = ['Yes', 'yes', 'Y', 'true'].filter((o) => options.includes(o));
  const no = ['No', 'no', 'N', 'false'].filter((o) => options.includes(o));
  if (value === true && yes.length) return yes[0];
  if (value === false && no.length) return no[0];
  if (value === 'true' && yes.length) return yes[0];
  if (value === 'false' && no.length) return no[0];
  return undefined;
}

/** Explicit, deterministic select-option equivalences (never fuzzy). */
const OPTION_EQUIV: Array<{ canonical: string; matches: string[] }> = [
  { canonical: '1 month', matches: ['30 days', '30 day', 'one month'] },
  { canonical: '2 weeks', matches: ['14 days', 'two weeks'] },
];

function selectOptionMatch(value: string, options: string[] | undefined): string | undefined {
  if (!options?.length) return undefined;
  if (options.includes(value)) return value;
  // Tri-state strings from the canonical profile: 'yes'/'no' → Yes/No
  const tri = value.toLowerCase();
  if (tri === 'yes' || tri === 'true' || tri === '1') { if (options.includes('Yes')) return 'Yes'; }
  if (tri === 'no' || tri === 'false' || tri === '0') { if (options.includes('No')) return 'No'; }
  // deterministic equivalence: package value '30 days' → provider option '1 month'
  for (const eq of OPTION_EQUIV) {
    if (eq.matches.includes(value) && options.includes(eq.canonical)) return eq.canonical;
  }
  return undefined;
}

function isEeo(category: string): boolean {
  return category === 'EEO';
}

function isConsent(type: string, category: string): boolean {
  return type === 'CONSENT' || category === 'CONSENT';
}

function sameCurrencyPeriod(pkgSalary: string | undefined, currency: string | undefined, period: string | undefined, fieldLabel: string): boolean {
  // We only map salary when the package already carries currency+period and
  // the provider field label does not demand a different currency.
  if (!pkgSalary) return true;
  const l = fieldLabel.toLowerCase();
  if (/usd|\$/.test(l) && pkgSalary !== 'USD') return false;
  if (/inr|₹/.test(l) && pkgSalary !== 'INR') return false;
  if (/annual|per year/.test(l) && period !== 'year') return false;
  return true;
}

/** Map a frozen READY package's answer catalog onto inspection requirements. */
export function mapRequirements(pkg: ApplicationPackage, fields: ApplicationField[]): MappingResult {
  const mapped: MappedField[] = [];
  const unresolved: MappingResult['unresolved'] = [];
  const consent: MappingResult['consent'] = [];
  const manual: MappingResult['manual'] = [];
  const files: MappingResult['files'] = [];

  for (const f of fields) {
    // HARD SAFETY: EEO fields are never auto-mapped.
    if (isEeo(f.category)) {
      manual.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'EEO — manual/voluntary only, never inferred or auto-filled' });
      continue;
    }
    // HARD SAFETY: consent fields are never auto-accepted.
    if (isConsent(f.type, f.category)) {
      consent.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, status: 'REQUIRES_REVIEW' });
      continue;
    }

    // Resume → the package's immutable PDF artifact ONLY.
    if (f.type === 'FILE' && (f.normalizedKey === 'resume' || aliasKey(f.label) === 'resume')) {
      const art = pkg.resumeSnapshot?.pdfHash;
      if (art) {
        mapped.push({
          providerFieldId: f.providerFieldId, canonicalKey: 'resume', label: f.label, type: 'FILE', required: f.required,
          value: null, source: 'PACKAGE', mappingConfidence: 'high', mappingMethod: 'EXACT',
        });
        files.push({ kind: 'RESUME', artifactSha: art });
      } else {
        unresolved.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'package has no verified PDF artifact' });
      }
      continue;
    }
    if (f.type === 'FILE') {
      manual.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'non-resume file upload — manual only in Phase 1' });
      continue;
    }

    const canonical = f.normalizedKey || aliasKey(f.label);
    const answer = canonical ? answerFor(pkg, canonical) : undefined;

    // Salary safety: never FX-convert; currency/period mismatch → unresolved.
    if (canonical === 'targetSalary' || canonical === 'currentSalary' || canonical === 'minimumSalary') {
      const currency = String(answerFor(pkg, 'salaryCurrency')?.value ?? '');
      const period = String(answerFor(pkg, 'salaryPeriod')?.value ?? '');
      if (answer && !sameCurrencyPeriod(currency, currency, period, f.label)) {
        unresolved.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'salary currency/period mismatch — no FX conversion' });
        continue;
      }
    }

    if (!answer || answer.value === null || answer.value === undefined) {
      unresolved.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'no resolved package answer' });
      continue;
    }

    // Selects: map booleans to Yes/No options; otherwise exact/deterministic
    // option matches only — never fuzzy.
    let value: string | number | boolean | string[] = answer.value as string | number | boolean | string[];
    if (f.type === 'SINGLE_SELECT' || f.type === 'MULTI_SELECT') {
      if (typeof answer.value === 'boolean') {
        const mappedBool = boolToSelect(answer.value, f.options);
        if (!mappedBool) {
          unresolved.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: 'no matching select option' });
          continue;
        }
        value = mappedBool;
      } else if (typeof answer.value === 'string') {
        const option = selectOptionMatch(answer.value, f.options) ?? (f.options?.includes(answer.value) ? answer.value : undefined);
        if (!option) {
          unresolved.push({ providerFieldId: f.providerFieldId, label: f.label, required: f.required, reason: `no exact/deterministic select option for "${answer.value}"` });
          continue;
        }
        value = option;
      }
    }

    const method = f.normalizedKey === canonical ? 'EXACT' : canonical ? 'ALIAS' : 'DETERMINISTIC';
    mapped.push({
      providerFieldId: f.providerFieldId, canonicalKey: canonical, label: f.label, type: f.type, required: f.required,
      value, source: answer.source, mappingConfidence: method === 'EXACT' ? 'high' : method === 'ALIAS' ? 'high' : 'medium',
      mappingMethod: method as MappedField['mappingMethod'],
    });
  }

  return { mapped, unresolved, consent, manual, files };
}