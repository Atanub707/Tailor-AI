// Neutral Greenhouse provider for the V2 search pipeline.
//
// Greenhouse is a job-DATA provider and nothing more:
//   * retrieves currently-open jobs from the public boards API ($0, no key)
//   * normalizes them (dates via first_published → updated_at fallback with
//     semantics labels preserved — see ghJob in directAtsProvider)
//   * returns them UNFILTERED — no keyword/profession logic, no ranking, no
//     fallback rules. Relevance/date/location constraints are applied by the
//     orchestrator (acceptResults), never here.
//
// Board coverage comes from the shared company_career_sites registry via
// pickBoards (directAtsProvider) — no competing board list exists.

import type { JobSearchParams, JobSearchProvider, ProviderSearchResult } from './types.js';
import { scrapeDirectAts } from './directAtsProvider.js';
import { toNormalized } from './atsProviderShared.js';

export class GreenhouseProvider implements JobSearchProvider {
  readonly id = 'greenhouse';

  supports(params: JobSearchParams): boolean {
    return params.source === 'Greenhouse' || params.source === 'greenhouse';
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const started = Date.now();
    // Neutral fetch: no keywords passed (the orchestrator filters), the
    // fetch limit caps per-board work (bounded, no unbounded fan-out).
    const jobs = await scrapeDirectAts('Greenhouse', 'greenhouse', [], fetchLimit);
    const normalized = jobs.map((j) => toNormalized(j, 'Greenhouse'));
    return {
      provider: this.id,
      jobs: normalized,
      requestedLimit: fetchLimit,
      returnedCount: normalized.length,
      durationMs: Date.now() - started,
      costEstimate: 0, // public API — always $0
    };
  }

  estimatedCost(_fetchLimit: number): number | null {
    return 0;
  }
}

export const greenhouseProvider = new GreenhouseProvider();