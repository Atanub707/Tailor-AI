import { Job, ScraperParams } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, normalizeIsoDate, parseSalary } from './apifyBase.js';
import { composeJobTypeTag } from './workMode.js';

// Jobo — ATS Jobs API (`jobo.world/ats-jobs-api`, $1.30 per 1K jobs).
//
// One normalized feed across 150+ ATS platforms (Greenhouse, Lever, Ashby,
// Workday, iCIMS, Taleo, SuccessFactors, …). The actor filters server-side by
// title/keywords, location, work model, employment type, experience level and
// posting date, so this scraper maps the app's search controls onto its
// input schema and normalizes the shared result shape onto Job.
//
// The chip is intentionally ONE source selector: `source` on every returned
// job is 'ATS Jobs', while the originating platform is preserved in
// `atsPlatform` (e.g. workday, icims) for diagnostics.

const DATE_FILTER: Record<string, string> = {
  '24h': '1 day ago',
  '7d': '7 days ago',
  '30d': '30 days ago',
};

const CONTRACT_MAP: Record<string, string> = {
  F: 'full-time',
  P: 'part-time',
  C: 'contract',
  T: 'temporary',
  I: 'internship',
};

const EXPERIENCE_MAP: Record<string, string[]> = {
  '1': ['intern'],
  '2': ['entry'],
  '3': ['entry', 'mid'],
  '4': ['mid', 'senior'],
  '5': ['lead'],
  '6': ['executive'],
};

const WORK_MODEL_MAP: Record<string, string> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'onsite',
};

function normalizeWorkMode(raw: string | undefined): 'Remote' | 'Hybrid' | 'On-site' | undefined {
  const s = String(raw || '').toLowerCase();
  if (/remote/.test(s)) return 'Remote';
  if (/hybrid/.test(s)) return 'Hybrid';
  if (/on.?site|office/.test(s)) return 'On-site';
  return undefined;
}

function compensationText(comp: any): string | undefined {
  if (!comp || (!comp.min && !comp.max)) return undefined;
  const money = (n: any) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
  };
  const min = money(comp.min);
  const max = money(comp.max);
  const range = min && max ? `${min} - ${max}` : min || max;
  return [range, comp.currency, comp.period ? `/${String(comp.period).toLowerCase()}` : ''].filter(Boolean).join(' ').trim();
}

export class AtsJobsScraper extends ApifyBaseScraper {
  readonly source = 'ATS Jobs' as const;
  readonly actorId = 'jobo.world~ats-jobs-api';

  // The actor supports a native posted_after input, so no second date filter.
  protected buildInput(params: ScraperParams): Record<string, any> {
    const keywords = String(params.keywords || '').trim();
    const input: Record<string, any> = {
      queries: keywords ? [keywords.slice(0, 200)] : [],
      // Title + curated alternative titles — the same relevance model the
      // other ATS sources use; description-only mentions are noise here.
      search_description: false,
      page: 1,
      page_size: Math.min(Math.max(params.maxJobsPerSource || 10, 1), 100),
      include_company_details: false,
    };

    const location = String(params.location || '').trim();
    if (location && !/^(remote|anywhere|worldwide|open to remote)$/i.test(location)) {
      input.locations = [location];
    }

    const workModel = WORK_MODEL_MAP[String(params.jobType || '')];
    if (workModel) input.work_models = [workModel];

    const employmentType = CONTRACT_MAP[String(params.contractType || '')];
    if (employmentType) input.employment_types = [employmentType];

    const levels = EXPERIENCE_MAP[String(params.experienceLevel || '')];
    if (levels) input.experience_levels = levels;

    const postedAfter = DATE_FILTER[String(params.datePostedFilter || 'all')];
    if (postedAfter) input.posted_after = postedAfter;

    return input;
  }

  protected mapItem(item: any): Job | null {
    const title = String(item?.title || '').trim();
    const listingUrl = String(item?.listing_url || item?.apply_url || '').trim();
    const applyUrl = String(item?.apply_url || item?.listing_url || '').trim();
    if (!title || !listingUrl) return null;

    const externalId = String(item?.id || listingUrl).trim();
    const companyObj = item?.company;
    const company = String(
      (typeof companyObj === 'string' ? companyObj : companyObj?.name) || 'Unknown Company',
    ).trim();
    const companyUrl = typeof companyObj === 'object' ? String(companyObj?.website || '').trim() || undefined : undefined;
    const companyId = typeof companyObj === 'object' ? String(companyObj?.id || '').trim() || undefined : undefined;

    const rawLocations: any[] = Array.isArray(item?.locations) ? item.locations : [];
    const locationLabels = rawLocations
      .map((l) => String(l?.location || [l?.city, l?.region, l?.country].filter(Boolean).join(', ')).trim())
      .filter(Boolean);
    const location = locationLabels[0] || 'Global';

    const description =
      cleanDescription(item?.description) ||
      cleanDescription(item?.summary) ||
      'Description not available';

    const workMode = normalizeWorkMode(item?.workplace_type);
    const employment = String(item?.employment_type || '').trim() || undefined;
    const compensation = item?.compensation || {};
    const salaryText = compensationText(compensation);
    const parsedSalary = parseSalary(salaryText);
    const salaryMin = Number.isFinite(Number(compensation?.min)) && Number(compensation?.min) > 0
      ? Number(compensation.min)
      : parsedSalary.min;
    const salaryMax = Number.isFinite(Number(compensation?.max)) && Number(compensation?.max) > 0
      ? Number(compensation.max)
      : parsedSalary.max;

    const postedDate = normalizeIsoDate(item?.date_posted || item?.created_at);
    const platform = String(item?.source || '').trim() || undefined;
    const now = new Date().toISOString();

    return {
      id: `atsjobs-${externalId}`,
      externalId,
      title,
      company,
      companyId,
      companyUrl,
      location,
      locations: locationLabels,
      description,
      descriptionAvailable: description !== 'Description not available',
      url: listingUrl,
      applyUrl,
      jobUrl: listingUrl,
      source: 'ATS Jobs',
      atsPlatform: platform,
      provider: 'apify',
      jobType: composeJobTypeTag(employment, workMode, workMode === 'Remote'),
      remote: workMode === 'Remote' ? true : undefined,
      workMode,
      employmentType: employment,
      experienceLevel: String(item?.experience_level || '').trim() || undefined,
      salaryText,
      salaryMin,
      salaryMax,
      postedDate: postedDate || undefined,
      postedDateParsed: postedDate ? postedDate.split('T')[0] : undefined,
      postedDateSemantics: postedDate ? 'published' : 'unknown',
      fingerprint: `atsjobs-${externalId}`,
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
