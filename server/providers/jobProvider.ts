import type { Job } from '../../src/types.js';
import type { ATSPlatform } from '../../src/constants/atsPlatforms.js';

// What a provider's date actually MEANS. Never guess: "updated_at" is NOT a
// posting date. Providers normalize their raw fields into publishedAt/
// createdAt/updatedAt and declare which one the date filter should trust.
export type DateSemantics =
  | 'published' // provider exposed a true publication/first-posting timestamp
  | 'created'   // provider exposed a creation timestamp (posting created)
  | 'updated'   // ONLY an update timestamp exists — not a posting date
  | 'unknown';  // no usable timestamp at all

// Normalized date view every provider must produce for each job.
export interface NormalizedDates {
  publishedAt?: string; // true posting date when the provider exposes one
  createdAt?: string;   // creation timestamp when exposed (ISO)
  updatedAt?: string;   // last-modified timestamp when exposed (ISO)
  dateSemantics: DateSemantics; // which field filtering should trust
}

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