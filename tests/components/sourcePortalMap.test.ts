// The scraped-source and portal-directory namespaces only overlap by name.
// These assertions pin that mapping so the "Live" badge can never drift to a
// typo'd portal, an ATS network, or a source that is not in the directory.
import { describe, it, expect } from 'vitest';
import { JOB_PORTALS } from '../../src/constants/jobPortals';
import {
  LIVE_SOURCES,
  PORTAL_SOURCE,
  isPortalLive,
  sourceForPortal,
} from '../../src/constants/sourcePortalMap';

const portalNames = new Set(JOB_PORTALS.map((p) => p.name));

const EXPECTED_PAIRS: Array<[string, string]> = [
  ['LinkedIn', 'LinkedIn Jobs'],
  ['Indeed', 'Indeed'],
  ['Naukri', 'Naukri'],
  ['Glassdoor', 'Glassdoor'],
  ['Arbeitnow', 'Arbeitnow (DE Tech)'],
  ['SimplyHired', 'SimplyHired'],
  ['Dice', 'Dice (Tech)'],
  ['Reed', 'Reed'],
  ['MyCareersFuture', 'MyCareersFuture (SG Gov)'],
  ['Cutshort', 'Cutshort'],
  ['Gupy', 'Gupy (BR)'],
  ['Daijob', 'Daijob (JP)'],
  ['MyJobMag', 'MyJobMag (NG)'],
];

const NON_PORTAL_SOURCES = ['Upwork', 'RemoteJobs', 'JobsCh', 'Greenhouse', 'Lever', 'Ashby'];

describe('source -> portal map', () => {
  it('lists the 19 scraped sources', () => {
    expect(LIVE_SOURCES).toHaveLength(19);
    expect(new Set(LIVE_SOURCES.map((s) => s.source)).size).toBe(19);
  });

  it('maps only the 13 overlapping names onto real portal entries', () => {
    const mapped = LIVE_SOURCES.filter((s) => s.portal !== null);
    expect(mapped).toHaveLength(13);
    expect(PORTAL_SOURCE.size).toBe(13);

    for (const entry of mapped) {
      expect(portalNames.has(entry.portal as string)).toBe(true);
      expect(sourceForPortal(entry.portal as string)).toBe(entry.source);
    }
  });

  it('has the exact 13 source → portal pairs', () => {
    const actual = LIVE_SOURCES
      .filter((s) => s.portal !== null)
      .map((s) => [s.source, s.portal] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const expected = [...EXPECTED_PAIRS].sort((a, b) => a[0].localeCompare(b[0]));
    expect(actual).toEqual(expected);
  });

  it('leaves the six non-portal sources unmapped', () => {
    const unmapped = LIVE_SOURCES.filter((s) => s.portal === null).map((s) => s.source);
    expect(unmapped.sort()).toEqual([...NON_PORTAL_SOURCES].sort());

    for (const name of NON_PORTAL_SOURCES) {
      expect(portalNames.has(name)).toBe(false);
      expect(isPortalLive(name)).toBe(false);
    }
  });

  it('never points at a portal name that is absent from JOB_PORTALS', () => {
    for (const portalName of PORTAL_SOURCE.keys()) {
      expect(portalNames.has(portalName)).toBe(true);
    }
    expect([...portalNames].filter((name) => isPortalLive(name))).toHaveLength(13);
  });
});
