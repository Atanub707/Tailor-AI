import { SantaMariaApifyProvider } from '../providers/santaMariaProvider.js';
import { ApifyLinkedInScraper } from '../scraper/apifyScraper.js';
import { NaukriScraper } from '../scraper/naukriScraper.js';
import { IndeedScraper } from '../scraper/indeedScraper.js';
import { getProviderFetchLimit } from '../providers/searchBudget.js';
import type { SearchRequest } from '../providers/searchBudget.js';

/**
 * Provider Router — the ONLY place that decides which provider to call and
 * with what fetch limit. Every provider's limit comes from the central budget
 * (searchBudget.ts); no provider can exceed it. One failure never kills the
 * whole search — callers receive { jobs, error } per provider.
 */

export interface RouterResult {
  jobs: any[];
  runId?: string;
  error?: string;
  requested: number;
  returned: number;
}

export async function routeProvider(req: SearchRequest, providerId: string, limit: number): Promise<RouterResult> {
  // Central budget — never bypassed. LIMIT is user-facing; provider fetch
  // limit is what actually goes to the actor.
  const providerLimit = getProviderFetchLimit(limit, providerId);

  try {
    switch (providerId) {
      case 'santa-maria': {
        const provider = new SantaMariaApifyProvider();
        const result = await provider.search({
          keywords: req.query.split(/\s+/).filter(Boolean),
          locations: req.location ? [req.location] : undefined,
          remote: req.remote,
          limit: providerLimit,
          queries: [], // SantaMariaProvider reads the company_career_sites registry itself
        });
        return {
          jobs: result.jobs,
          runId: result.providerRunId,
          requested: providerLimit,
          returned: result.totalReturned,
        };
      }
      case 'linkedin': {
        const scraper = new ApifyLinkedInScraper();
        const jobs = await scraper.scrape({
          keywords: req.query,
          location: req.location,
          datePostedFilter: req.postedWithin || 'all',
          jobType: (req.remote ? 'remote' : undefined) as any,
          maxJobsPerSource: providerLimit,
        });
        return { jobs, requested: providerLimit, returned: jobs.length };
      }
      case 'naukri': {
        const scraper = new NaukriScraper();
        const jobs = await scraper.scrape({
          keywords: req.query,
          location: req.location,
          datePostedFilter: req.postedWithin || 'all',
          jobType: (req.remote ? 'remote' : undefined) as any,
          maxJobsPerSource: providerLimit,
        });
        return { jobs, requested: providerLimit, returned: jobs.length };
      }
      case 'indeed': {
        const scraper = new IndeedScraper();
        const jobs = await scraper.scrape({
          keywords: req.query,
          location: req.location,
          datePostedFilter: req.postedWithin || 'all',
          jobType: (req.remote ? 'remote' : undefined) as any,
          maxJobsPerSource: providerLimit,
        });
        return { jobs, requested: providerLimit, returned: jobs.length };
      }
      default:
        return { jobs: [], error: `Unknown provider: ${providerId}`, requested: providerLimit, returned: 0 };
    }
  } catch (err: any) {
    return { jobs: [], error: err?.message || String(err), requested: providerLimit, returned: 0 };
  }
}