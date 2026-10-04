// Auto Apply — RulesDecisionEngine (deterministic, stage 1 of the fallback).
//
// Represents the EXISTING deterministic behavior as a DecisionEngine: it
// reuses the repository's field normalization, consent classification and
// EEO classification. It returns null only when a field is genuinely
// ambiguous — those are the only fields an engine (Laya) may be asked about.

import type { FieldCategory } from '../applicationEngine/contract.js';
import { normalizeFieldLabel, classifyEeo } from '../applicationEngine/contract.js';
import { classifyConsent } from '../applicationEngine/executionContract.js';
import type {
  AnswerSource,
  DecisionEngine,
  FieldClassificationInput,
  FieldClassificationResult,
} from './decisionEngine.js';

/** Canonical key → the existing FieldCategory enum (presentation metadata). */
const KEY_CATEGORY: Record<string, FieldCategory> = {
  fullName: 'IDENTITY',
  firstName: 'IDENTITY',
  lastName: 'IDENTITY',
  preferredName: 'IDENTITY',
  email: 'CONTACT',
  phone: 'CONTACT',
  currentCity: 'LOCATION',
  currentState: 'LOCATION',
  currentCountry: 'LOCATION',
  linkedinUrl: 'CONTACT',
  githubUrl: 'CONTACT',
  portfolioUrl: 'CONTACT',
  websiteUrl: 'CONTACT',
  authorizedToWork: 'WORK_AUTHORIZATION',
  requiresSponsorship: 'SPONSORSHIP',
  visaType: 'SPONSORSHIP',
  noticePeriod: 'CUSTOM',
  earliestStartDate: 'CUSTOM',
  targetSalary: 'COMPENSATION',
  currentSalary: 'COMPENSATION',
  minimumSalary: 'COMPENSATION',
  referralSource: 'CUSTOM',
  hasReferralsAtCompany: 'CUSTOM',
  onsiteAvailability: 'CUSTOM',
  accessibilityNeeds: 'EEO',
  resume: 'RESUME',
  coverLetter: 'COVER_LETTER',
};

const KEY_ANSWER_SOURCE: Record<string, AnswerSource> = {
  resume: 'MASTER_CV',
  coverLetter: 'GENERATIVE_REQUIRED',
  accessibilityNeeds: 'USER_REQUIRED',
};

export class RulesDecisionEngine implements DecisionEngine {
  readonly name = 'rules';

  async classifyField(input: FieldClassificationInput): Promise<FieldClassificationResult | null> {
    const label = String(input.label || '');

    // Existing consent classification (conservative).
    const consent = classifyConsent('', label);
    if (consent === 'LEGAL_CONSENT' || consent === 'REQUIRED_ACKNOWLEDGEMENT') {
      return {
        category: 'CONSENT',
        confidence: 1,
        mappingMethod: 'DETERMINISTIC',
        requiresUser: true,
        reason: 'consent/legal declaration — review required',
      };
    }

    // Existing EEO classification (never inferred).
    if (classifyEeo(label) === 'EEO') {
      return {
        category: 'EEO',
        confidence: 1,
        mappingMethod: 'DETERMINISTIC',
        requiresUser: true,
        reason: 'EEO/demographic — manual or voluntary only',
      };
    }

    // Existing field normalization (exact → alias ladder).
    const canonicalKey = input.normalizedKey || normalizeFieldLabel(label);
    if (!canonicalKey) return null; // genuinely ambiguous → the engine's turn

    return {
      canonicalKey,
      category: KEY_CATEGORY[canonicalKey] ?? 'UNKNOWN',
      answerSource: KEY_ANSWER_SOURCE[canonicalKey] ?? 'PROFILE',
      confidence: 1,
      mappingMethod: 'DETERMINISTIC',
      requiresUser: true, // classification only — the answer may still be missing
      reason: 'deterministic classification',
    };
  }
}
