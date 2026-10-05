// Greenhouse inspection adapter — deterministic CORE field map for the
// standard job-boards application form (job-boards.greenhouse.io /
// boards.greenhouse.io).
//
// The live Greenhouse form renders client-side and boards add their own
// `question_*` fields, so this adapter is intentionally static: it provides
// the canonical core field set so the package/plan/answer-bank pipeline can
// proceed, while the agent loop observes the REAL page at run time and fills
// every field it finds (including board-specific questions). No network call,
// no fabricated data.

import {
  classifyTarget,
  detectProvider,
  requirementsFingerprint,
  type ApplicationField,
  type ApplicationRequirements,
  type ApplicationTarget,
  type DetectionResult,
  type Provider,
} from './contract.js';
import type { ApplicationInspectionAdapter } from './fixtureAdapter.js';
import { InspectionFailure } from './leverInspector.js';

export const GREENHOUSE_HOSTS = ['greenhouse.io', 'job-boards.greenhouse.io', 'boards.greenhouse.io'];
export const GREENHOUSE_INSPECTOR_VERSION = 'greenhouse-core-1';


/** Standard Greenhouse core fields (id-based on the live React page).
 *  normalizedKey mirrors the package answer keys so mapping is EXACT. */
export const GREENHOUSE_CORE_FIELDS: ApplicationField[] = [
  { providerFieldId: 'first_name', label: 'First Name', type: 'TEXT', required: true, category: 'IDENTITY', normalizedKey: 'firstName' },
  { providerFieldId: 'last_name', label: 'Last Name', type: 'TEXT', required: true, category: 'IDENTITY', normalizedKey: 'lastName' },
  { providerFieldId: 'email', label: 'Email', type: 'EMAIL', required: true, category: 'CONTACT', normalizedKey: 'email' },
  { providerFieldId: 'phone', label: 'Phone', type: 'PHONE', required: true, category: 'CONTACT', normalizedKey: 'phone' },
  { providerFieldId: 'country', label: 'Country', type: 'TEXT', required: true, category: 'LOCATION', normalizedKey: 'currentCountry' },
  { providerFieldId: 'resume', label: 'Resume', type: 'FILE', required: true, category: 'RESUME', normalizedKey: 'resume' },
];

export class GreenhouseInspectionAdapter implements ApplicationInspectionAdapter {
  readonly provider: Provider = 'greenhouse';
  readonly version = GREENHOUSE_INSPECTOR_VERSION;

  detect(target: ApplicationTarget): DetectionResult {
    return detectProvider(undefined, target.applyUrl, target.jobUrl);
  }

  async inspect(target: ApplicationTarget): Promise<ApplicationRequirements> {
    if (!target.applyUrl) throw new InspectionFailure('INVALID_TARGET', 'No apply URL for Greenhouse inspection.');
    const hostname = String(target.applyUrl).replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    const fp = requirementsFingerprint(this.provider, hostname, GREENHOUSE_CORE_FIELDS);
    return {
      provider: 'greenhouse',
      target: {
        ...target,
        provider: 'greenhouse',
        hostname,
        redirectKind: classifyTarget(target.applyUrl, 'greenhouse'),
      },
      fields: GREENHOUSE_CORE_FIELDS.map((x) => ({ ...x })),
      discoveredAt: new Date().toISOString(),
      fingerprint: fp,
      providerMetadata: {},
    };
  }
}
