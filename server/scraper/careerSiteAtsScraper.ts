import { Job, JobSource, ScraperParams } from '../../src/types.js';
import { ApifyBaseScraper, cleanDescription, normalizeIsoDate } from './apifyBase.js';
import { composeJobTypeTag } from './workMode.js';
import { pickBoardUrls } from '../providers/directAtsProvider.js';

// Career-site ATS sources via one Apify actor
// (`memo23/career-site-ats-jobs-api`, from $2.50/1K rows + start event).
//
// The actor is company-driven: there is NO "all companies on this ATS" mode.
// Per-source ISOLATION therefore works like this:
//   1. input = startUrls pinned to boards of the SELECTED platform (from the
//      company_career_sites registry) — never `organizations`, whose ATS
//      auto-detection could resolve a different platform;
//   2. output = rows are dropped unless `item.ats` matches this source.
// Greenhouse/Lever/Ashby/SmartRecruiters never come through here — they use
// their free direct APIs.

export interface CareerAtsSpec {
  source: JobSource;
  platform: string;
  /** The actor's own `ats` id(s) for this platform (isolation check). */
  actorAts: string[];
}

export const CAREER_ATS_SPECS: CareerAtsSpec[] = [
  { source: 'Workable', platform: 'workable', actorAts: ['workable'] },
  { source: 'BambooHR', platform: 'bamboohr', actorAts: ['bamboohr'] },
  { source: 'Personio', platform: 'personio', actorAts: ['personio'] },
  { source: 'Recruitee', platform: 'recruitee', actorAts: ['recruitee'] },
  { source: 'Teamtailor', platform: 'teamtailor', actorAts: ['teamtailor'] },
  { source: 'JazzHR', platform: 'jazzhr', actorAts: ['jazzhr'] },
  { source: 'Pinpoint', platform: 'pinpoint', actorAts: ['pinpoint'] },
];

const SPEC_BY_SOURCE = new Map(CAREER_ATS_SPECS.map((s) => [s.source, s]));

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export class CareerSiteAtsScraper extends ApifyBaseScraper {
  readonly source: JobSource;
  readonly actorId = 'memo23~career-site-ats-jobs-api';
  private readonly spec: CareerAtsSpec;
  protected readonly applyPostedWindowFilter = true;
  private boardUrls: string[] = [];

  constructor(source: JobSource) {
    super();
    const spec = SPEC_BY_SOURCE.get(source);
    if (!spec) throw new Error(`No career-site ATS spec for ${source}`);
    this.source = source;
    this.spec = spec;
  }

  async scrape(params: ScraperParams): Promise<Job[]> {
    const cap = clamp(params.maxJobsPerSource || 15, 1, 50);
    // ATS boards are individually small and many are dormant — sample a wide
    // slice (priorities are always included by pickBoardUrls) so a search has
    // real recall. Billing is bounded by maxItemsTotal, not by board count.
    const boardCount = Math.min(80, Math.max(48, cap * 6));
    const boards = pickBoardUrls(this.spec.platform, boardCount);
    if (!boards.length) {
      this.lastError = `No ${this.source} boards are indexed yet — add companies on ${this.source} to the career-site registry to search this source.`;
      return [];
    }
    this.boardUrls = boards.map((b) => b.careerUrl);
    const jobs = await super.scrape(params);
    return jobs.slice(0, cap);
  }

  protected buildInput(params: ScraperParams): Record<string, any> {
    const limit = clamp(params.maxJobsPerSource || 15, 1, 50);
    const boards = this.boardUrls.length ? this.boardUrls : pickBoardUrls(this.spec.platform, limit).map((b) => b.careerUrl);

    const input: Record<string, any> = {
      startUrls: boards,
      // Per-company vs global billing caps: the global cap is what we pay.
      maxItems: Math.max(3, Math.ceil(limit / Math.max(boards.length, 1)) + 2),
      maxItemsTotal: limit,
      includeDescription: true,
      enrichEmails: false,
      includeRawJson: false,
      includeQuestions: false,
      translateToEnglish: false,
      maxConcurrency: Math.min(8, Math.max(2, boards.length)),
    };

    // Broad actor-side keyword (single term) for recall — the local
    // relevance guard makes the final cut. The actor's `keywords` also match
    // skills/description, so "devops" catches Backend/Platform roles whose
    // body mentions it; multi-word AND matching would starve results.
    const firstTerm = String(params.keywords || '').trim().split(/\s+/).find((t) => t.length > 2);
    if (firstTerm) input.keywords = firstTerm;

    const location = String(params.location || '').trim();
    if (location && !/^(remote|anywhere|worldwide|open to remote)$/i.test(location)) {
      input.location = location;
    }

    const windows: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30 };
    const days = windows[String(params.datePostedFilter || 'all')];
    if (days && days > 1) {
      input.postedAfter = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    }

    const employment: Record<string, string> = {
      'Full-time': 'full',
      'Part-time': 'part',
      Contract: 'contract',
      Temporary: 'temporary',
      Internship: 'intern',
    };
    const stem = employment[String(params.contractType || '')];
    if (stem) input.employmentType = stem;

    // NOTE: no actor-side `remoteOnly` — it drops rows whose work mode is
    // merely UNKNOWN. Work-mode truth is applied locally from explicit
    // fields (workplaceType/isRemote) and only explicit contradictions are
    // removed for a Remote search.
    return input;
  }

  protected mapItem(item: any): Job | null {
    // ISOLATION: a row from any other ATS must never enter this source.
    const ats = String(item?.ats || '').toLowerCase();
    if (!this.spec.actorAts.includes(ats)) return null;

    const title = String(item?.title || '').trim();
    const url = String(item?.jobUrl || item?.applyUrl || '').trim();
    if (!title || !url) return null;

    const globalId = String(item?.globalId || '').trim() || `${ats}:${String(item?.org || '')}:${url}`;
    const workplace = String(item?.workplaceType || '').toLowerCase();
    const workMode = item?.isRemote === true || /remote/.test(workplace)
      ? 'Remote'
      : /hybrid/.test(workplace)
        ? 'Hybrid'
        : /on.?site|office/.test(workplace)
          ? 'On-site'
          : undefined;

    const description =
      cleanDescription(String(item?.descriptionText || '')) ||
      cleanDescription(String(item?.descriptionHtml || ''));

    const postedDate = normalizeIsoDate(item?.publishedAt);
    const now = new Date().toISOString();
    const applyUrl = String(item?.applyUrl || url).trim();

    return {
      id: `careerats-${globalId}`,
      externalId: globalId,
      title,
      company: String(item?.company || item?.org || 'Unknown Company').trim(),
      companyId: String(item?.org || item?.company || '').trim(),
      location: String(item?.location || (Array.isArray(item?.locations) ? item.locations[0] : '') || '').trim() || undefined,
      description,
      url,
      applyUrl,
      source: this.source,
      atsPlatform: this.spec.platform,
      jobUrl: url,
      jobType: composeJobTypeTag(String(item?.employmentType || ''), workMode, workMode === 'Remote'),
      remote: workMode === 'Remote' ? true : undefined,
      workMode,
      postedDate: postedDate || undefined,
      postedDateParsed: postedDate ? postedDate.split('T')[0] : undefined,
      postedDateSemantics: postedDate ? 'published' : 'unknown',
      provider: 'apify',
      fingerprint: `careerats-${globalId}`,
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
