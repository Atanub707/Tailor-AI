import { Job, ScraperParams } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, normalizeIsoDate, parseSalary } from './apifyBase.js';
import { composeJobTypeTag } from './workMode.js';

// Reed.co.uk via Apify actor `fetch_cat/reed-co-uk-jobs-scraper`
// ($0.005/run + $0.05 per 1K listings). Replaces the old HTML scrape: the
// actor returns structured salary, work-mode, contract, sector, employer and
// (with includeDetails) the full posting description — the surface tailoring
// consumes. Dates are filtered server-side by Reed itself.

const DATE_FILTER: Record<string, string> = {
  '24h': 'today',
  '7d': 'last7days',
  '30d': 'last30days',
};

const CONTRACT_MAP: Record<string, string> = {
  'Full-time': 'fullTime',
  'Part-time': 'partTime',
  Contract: 'contract',
  Temporary: 'temporary',
};

const REMOTE_INPUT: Record<string, string> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'onSite',
};

export class ReedScraper extends ApifyBaseScraper {
  readonly source = 'Reed' as const;
  readonly actorId = 'fetch_cat~reed-co-uk-jobs-scraper';

  protected buildInput(params: ScraperParams): Record<string, any> {
    const input: Record<string, any> = {
      queries: [params.keywords.trim()].filter(Boolean),
      maxItems: Math.min(Math.max(params.maxJobsPerSource || 10, 1), 200),
      // Full description text/HTML is what Tailor + Score consume.
      includeDetails: true,
      postedBy: 'any',
      maxRunSeconds: 240,
      proxyConfiguration: { useApifyProxy: false },
    };

    const location = (params.location || '').trim();
    if (location && !/^(remote|anywhere|worldwide|open to remote)$/i.test(location)) {
      input.location = location;
      input.radius = 10;
    }

    const datePosted = DATE_FILTER[String(params.datePostedFilter || 'all')];
    if (datePosted) input.datePosted = datePosted;

    const contract = CONTRACT_MAP[String(params.contractType || '')];
    if (contract) input.jobType = contract;

    const remote = REMOTE_INPUT[String(params.jobType || '')];
    if (remote) input.remoteOption = remote;

    return input;
  }

  protected mapItem(item: any): Job | null {
    const title = String(item?.title || '').trim();
    const url = String(item?.jobUrl || '').trim();
    const externalId = String(item?.reedJobId || '').trim() || url;
    if (!title || !url) return null;

    // Work-mode truth: Reed exposes it explicitly — never text-classify.
    const remoteRaw = String(item?.remoteWorkingOption || '').toLowerCase();
    const workMode = /remote/.test(remoteRaw)
      ? 'Remote'
      : /hybrid/.test(remoteRaw)
        ? 'Hybrid'
        : /on.?site|office/.test(remoteRaw)
          ? 'On-site'
          : undefined;

    const description =
      cleanDescription(item?.descriptionText) ||
      cleanDescription(item?.descriptionHtml) ||
      cleanDescription(item?.descriptionSnippet);

    const salaryText = String(item?.salary || '').trim() || undefined;
    const parsedSalary = parseSalary(salaryText);
    const rawMin = Number(item?.salaryMinimum);
    const rawMax = Number(item?.salaryMaximum);
    const salaryMin = Number.isFinite(rawMin) ? rawMin : parsedSalary.min;
    const salaryMax = Number.isFinite(rawMax) ? rawMax : parsedSalary.max;

    const postedDate = normalizeIsoDate(item?.postedAt || item?.updatedAt);
    const employment = String(item?.jobType || item?.contractType || '').trim() || undefined;
    const applyUrl = String(item?.externalApplyUrl || url).trim();
    const now = new Date().toISOString();

    return {
      id: `reed-${externalId}`,
      externalId,
      title,
      company: String(item?.companyName || 'Unknown Company').trim(),
      companyId: String(item?.employerId || item?.companyName || '').trim(),
      location: String(item?.location || '').trim() || 'UK',
      description: description || 'Description not available',
      url,
      applyUrl,
      source: 'Reed',
      jobUrl: url,
      jobType: composeJobTypeTag(employment, workMode, workMode === 'Remote'),
      remote: workMode === 'Remote' ? true : undefined,
      workMode,
      postedDate: postedDate || undefined,
      postedDateParsed: postedDate ? postedDate.split('T')[0] : undefined,
      salaryText,
      salaryMin,
      salaryMax,
      provider: 'apify',
      fingerprint: `reed-${externalId}`,
      scrapedAt: now,
      createdAt: now,
      updatedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
      state: 'pending',
    } as unknown as Job;
  }
}
