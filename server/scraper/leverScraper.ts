import { Job } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, extractDescription, normalizeIsoDate } from './apifyBase.js';

export class LeverApifyScraper extends ApifyBaseScraper {
  readonly source = 'Lever' as const;
  readonly actorId = 'apify~lever-jobs-scraper';

  protected buildInput(params: any): Record<string, any> {
    return {
      keyword: params.keywords.trim(),
      location: params.location?.trim() || 'Remote',
      maxItems: Math.min(params.maxJobsPerSource || 25, 100),
    };
  }

  protected mapItem(item: any): Job | null {
    const title = item.title || item.jobTitle;
    const company = item.company || item.companyName;
    const url = item.url || item.jobUrl || item.link || (item.company && item.id ? `https://jobs.lever.co/${item.company.toLowerCase()}/${item.id}` : null);
    const id = item.id || item.jobId || url;
    if (!title || !company || !url) return null;

    const now = new Date().toISOString();
    const description = cleanDescription(extractDescription(item) || item.description || '');
    const postedDate = normalizeIsoDate(item.postedDate || item.datePosted || item.createdAt);

    return {
      id: `lever-${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`,
      title: String(title).trim(),
      company: String(company).trim(),
      location: item.location || 'Remote',
      source: 'Lever',
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
