import type { Job } from '../../src/types.js';
import type { ATSPlatform } from '../../src/constants/atsPlatforms.js';

export interface JobSearchParams {
  keywords: string[];
  locations?: string[];
  remote?: boolean;
  atsPlatforms?: ATSPlatform[];
  limit: number;
  companyIds?: string[];
  // Career URLs or {platform, company} objects for Santa Maria queries
  queries?: Array<string | { platform: string; company: string }>;
}

export interface JobProviderResult {
  jobs: Job[];
  provider: string;
  providerRunId?: string;
  totalReturned: number;
  requestedLimit: number;
}

export interface JobProvider {
  readonly id: string;
  search(params: JobSearchParams): Promise<JobProviderResult>;
}
