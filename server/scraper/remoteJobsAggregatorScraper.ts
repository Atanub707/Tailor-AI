import { Job, ScraperParams } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, extractDescription, normalizeIsoDate, parseSalary } from './apifyBase.js';
import { composeJobTypeTag } from './workMode.js';

// Remote Boards source — Apify actor `memo23/remote-jobs-aggregator`
// (Apache-2.0, community). One run aggregates SEVEN remote boards (RemoteOK
// full-depth, WeWorkRemotely, Remotive, Himalayas, Jobicy, Arbeitnow,
// Relomote) into one cross-board-deduplicated schema with salary ranges and
// geo eligibility; opt-in Relomote relocation adds on-site jobs with
// relocation/visa sponsorship. $1.99 / 1K jobs (billed by Apify).
//
// Work-mode truth: every default row IS a remote job (the actor's remote
// boards only); relocation rows are on-site by definition and only requested
// when the user explicitly searches On-site. Nothing here classifies the work
// mode from text.

const REMOTE_BOARDS = ['remoteok', 'weworkremotely', 'remotive', 'himalayas', 'jobicy', 'arbeitnow', 'relomote'];
const RELOCATION_BOARD = ['relomote_relocation'];

const TIME_FILTERS: Record<string, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
};

const CONTRACT_MAP: Record<string, string> = {
  'Full-time': 'FULL_TIME',
  'Part-time': 'PART_TIME',
  Contract: 'CONTRACT',
  Temporary: 'TEMPORARY',
  Internship: 'INTERNSHIP',
};

export class RemoteJobsAggregatorScraper extends ApifyBaseScraper {
  readonly source = 'RemoteJobs' as const;
  readonly actorId = 'memo23~remote-jobs-aggregator';

  protected buildInput(params: ScraperParams): Record<string, any> {
    const wantsOnsite = params.jobType === 'onsite';
    const input: Record<string, any> = {
      // Relocation/visa board is on-site by design — only for explicit
      // On-site searches; every default run stays purely remote.
      sources: wantsOnsite ? RELOCATION_BOARD : REMOTE_BOARDS,
      dedupe: true,
      includeDescription: true, // full descriptions are what tailoring consumes
      cleanHtml: true, // plain-text only — no HTML payload for the LLM path
      maxItems: Math.min(Math.max(params.maxJobsPerSource || 20, 1), 200),
    };

    const keywords = (params.keywords || '').trim();
    if (keywords) input.searchKeyword = keywords;

    // Country constraint: only for single-token locations (a country name or
    // ISO-2 code the actor understands). City strings ("Bengaluru, India")
    // and Remote/Worldwide must NOT become bogus country filters.
    const location = (params.location || '').trim();
    if (location && !/^(remote|anywhere|worldwide|open to remote)$/i.test(location) && !location.includes(',')) {
      input.countries = [location];
    }

    if (params.datePostedFilter && TIME_FILTERS[params.datePostedFilter]) {
      input.timeFilter = TIME_FILTERS[params.datePostedFilter];
    }

    const contract = CONTRACT_MAP[String(params.contractType || '')];
    if (contract) input.jobTypes = [contract];

    return input;
  }

  protected mapItem(item: any): Job | null {
    const title = String(item?.title || '').trim();
    const url = String(item?.url || item?.applyUrl || '').trim();
    if (!title || !url) return null;

    const externalId = String(item?.sourceJobId || item?.id || url);
    const sourceName = String(item?.source || '').toLowerCase();
    const workArrangement = String(item?.workArrangement || '').toLowerCase();
    // On-site only exists on the relocation board (relocation/visa jobs).
    const isOnsite = sourceName === 'relomote_relocation' || (!!workArrangement && workArrangement !== 'remote' && item?.relocationOffered === true);
    const workMode = isOnsite ? 'On-site' : 'Remote';

    const employmentType = Array.isArray(item?.employmentType) ? item.employmentType[0] : item?.employmentType;

    let salaryText = String(item?.salaryText || '').trim() || undefined;
    const salary = item?.salary && typeof item.salary === 'object' ? item.salary : null;
    if (salary && (salary.min != null || salary.max != null)) {
      const range = salary.min != null && salary.max != null ? `${salary.min}-${salary.max}` : String(salary.min ?? salary.max);
      const unit = salary.unit ? `/${String(salary.unit).toLowerCase()}` : '';
      salaryText = [salary.currency || 'USD', range + unit].join(' ').trim();
    }
    const parsedSalary = parseSalary(salaryText);
    const salaryMin = salary?.min != null ? Number(salary.min) : parsedSalary.min;
    const salaryMax = salary?.max != null ? Number(salary.max) : parsedSalary.max;

    const description = cleanDescription(extractDescription(item));
    const now = new Date().toISOString();

    return {
      id: `remotejobs-${externalId}`,
      externalId,
      title,
      company: String(item?.companyName || '').trim(),
      companyId: String(item?.companyName || '').trim(),
      location: String(item?.location || '').trim() || undefined,
      description,
      url,
      applyUrl: String(item?.applyUrl || url).trim(),
      source: 'RemoteJobs' as const,
      atsPlatform: undefined,
      jobUrl: url,
      jobType: composeJobTypeTag(typeof employmentType === 'string' ? employmentType : undefined, workMode, workMode === 'Remote'),
      // Explicit work-mode truth — never text-classified.
      remote: workMode === 'Remote',
      workMode,
      postedDate: normalizeIsoDate(item?.postedDate) || undefined,
      postedDateSemantics: item?.postedDate ? 'published' : 'unknown',
      salaryText,
      salaryMin,
      salaryMax,
      provider: 'apify',
      fingerprint: `remotejobs-${externalId}`,
      scrapedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
      state: 'pending',
    } as unknown as Job;
  }
}
