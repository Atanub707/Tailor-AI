import type { Page } from 'playwright';
import type { ATSAdapter } from './types.js';

// Registry of all known adapters — detector tries each in order (T1 first).
const adapters: ATSAdapter[] = [];

export function registerAdapter(adapter: ATSAdapter): void {
  adapters.push(adapter);
}

export function getAdapters(): ATSAdapter[] {
  return [...adapters];
}

/**
 * Detect which ATS a page belongs to.
 * Tries URL patterns first (fast), then DOM signals.
 * Returns the first matching adapter or null.
 */
export async function detectATS(page: Page): Promise<ATSAdapter | null> {
  const url = page.url();

  // Fast URL check — most ATS have distinctive host/path
  const urlHints: Record<string, string[]> = {
    greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'greenhouse.io/embed'],
    lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
    ashby: ['jobs.ashbyhq.com', '.ashbyhq.com'],
    workable: ['apply.workable.com', '.workable.com'],
    smartrecruiters: ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'],
    breezy: ['breezy.hr'],
    jazzhr: ['applytojob.com'],
    jobvite: ['jobs.jobvite.com', 'careers.jobvite.com'],
    bamboohr: ['bamboohr.com/careers', 'bamboohr.com/jobs'],
    rippling: ['ats.rippling.com'],
    workday: ['myworkdayjobs.com', 'myworkday.com'],
    icims: ['icims.com/jobs'],
    taleo: ['taleo.net/careersection'],
    successfactors: ['successfactors.com/career', 'successfactors.eu/career'],
  };

  for (const adapter of adapters) {
    const hints = urlHints[adapter.id] || [];
    if (hints.some((h) => url.includes(h))) {
      // Confirm with DOM detect to avoid false positive
      try {
        if (await adapter.detect(page)) return adapter;
      } catch { /* next */ }
    }
  }

  // Fallback: try every adapter's DOM detect
  for (const adapter of adapters) {
    try {
      if (await adapter.detect(page)) return adapter;
    } catch { /* next */ }
  }

  return null;
}
