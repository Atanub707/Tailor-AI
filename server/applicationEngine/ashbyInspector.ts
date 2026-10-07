// Ashby inspection adapter — deterministic CORE field map for the standard
// jobs.ashbyhq.com application form.
//
// The live Ashby form renders client-side (React) with per-board custom
// questions, so this adapter is intentionally static: it provides the
// canonical core field set so the package/plan/answer-bank pipeline can
// proceed, while the agent loop observes the REAL page at run time and fills
// every field it finds (including board-specific questions). No network call,
// no fabricated data.
//
// Ashby core fields are ID-based on the live page:
//   #_systemfield_name / #_systemfield_email / #_systemfield_resume

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

export const ASHBY_HOSTS = ['jobs.ashbyhq.com'];
export const ASHBY_INSPECTOR_VERSION = 'ashby-core-1';

/** Standard Ashby core fields (id-based on the live React page).
 *  normalizedKey mirrors the package answer keys so mapping is EXACT. */
export const ASHBY_CORE_FIELDS: ApplicationField[] = [
  { providerFieldId: '_systemfield_name', label: 'Name', type: 'TEXT', required: true, category: 'IDENTITY', normalizedKey: 'fullName' },
  { providerFieldId: '_systemfield_email', label: 'Email', type: 'EMAIL', required: true, category: 'CONTACT', normalizedKey: 'email' },
  { providerFieldId: '_systemfield_resume', label: 'Resume', type: 'FILE', required: true, category: 'RESUME', normalizedKey: 'resume' },
];

export class AshbyInspectionAdapter implements ApplicationInspectionAdapter {
  readonly provider: Provider = 'ashby';
  readonly version = ASHBY_INSPECTOR_VERSION;

  detect(target: ApplicationTarget): DetectionResult {
    return detectProvider(undefined, target.applyUrl, target.jobUrl);
  }

  async inspect(target: ApplicationTarget): Promise<ApplicationRequirements> {
    if (!target.applyUrl) throw new InspectionFailure('INVALID_TARGET', 'No apply URL for Ashby inspection.');
    const hostname = String(target.applyUrl).replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    const fp = requirementsFingerprint(this.provider, hostname, ASHBY_CORE_FIELDS);
    return {
      provider: 'ashby',
      target: {
        ...target,
        provider: 'ashby',
        hostname,
        redirectKind: classifyTarget(target.applyUrl, 'ashby'),
      },
      fields: ASHBY_CORE_FIELDS.map((x) => ({ ...x })),
      discoveredAt: new Date().toISOString(),
      fingerprint: fp,
      providerMetadata: {},
    };
  }
}
