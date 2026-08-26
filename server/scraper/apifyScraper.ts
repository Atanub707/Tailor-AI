import { Job, JobSource, ScraperParams } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, extractDescription, normalizeIsoDate, parseApplicants, parseSalary } from './apifyBase.js';
import { classifyFromText } from './workMode.js';

// LinkedIn source via Apify's cloud scraper (valig/linkedin-jobs-scraper).
// Used when the user enables it in Settings with an Apify API token.
// The factory falls back to the built-in free LinkedIn scraper when this
// returns nothing (builtInFallback in the source registry).

const DATE_PARAMS: Record<string, string> = {
  '24h': 'r86400',
  '7d': 'r604800',
  '30d': 'r2592000',
};

// LinkedIn's native f_WT codes: 1=On-site, 2=Remote, 3=Hybrid — applied by
// LinkedIn itself, the strongest work-type guarantee available.
const REMOTE_PARAMS: Record<string, string[]> = {
  remote: ['2'],
  hybrid: ['3'],
  onsite: ['1'],
};

export class ApifyLinkedInScraper extends ApifyBaseScraper {
  readonly source: JobSource = 'LinkedIn';
  readonly actorId = 'valig~linkedin-jobs-scraper';

  protected buildInput(params: ScraperParams): Record<string, any> {
    const input: Record<string, any> = {
      title: params.keywords.trim(),
      limit: Math.min(params.maxJobsPerSource || 25, 1000),
    };
    const location = params.location?.trim() || '';
    if (location && !/^(remote|anywhere|worldwide|open to remote)$/i.test(location)) {
      input.location = location;
    }
    if (params.datePostedFilter && params.datePostedFilter !== 'all' && DATE_PARAMS[params.datePostedFilter]) {
      input.datePosted = DATE_PARAMS[params.datePostedFilter];
    }
    if (params.jobType && params.jobType !== 'all' && REMOTE_PARAMS[params.jobType]) {
      input.remote = REMOTE_PARAMS[params.jobType];
    }
    if (params.experienceLevel) {
      input.experienceLevel = [params.experienceLevel];
    }
    if (params.contractType) {
      input.contractType = [params.contractType];
    }
    if (params.jobIds && params.jobIds.length > 0) {
      input.skipJobId = params.jobIds;
    }
    const start = (params as any).start;
    if (typeof start === 'number' && start > 0) {
      input.start = start;
    }
    return input;
  }

  protected mapItem(item: any): Job | null {
    const title = item.title;
    const id = item.id;
    if (!title || !id) return null;
    const now = new Date().toISOString();
    const applicants = parseApplicants(item.applicationsCount);
    const salary = parseSalary(item.salary);
    const rawDescription = extractDescription(item);
    if (!rawDescription) {
      console.warn(`[Apify] No description field matched for LinkedIn job "${title}" (id=${id}). Actual item keys: ${Object.keys(item || {}).join(', ')}`);
    }

    const finalPosted = normalizeIsoDate(item.postedDate, String(item.postedTimeAgo || ''));

    // valig's 'workType' is job function, not work mode. The work-type
    // guarantee comes from LinkedIn's native f_WT search filter; label from
    // description evidence only — never guess.
    const cleanedDescription = cleanDescription(rawDescription);
    const detectedMode = classifyFromText(cleanedDescription);
    const jobType = detectedMode ? `Full-time · ${detectedMode}` : 'Full-time';

    return {
      id: `linkedin-${id}`,
      title,
      company: item.companyName || 'Unknown Company',
      location: item.location || '',
      source: 'LinkedIn',
      description: cleanedDescription || 'Description not available',
      url: item.url || `https://www.linkedin.com/jobs/view/${id}`,
      postedDate: finalPosted,
      ...(finalPosted ? { postedDateParsed: finalPosted.slice(0, 10) } : {}),
      ...(salary.text ? { salaryText: salary.text } : {}),
      ...(salary.min !== undefined ? { salaryMin: salary.min } : {}),
      ...(salary.max !== undefined ? { salaryMax: salary.max } : {}),
      jobType,
      ...(applicants.count !== undefined ? { applicantCount: applicants.count } : {}),
      ...(applicants.caption ? { applicantCaption: applicants.caption } : {}),
      ...(applicants.lowCompetition ? { lowCompetition: true } : {}),
      ...(item.recruiterName ? { recruiterName: String(item.recruiterName) } : {}),
      ...(item.recruiterUrl ? { recruiterUrl: String(item.recruiterUrl) } : {}),
      ...(item.experienceLevel ? { experienceLevel: String(item.experienceLevel) } : {}),
      ...(item.contractType ? { contractType: String(item.contractType) } : {}),
      ...(item.companyUrl ? { companyUrl: String(item.companyUrl) } : {}),
      ...(item.applyType ? { applyType: String(item.applyType) } : {}),
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  }
}
