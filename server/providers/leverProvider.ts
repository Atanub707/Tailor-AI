// Neutral Lever provider for the V2 search pipeline.
//
// Lever is a job-DATA provider and nothing more:
//   * retrieves currently-open postings from the public API ($0, no key)
//   * normalizes them (createdAt ms-epoch → postedDate, semantics 'created' —
//     see leverJob in directAtsProvider)
//   * returns them UNFILTERED — no keyword/profession logic, no ranking, no
//     fallback rules. Relevance/date/location constraints are applied by the
//     orchestrator (acceptResults), never here.
//
// Board coverage comes from the shared company_career_sites registry via
// pickBoards (directAtsProvider) — no competing board list exists.

import type { JobSearchParams, JobSearchProvider, ProviderSearchResult } from './types.js';
import { scrapeDirectAts } from './directAtsProvider.js';
import { toNormalized } from './atsProviderShared.js';

export class LeverProvider implements JobSearchProvider {
  readonly id = 'lever';

  supports(params: JobSearchParams): boolean {
    return params.source === 'Lever' || params.source === 'lever';
  }

  async search(params: JobSearchParams, fetchLimit: number): Promise<ProviderSearchResult> {
    const started = Date.now();
    // Neutral fetch: no keywords passed (the orchestrator filters), the
    // fetch limit caps per-board work (bounded, no unbounded fan-out).
    const jobs = await scrapeDirectAts('Lever', 'lever', [], fetchLimit);
    const normalized = jobs.map((j) => toNormalized(j, 'Lever'));
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

export const leverProvider = new LeverProvider();