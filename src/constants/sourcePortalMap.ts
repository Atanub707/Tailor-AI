import type { JobSource } from '../types';

// The job sources we scrape and the job portals we link to are two different
// namespaces. Only the entries below overlap by name — the "Live" badge on a
// portal card is driven by this list, never by ad-hoc string checks in JSX.
//
// Greenhouse, Lever and Ashby deliberately have no portal entry: they are ATS
// networks (6,000+ company boards), not portals in the directory.
export interface SourcePortalLink {
  readonly source: JobSource;
  readonly portal: string | null;
}

export const LIVE_SOURCES = [
  { source: 'LinkedIn', portal: 'LinkedIn Jobs' },
  { source: 'Indeed', portal: 'Indeed' },
  { source: 'Naukri', portal: 'Naukri' },
  { source: 'Glassdoor', portal: 'Glassdoor' },
  { source: 'Upwork', portal: null },
  { source: 'Arbeitnow', portal: 'Arbeitnow (DE Tech)' },
  { source: 'RemoteJobs', portal: null },
  { source: 'SimplyHired', portal: 'SimplyHired' },
  { source: 'Dice', portal: 'Dice (Tech)' },
  { source: 'Reed', portal: 'Reed' },
  { source: 'MyCareersFuture', portal: 'MyCareersFuture (SG Gov)' },
  { source: 'Cutshort', portal: 'Cutshort' },
  { source: 'Gupy', portal: 'Gupy (BR)' },
  { source: 'JobsCh', portal: null },
  { source: 'Daijob', portal: 'Daijob (JP)' },
  { source: 'MyJobMag', portal: 'MyJobMag (NG)' },
  { source: 'Greenhouse', portal: null },
  { source: 'Lever', portal: null },
  { source: 'Ashby', portal: null },
] as const satisfies readonly SourcePortalLink[];

export type LiveSourceName = (typeof LIVE_SOURCES)[number]['source'];

// portal name -> source id. Built from the single list above so the band of
// live sources and the badges on cards can never disagree.
export const PORTAL_SOURCE: ReadonlyMap<string, LiveSourceName> = new Map(
  LIVE_SOURCES.flatMap((entry) =>
    entry.portal ? [[entry.portal as string, entry.source] as const] : []
  )
);

export function isPortalLive(portalName: string): boolean {
  return PORTAL_SOURCE.has(portalName);
}

export function sourceForPortal(portalName: string): LiveSourceName | undefined {
  return PORTAL_SOURCE.get(portalName);
}
