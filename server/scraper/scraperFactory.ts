import { LinkedInScraper } from './linkedInScraper.js';
import { LinkedInPostsScraper } from './linkedInPostsScraper.js';
import { ApifyLinkedInScraper } from './apifyScraper.js';
import { IndeedScraper } from './indeedScraper.js';
import { NaukriScraper } from './naukriScraper.js';
import { GlassdoorScraper } from './glassdoorScraper.js';
import { UpworkScraper } from './upworkScraper.js';
import { isCrawlingAllowed } from './robotsGuard.js';
import { ArbeitnowScraper } from './arbeitnowScraper.js';
import { SimplyHiredScraper } from './simplyHiredScraper.js';
import { DiceScraper } from './diceScraper.js';
import { ReedScraper } from './reedScraper.js';
import { RemoteOkScraper } from './remoteOkScraper.js';
import { WeWorkRemotelyScraper } from './weWorkRemotelyScraper.js';
import { MyCareersFutureScraper } from './myCareersFutureScraper.js';
import { CutshortScraper } from './cutshortScraper.js';
import { GupyScraper } from './gupyScraper.js';
import { JobsChScraper } from './jobsChScraper.js';
import { DaijobScraper } from './daijobScraper.js';
import { MyJobMagScraper } from './myJobMagScraper.js';
import { Job, JobSource, ScraperParams } from '../../src/types.js';
import { loadConfig } from '../config.js';
import { SOURCES } from '../../src/constants/sources.js';
import { contradictsWanted } from './workMode.js';
import { ApifyBaseScraper } from './apifyBase.js';
import { SantaMariaApifyProvider } from '../providers/santaMariaProvider.js';
import { isWithinPostedWindow, applyRelevanceGuard } from '../storage/v2Tables.js';

// Apify-powered sources — constructed from the shared registry (Task 1).
const APIFY_SCRAPERS: Partial<Record<JobSource, () => ApifyBaseScraper>> = {
  LinkedIn: () => new ApifyLinkedInScraper(),
  Indeed: () => new IndeedScraper(),
  Naukri: () => new NaukriScraper(),
  Glassdoor: () => new GlassdoorScraper(),
  Upwork: () => new UpworkScraper(),
};

// ATS-25 sources (Greenhouse, Lever, Ashby, Workable, Workday, SmartRecruiters,
// …) all route through the ONE Santa Maria actor — never per-ATS scrapers.
// The selected source's platform filters the company_career_sites registry.
// EXCEPTION: the four ATS with FREE public job APIs (Greenhouse, Lever, Ashby,
// SmartRecruiters) are fetched directly — zero Apify credits. Santa Maria is
// the fallback for the rest.
export const ATS_PLATFORM_BY_SOURCE: Partial<Record<JobSource, string>> = {
  Greenhouse: 'greenhouse',
  Lever: 'lever',
  Ashby: 'ashby',
  Workable: 'workable',
  Workday: 'workday',
  SmartRecruiters: 'smartrecruiters',
  Teamtailor: 'teamtailor',
  Personio: 'personio',
  BambooHR: 'bamboohr',
  Rippling: 'rippling',
  JazzHR: 'jazzhr',
  Recruitee: 'recruitee',
  iCIMS: 'icims',
  Jobvite: 'jobvite',
  Comeet: 'comeet',
  Pinpoint: 'pinpoint',
  Join: 'join',
};

// Free public job APIs — fetched directly, never through the paid actor.
// SmartRecruiters EXCLUDED: its public API uses per-company tenant slugs that
// differ from careers-site slugs (the open directory lists stale/404 slugs),
// so it goes through the Santa Maria actor which knows the correct mapping.
const FREE_API_SOURCES: Partial<Record<JobSource, string>> = {
  Greenhouse: 'greenhouse',
  Lever: 'lever',
  Ashby: 'ashby',
};

async function scrapeAtsViaSantaMaria(source: JobSource, params: ScraperParams): Promise<Job[]> {
  const platform = ATS_PLATFORM_BY_SOURCE[source];

  // Free public APIs first — Greenhouse/Lever/Ashby/SmartRecruiters need no
  // Apify credits. The paid actor is ONLY for the other ATS.
  const freePlatform = FREE_API_SOURCES[source];
  if (freePlatform) {
    const { scrapeDirectAts } = await import('../providers/directAtsProvider.js');
    const jobs = await scrapeDirectAts(source, freePlatform, params.keywords.trim().split(/\s+/).filter(Boolean), params.maxJobsPerSource || 15);
    return jobs.map((j) => ({ ...j, source, atsPlatform: platform || (j as any).atsPlatform }));
  }

  const provider = new SantaMariaApifyProvider();
  const result = await provider.search({
    keywords: params.keywords.trim().split(/\s+/).filter(Boolean),
    locations: params.location && params.location !== 'Remote' ? [params.location] : undefined,
    atsPlatforms: platform ? [platform as any] : undefined,
    limit: Math.min(params.maxJobsPerSource || 15, 50),
    queries: [], // provider reads the registry itself (filtered by platform)
  });
  // Tag with the source the user selected (e.g. "Greenhouse"), not "Custom" —
  // so the dashboard source filter and ATS badge work correctly.
  return result.jobs.map((j) => ({ ...j, source, atsPlatform: platform || (j as any).atsPlatform }));
}

