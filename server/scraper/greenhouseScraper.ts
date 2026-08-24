import { Job } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, extractDescription, normalizeIsoDate } from './apifyBase.js';

// Greenhouse via Apify — maintains 500+ company board tokens, handles pagination/rate limits.
// Actor to be configured in Settings (Apify token required). LIMIT is passed as maxItems.
export class GreenhouseApifyScraper extends ApifyBaseScraper {
  readonly source = 'Greenhouse' as const;
  // TODO: Replace with the actual Apify actor ID for Greenhouse (e.g. curious_coder~greenhouse-scraper)
  // For now this is a placeholder that will be updated when the actor is published.
  readonly actorId = 'apify~greenhouse-jobs-scraper';

  protected buildInput(params: any): Record<string, any> {
    return {
      keyword: params.keywords.trim(),
      location: params.location?.trim() || 'Remote',
      maxItems: Math.min(params.maxJobsPerSource || 25, 100),
      // Apify actor handles company discovery — no need to pass company list
    };
  }

  protected mapItem(item: any): Job | null {
    const title = item.title || item.jobTitle;
    const company = item.company || item.companyName;
    const url = item.url || item.jobUrl || item.link;
    const id = item.id || item.jobId || url;
    if (!title || !company || !url) return null;

    const now = new Date().toISOString();
    const description = cleanDescription(extractDescription(item) || item.description || '');
    const postedDate = normalizeIsoDate(item.postedDate || item.datePosted || item.publishedAt);

    return {
      id: `greenhouse-${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`,
      title: String(title).trim(),
      company: String(company).trim(),
      location: item.location || 'Remote',
      source: 'Greenhouse',
      description: description || 'Description not available',
      url: String(url),
      postedDate,
      ...(postedDate ? { postedDateParsed: postedDate.slice(0, 10) } : {}),
      jobType: item.jobType || 'Full-time',
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  }
}
