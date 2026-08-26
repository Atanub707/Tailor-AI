export type JobState = 'pending' | 'matched' | 'tailored' | 'ready' | 'applied';
export type JobSource = 'LinkedIn' | 'LinkedInPosts' | 'Indeed' | 'Naukri' | 'Glassdoor' | 'Upwork' | 'Arbeitnow' | 'SimplyHired' | 'Dice' | 'Reed' | 'RemoteOK' | 'WeWorkRemotely' | 'MyCareersFuture' | 'Cutshort' | 'Gupy' | 'JobsCh' | 'Daijob' | 'MyJobMag' | 'Greenhouse' | 'Lever' | 'Ashby' | 'Workable' | 'Workday' | 'SmartRecruiters' | 'Teamtailor' | 'Personio' | 'BambooHR' | 'Rippling' | 'JazzHR' | 'Recruitee' | 'iCIMS' | 'Jobvite' | 'Comeet' | 'Pinpoint' | 'Join' | 'Custom';

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  source: JobSource;
  description: string;
  url: string;
  postedDate?: string; // real posting time from the source (absent = unknown, never scrape time)
  postedDateParsed?: string; // YYYY-MM-DD
  salaryMin?: number;
  salaryMax?: number;
  salaryText?: string;
  jobType?: string; // Full-time, Remote, Contract, etc.
  applicantCount?: number; // number of applicants who applied (LinkedIn)
  applicantCaption?: string; // exact text LinkedIn's public page shows, e.g. "Over 200 applicants"
  lowCompetition?: boolean; // LinkedIn "Be among the first N applicants" — very few applications
  recruiterName?: string;
  recruiterUrl?: string;
  experienceLevel?: string;
  contractType?: string;
  companyUrl?: string;
  applyUrl?: string; // external link found inside a LinkedIn post (job/apply URL)
  hashtags?: string[]; // hashtags found in a LinkedIn post text
  replacesUrl?: string; // scraper bookkeeping: the Google-News token URL of the truncated job this full-text job replaces
  applyType?: string;
  state: JobState;
  
  // AI Matching output
  matchScore?: number; // 0 - 100
  gapAnalysis?: GapAnalysis;
  matchedAt?: string;

  // AI Tailoring output
  tailoredCv?: TailoredCv;
  tailoredAt?: string;

  createdAt: string;
  updatedAt: string;

  // V2 — ATS + provider extensions (additive, optional for V1 compat)
  atsPlatform?: string;
  externalId?: string;
  companyId?: string;
  locations?: string[];
  department?: string;
  employmentType?: string;
  remote?: boolean;
  atsCompanySlug?: string;
  provider?: string;
  providerRunId?: string;
  fingerprint?: string;
  isActive?: boolean;
  scrapedAt?: string;
  descriptionAvailable?: boolean;
}

export interface GapAnalysis {
  matchScore: number; // 0 - 100
  matchingSkills: string[];
  missingSkills: string[];
  salaryFit: 'below' | 'matched' | 'above' | 'unknown';
  experienceFit: 'entry' | 'mid' | 'senior' | 'overqualified' | 'ideal';
  keyRecommendations: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  summaryAnalysis: string;
  yearsOfExperience?: number;
  yearsRequired?: number;
  booleanSearchResult?: 'pass' | 'borderline' | 'fail';
}

export interface TailoringAudit {
  beforeScore: number;
  afterScore: number;
  scoreBoost: number;
  scoreBreakdown: {
    alreadyMatched: number;
    newlyIntegrated: number;
    remainingGap: number;
  };
  missingBefore: {
    skills: string[];
    keywords: string[];
  };
  addedAfter: {
    keywordsIncorporated: string[];
    keywordsInExperience: string[];
    keywordsInSkills: string[];
    rephrasedHighlightsCount: number;
    skillsAdded: string[];
  };
  notIntegrable: string[];
  auditNotes: string[];
}

