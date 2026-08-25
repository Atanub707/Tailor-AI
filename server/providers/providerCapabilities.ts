export interface ProviderCapabilities {
  keywordFilter: boolean;
  locationFilter: boolean;
  postedDateFilter: boolean;
  remoteFilter: boolean;
  maxResults: boolean;
  descriptionIncluded: boolean;
  atsCoverage?: string[];
  maxResultsSemantics?: string; // e.g., "per-company cap, not global LIMIT"
}

// Based on actual Apify actor input schemas and BaseScraper implementations (2026-08-19)
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  // Valig actors — all support keyword/location/date/maxResults via buildInput
  linkedin: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: true,
    remoteFilter: true,
    maxResults: true,
    descriptionIncluded: true,
  },
  indeed: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: true,
    remoteFilter: true,
    maxResults: true,
    descriptionIncluded: true,
  },
  naukri: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: true,
    remoteFilter: true,
    maxResults: true,
    descriptionIncluded: true,
  },
  glassdoor: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: true,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: true,
  },
  upwork: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: true,
    remoteFilter: true,
    maxResults: true,
    descriptionIncluded: true,
  },
  // Santa Maria — broad ATS scraper, NOT a keyword search engine
  'santa-maria': {
    keywordFilter: false, // returns all jobs per careerUrl, we filter locally
    locationFilter: false,
    postedDateFilter: false,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: true, // includeDescription:true is set, but discovery should not require it
    atsCoverage: [
      'greenhouse', 'workday', 'ashby', 'lever', 'smartrecruiters', 'workable',
      'teamtailor', 'personio', 'bamboohr', 'icims', 'recruitee', 'join',
      'pinpoint', 'rippling', 'jazzhr', 'comeet', 'other',
    ],
    maxResultsSemantics: 'maxJobsPerCompany is per-board cap (e.g., 500), NOT global LIMIT — must be budgeted separately. Use ATS_MAX_RAW_RESULTS=50 safety budget.',
  },
  // Built-in free scrapers — keyword/location/date via HTML/API, maxResults via limit param
  arbeitnow: {
    keywordFilter: true,
    locationFilter: false,
    postedDateFilter: false,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: false,
  },
  simplyhired: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: false,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: false,
  },
  dice: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: false,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: false,
  },
  reed: {
    keywordFilter: true,
    locationFilter: true,
    postedDateFilter: false,
    remoteFilter: false,
    maxResults: true,
    descriptionIncluded: false,
  },
};

export function getProviderCapabilities(providerId: string): ProviderCapabilities | undefined {
  return PROVIDER_CAPABILITIES[providerId.toLowerCase()];
}