export class ScraperFactory {
  // Populated by the last runScrape: sources skipped (robots.txt or Apify gate).
  static lastSkippedSources: { source: string; reason: string }[] = [];
  static async runScrape(params: ScraperParams): Promise<Job[]> {
    const sources = params.sources || ['LinkedIn'];
    let allJobs: Job[] = [];
    ScraperFactory.lastSkippedSources = [];

    // Good-faith crawler check: resolve robots.txt once per domain (parallel,
    // cached 1h) and skip sources whose sites disallow crawling. Only applies
    // to sources we crawl directly — Apify-powered sources run on Apify's
    // infrastructure and are never in SOURCE_DOMAINS.
    const SOURCE_DOMAINS: Record<string, string> = {
      LinkedIn: 'www.linkedin.com',
      Arbeitnow: 'arbeitnow.com',
      SimplyHired: 'www.simplyhired.com',
      Dice: 'www.dice.com',
      Reed: 'www.reed.co.uk',
      RemoteOK: 'remoteok.com',
      WeWorkRemotely: 'weworkremotely.com',
      MyCareersFuture: 'www.mycareersfuture.gov.sg',
      Cutshort: 'cutshort.io',
      Gupy: 'portal.gupy.io',
      JobsCh: 'jobs.ch',
      Daijob: 'daijob.com',
      MyJobMag: 'myjobmag.com',
    };
    let robotsAllowed = new Map<string, boolean>();
    const respectRobotsTxt = loadConfig().scraper.respectRobotsTxt !== false;
    if (respectRobotsTxt) {
      const domains = [...new Set(sources.map((s) => SOURCE_DOMAINS[s]).filter(Boolean))];
      const robotsResults = await Promise.all(
        domains.map(async (d) => [d, await isCrawlingAllowed(d)] as const)
      );
      robotsAllowed = new Map<string, boolean>(robotsResults);
    }

    for (const source of sources) {
      const domain = SOURCE_DOMAINS[source];
      const meta = SOURCES[source];
      // Locked sources (paid/enterprise-only ATS APIs — BambooHR, Workday,
      // iCIMS, JazzHR, Jobvite, Personio, Recruitee, Rippling, Pinpoint,
      // Teamtailor) are disabled until a free route exists. Enforced server-side
      // too — never spend Apify credits on them.
      if (meta?.locked) {
        console.warn(`[ScraperFactory] ${source}: skipped — paid/enterprise-only API (locked)`);
        ScraperFactory.lastSkippedSources.push({ source, reason: 'paid/enterprise-only API — locked until free access is available' });
        continue;
      }
      const isApifySource = !!meta?.apifyActorId;
      // robots.txt only governs sources WE crawl directly. Apify-powered
      // sources run on Apify's infrastructure — their actors do the crawling
      // — so the guard must never skip them (LinkedIn was wrongly skipped
      // before this fix). The built-in LinkedIn fallback still checks it.
      const robotsBlocked = respectRobotsTxt && domain && robotsAllowed.get(domain) === false;
      if (!isApifySource && robotsBlocked) {
        console.warn(`[ScraperFactory] ${source}: skipped — robots.txt disallows crawling (${domain}/robots.txt)`);
        ScraperFactory.lastSkippedSources.push({ source, reason: `robots.txt disallows automated access (${domain})` });
        continue;
      }

      try {
        let jobs: Job[] = [];

        // Plan B: ATS-25 sources route through the single Santa Maria actor.
        if (ATS_PLATFORM_BY_SOURCE[source]) {
          const apifyConfig = loadConfig().apify;
          const apifyAvailable = apifyConfig.enabled && !!apifyConfig.token?.trim();
          if (!apifyAvailable) {
            ScraperFactory.lastSkippedSources.push({ source, reason: 'requires Apify API key — enable in Settings' });
            continue;
          }
          jobs = await scrapeAtsViaSantaMaria(source, params);
        } else if (meta?.apifyActorId) {
          // Apify path — generic for all Apify-powered sources.
          const apifyConfig = loadConfig().apify;
          const apifyAvailable = apifyConfig.enabled && !!apifyConfig.token?.trim();
          if (meta.needsApify && !apifyAvailable) {
            ScraperFactory.lastSkippedSources.push({ source, reason: 'requires Apify API key — enable in Settings' });
            continue;
          }
          const make = APIFY_SCRAPERS[source];
          if (make) {
            const scraper = make();
            jobs = await scraper.scrape(params);
            if (jobs.length === 0 && scraper.lastError) {
              ScraperFactory.lastSkippedSources.push({ source, reason: scraper.lastError });
            }
          }
          // LinkedIn only: Apify → built-in free scraper fallback (respects
          // robots.txt since we would be crawling linkedin.com ourselves).
          if (meta.builtInFallback && jobs.length === 0) {
            if (robotsBlocked) {
              ScraperFactory.lastSkippedSources.push({ source, reason: `robots.txt disallows automated access (${domain})` });
            } else {
              jobs = await new LinkedInScraper().scrape(params);
            }
          }
        } else if (source === 'LinkedInPosts') {
          jobs = await new LinkedInPostsScraper().scrape(params);
        } else if (source === 'Arbeitnow') {
          jobs = await new ArbeitnowScraper().scrape(params);
        } else if (source === 'SimplyHired') {
          jobs = await new SimplyHiredScraper().scrape(params);
        } else if (source === 'Dice') {
          jobs = await new DiceScraper().scrape(params);
        } else if (source === 'Reed') {
          jobs = await new ReedScraper().scrape(params);
        } else if (source === 'RemoteOK') {
          jobs = await new RemoteOkScraper().scrape(params);
        } else if (source === 'WeWorkRemotely') {
          jobs = await new WeWorkRemotelyScraper().scrape(params);
        } else if (source === 'MyCareersFuture') {
          jobs = await new MyCareersFutureScraper().scrape(params);
        } else if (source === 'Cutshort') {
          jobs = await new CutshortScraper().scrape(params);
        } else if (source === 'Gupy') {
          jobs = await new GupyScraper().scrape(params);
        } else if (source === 'JobsCh') {
          jobs = await new JobsChScraper().scrape(params);
        } else if (source === 'Daijob') {
          jobs = await new DaijobScraper().scrape(params);
        } else if (source === 'MyJobMag') {
          jobs = await new MyJobMagScraper().scrape(params);
        } else {
          console.warn(`[ScraperFactory] Unknown source: ${source}, skipping`);
          continue;
        }
        allJobs.push(...jobs);
        console.log(`[ScraperFactory] ${source}: ${jobs.length} jobs`);
      } catch (err: any) {
        // Isolate failures: one broken source must not abort the rest.
        // BUT never swallow the reason — surface it as a skipped source so
        // the UI shows "Greenhouse (Apify: Monthly usage hard limit exceeded)"
        // instead of a misleading "No results in the selected window".
        const reason = String(err?.message || err).slice(0, 200);
        console.warn(`[ScraperFactory] ${source} failed: ${reason}`);
        ScraperFactory.lastSkippedSources.push({ source, reason });
      }
    }

    // Work-mode guarantee across ALL sources: a remote request must never
    // ADD jobs explicitly labeled Hybrid/On-site (and vice versa).
    if (params.jobType && params.jobType !== 'all') {
      const wanted = params.jobType as 'remote' | 'hybrid' | 'onsite';
      const before = allJobs.length;
      const filtered = allJobs.filter((j) => !contradictsWanted(j.jobType, wanted));
      if (filtered.length !== before) {
        console.log(`[ScraperFactory] Work-mode guard: ${before - filtered.length} jobs dropped (contradict ${wanted} search)`);
      }
      allJobs = filtered;
    }

    // Posted-window guarantee across ALL sources: "Last 24 hours" filters by
    // the job's posting time, never the scrape time. Jobs with an unknown
    // posting date fail the window (honest — can't prove freshness).
    if (params.datePostedFilter && params.datePostedFilter !== 'all') {
      const before = allJobs.length;
      allJobs = allJobs.filter((j) => isWithinPostedWindow(j, params.datePostedFilter));
      if (allJobs.length !== before) {
        console.log(`[ScraperFactory] Posted-window guard: ${before - allJobs.length} jobs dropped (older than ${params.datePostedFilter})`);
      }
    }

    // Relevance guarantee across ALL sources — QUERY-AWARE scoring: the query
    // decides the vocabulary ("DevOps Engineer" ≠ "Cyber Security Engineer").
    // A job scores > 0 when its title/company contains the query term, matches
    // the category's strong titles (DevOps/SRE/…), or pairs an adjacent infra
    // word with an engineering role word. Sales/PM/Data titles score 0 — they
    // can never pass, whatever the query says.
    const query = (params.keywords || '').trim();
    if (query) {
      const before = allJobs.length;
      // UNCONDITIONAL relevance guard: a fully-irrelevant slice must never
      // survive. When a board returns only unrelated roles (all score 0), the
      // result is [] and nothing from that provider is persisted. Previously
      // the `if (relevant.length > 0)` guard skipped the filter exactly when a
      // board's fresh slice was entirely irrelevant — leaking Account Exec /
      // Data Engineer / Customer Success jobs into the DB.
      allJobs = applyRelevanceGuard(allJobs, query);
      if (allJobs.length !== before) {
        console.log(`[ScraperFactory] Relevance guard: ${before - allJobs.length} jobs dropped (score 0 for "${query}")`);
      }
    }

    return allJobs;
  }
}