export interface TailoredCv {
  candidateName: string;
  contactInfo: {
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    website?: string;
  };
  professionalSummary: string;
  targetRole: string;
  coreCompetencies: string[];
  workExperience: {
    title: string;
    company: string;
    location?: string;
    dates: string;
    highlights: string[]; // Tailored ATS bullet points emphasizing matching keywords
  }[];
  education: {
    degree: string;
    institution: string;
    dates: string;
    details?: string;
  }[];
  technicalSkills: {
    category: string;
    skills: string[];
  }[];
  projects?: ProjectItem[];
  certifications?: (CertificationItem | string)[];
  rephraseHighlightsCount?: number;
  keywordsIncorporated?: string[];
  audit?: TailoringAudit;
}

export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  technologies?: string[];
  link?: string;
  dates?: string;
}

export interface CertificationItem {
  id: string;
  name: string;
  issuer?: string;
  date?: string;
  link?: string;
}

export interface MasterCv {
  fullName: string;
  designation?: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  github?: string;
  website?: string;
  summary: string;
  experiences: {
    id: string;
    title: string;
    company: string;
    location: string;
    dates: string;
    responsibilities: string[];
  }[];
  education: {
    id: string;
    degree: string;
    institution: string;
    dates: string;
    details?: string;
  }[];
  skills: {
    category: string;
    items: string[];
  }[];
  projects?: ProjectItem[];
  certifications?: CertificationItem[];
  rawText?: string;
  downloadFilename?: string;
  templateId?: TemplateId;
}

export type TemplateId = 'harvard' | 'jake' | 'atanu' | 'atanu-pro';

export const CV_TEMPLATES: { id: TemplateId; label: string; description: string }[] = [
  { id: 'harvard', label: 'Harvard', description: 'Official Harvard College bullet-point resume — centered, Calibri' },
  { id: 'jake', label: 'Jake', description: 'Jake Ryan one-pager — black minimal, developer classic' },
  { id: 'atanu', label: 'Atanu', description: 'Custom design — teal single-column with role subtitle' },
  { id: 'atanu-pro', label: 'Atanu Pro', description: 'Premium navy/blue layout — accent rules, hanging bullets, optional project links' },
];

export interface ScraperParams {
  keywords: string;
  location?: string;
  sources?: JobSource[];
  datePostedFilter?: 'all' | '24h' | '7d' | '30d';
  jobType?: 'all' | 'remote' | 'onsite' | 'hybrid';
  minSalary?: number;
  maxJobsPerSource?: number;
  jobTitle?: string;
  contractType?: string;
  experienceLevel?: string;
  under10Applicants?: boolean;
  jobIds?: string[];
  engine?: 'free' | 'apify';
}

export type LlmProvider = 'opencode-go' | 'openrouter' | 'openai' | 'gemini' | 'anthropic' | 'nvidia';

export interface AppConfig {
  thresholds: {
    minMatchForTailor: number; // default 40
    earlyBlockThreshold: number; // default 30
  };
  llm: {
    provider: LlmProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
  };
  storage: {
    mode: 'sqlite' | 'json';
    sqliteDbPath: string;
    jsonDbPath: string;
  };
  scraper: {
    stealthMode: boolean;
    maxRetries: number;
    respectRobotsTxt: boolean;
  };
  apify: {
    token: string;
    enabled: boolean;
    referralUrl?: string;
  };
  linkedin: {
    liAt: string; // LinkedIn session cookie — unlocks reliable LinkedIn POSTS search (Apify actor)
  };
  email: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    fromName: string;
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
  };
}

export interface JobFilterQueryParams {
  state?: 'all' | JobState;
  source?: 'all' | JobSource;
  search?: string;
  jobType?: 'all' | 'remote' | 'onsite' | 'hybrid';
  location?: string;
  datePostedFilter?: 'all' | '24h' | '7d' | '30d';
  under10Applicants?: boolean;
  minScore?: number;
  maxScore?: number;
  sortBy?: 'postedDate' | 'matchScore' | 'createdAt' | 'company' | 'title' | 'salaryMax';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}
