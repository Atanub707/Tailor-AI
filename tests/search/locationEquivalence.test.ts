// Equivalence regression — the optimized location path (certain-reject
// prepass + memos) must be BIT-IDENTICAL to the reference implementation
// for every input. Any divergence is a correctness regression, not a
// performance trade.
import { describe, it, expect } from 'vitest';
import {
  matchesLocation,
  matchesLocationRef,
  normalizeLocation,
  normalizeLocationRef,
  type LocationMatchOptions,
} from '../../server/search/location.js';

const JOB_LOCATIONS = [
  'Bengaluru, Karnataka, India',
  'Bangalore, India',
  'Hyderabad, Telangana, India',
  'Mumbai, Maharashtra, India',
  'Pune, India',
  'New Delhi, Delhi, India',
  'Gurugram, Haryana, India',
  'Gurgaon, India',
  'Noida, Uttar Pradesh, India',
  'Chennai, Tamil Nadu, India',
  'Kolkata, India',
  'Ahmedabad, Gujarat, India',
  'Remote - India',
  'India Remote',
  'Remote',
  '100% Remote',
  'Work from Home',
  'Hybrid - Bengaluru',
  'Hybrid',
  'On-site - Pune',
  'Onsite',
  'San Francisco, CA, USA',
  'New York, NY',
  'Austin, TX, United States',
  'US - Remote',
  'London, UK',
  'Manchester, England',
  'Berlin, Germany',
  'Munich, Bayern, Germany',
  'Paris, France',
  'Warsaw, Poland',
  'Singapore',
  'Tokyo, Japan',
  'Sydney, Australia',
  'São Paulo, Brazil',
  'Remote - Europe',
  'Dubai, UAE',
  'Toronto, Canada',
  '', // empty
  undefined, // unknown
  'Bengaluru, India; Chennai, India', // multi-location
  'Mumbai, India / Remote',
  'Some Unknown City, Some Unknown Country',
];

const WANTS: Array<[string | undefined, LocationMatchOptions]> = [
  ['India', {}],
  ['Bangalore', {}],
  ['Bengaluru', {}],
  ['Hyderabad', {}],
  ['Mumbai', {}],
  ['Pune', {}],
  ['Delhi', {}],
  ['Gurugram', {}],
  ['Gurgaon', {}],
  ['Remote', {}],
  ['Remote', { remote: true }],
  ['Remote', { remote: true, allowHybridForRemote: false }],
  ['Global', {}],
  ['USA', {}],
  ['UK', {}],
  ['Germany', {}],
  ['UAE', {}],
  [undefined, {}],
  ['', {}],
  ['Remote India', {}],
];

describe('location equivalence — optimized path == reference (bit-identical decisions)', () => {
  it('matchesLocation: every (job, want, opts) combo agrees with the reference', () => {
    let checked = 0;
    for (const job of JOB_LOCATIONS) {
      for (const [want, opts] of WANTS) {
        const fast = matchesLocation(job, want, opts);
        const ref = matchesLocationRef(job, want, opts);
        expect(fast, `job="${String(job)}" want="${String(want)}" opts=${JSON.stringify(opts)}`).toBe(ref);
        checked++;
      }
    }
    expect(checked).toBe(JOB_LOCATIONS.length * WANTS.length);
  });

  it('normalizeLocation: token output identical to the reference', () => {
    for (const job of JOB_LOCATIONS) {
      expect(normalizeLocation(job)).toEqual(normalizeLocationRef(job));
    }
  });

  it('array job locations: identical to reference (multi-location handling)', () => {
    const arrayLocations = [['Bengaluru, India', 'Chennai, India'], ['Remote'], ['New York, NY', 'San Francisco, CA'], []];
    for (const loc of arrayLocations) {
      expect(matchesLocation(loc, 'India')).toBe(matchesLocationRef(loc, 'India'));
      expect(matchesLocation(loc, 'USA')).toBe(matchesLocationRef(loc, 'USA'));
      expect(matchesLocation(loc, 'Remote')).toBe(matchesLocationRef(loc, 'Remote'));
    }
  });

  it("'Worldwide' (UI neutral placeholder) means no location constraint", () => {
    expect(matchesLocation('San Francisco, CA, USA', 'Worldwide')).toBe(true);
    expect(matchesLocation('Bengaluru, India', 'Worldwide')).toBe(true);
    expect(matchesLocation('', 'Worldwide')).toBe(true);
    expect(matchesLocation(undefined, 'Worldwide')).toBe(true);
    expect(matchesLocation('London, UK', 'Worldwide', { remote: true })).toBe(false); // remote-only still applies
  });

  it('abbreviations and aliases supported by the reference behave identically', () => {
    const pairs: Array<[string, string]> = [
      ['San Francisco, CA, USA', 'US'],
      ['San Francisco, CA, USA', 'United States'],
      ['London, UK', 'United Kingdom'],
      ['Dubai, UAE', 'United Arab Emirates'],
      ['Mumbai, India', 'Bharat'],
      ['Sydney, Australia', 'AU'],
    ];
    for (const [job, want] of pairs) {
      expect(matchesLocation(job, want)).toBe(matchesLocationRef(job, want));
    }
  });
});