import { ApifyLinkedInScraper } from '../scraper/apifyScraper.js';
import { NaukriScraper } from '../scraper/naukriScraper.js';
import { IndeedScraper } from '../scraper/indeedScraper.js';
import { getProviderFetchLimit } from '../providers/searchBudget.js';
import { getProviderCursor, saveProviderCursor } from '../storage/v2Tables.js';
import { getCurrentUserId } from '../storage/fileStorage.js';
import { getSearchFingerprint } from './searchService.js';
import type { SearchRequest } from '../providers/searchBudget.js';

// Provider Router — the ONLY place that decides which provider to call and
// with what fetch limit. Every provider's limit comes from the central budget
// (searchBudget.ts); no provider can exceed it. One failure never kills the
// whole search — callers receive { jobs, error } per provider.

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
      case 'linkedin': {
        const scraper = new ApifyLinkedInScraper();
        const cursor = getProviderCursor(getCurrentUserId(), getSearchFingerprint(req), 'linkedin');
        const jobs = await scraper.scrape({
          keywords: req.query,
          location: req.location,
          datePostedFilter: req.postedWithin || 'all',
          jobType: (req.remote ? 'remote' : undefined) as any,
          maxJobsPerSource: providerLimit,
          skipJobId: undefined, // LinkedIn actor accepts 'start' via this input
          start: cursor.fetchedCount, // page offset = jobs already fetched in this walk
        } as any);
        saveProviderCursor(getCurrentUserId(), getSearchFingerprint(req), 'linkedin', String(cursor.fetchedCount + jobs.length), cursor.fetchedCount + jobs.length);
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