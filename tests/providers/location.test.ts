import { describe, it, expect } from 'vitest';
import { normalizeLocation, matchesLocation } from '../../server/search/location.js';

describe('normalizeLocation', () => {
  it('extracts remote/hybrid markers', () => {
    expect(normalizeLocation('Remote')).toContain('remote');
    expect(normalizeLocation('Remote - India')).toContain('remote');
    expect(normalizeLocation('Hybrid - Bengaluru')).toContain('hybrid');
    expect(normalizeLocation('Remote - Ireland')).toContain('remote');
  });
  it('maps country names and cities', () => {
    expect(normalizeLocation('Bengaluru, Karnataka, India')).toContain('india');
    expect(normalizeLocation('Hyderabad, India')).toContain('india');
    expect(normalizeLocation('New York, NY, United States')).toContain('usa');
    expect(normalizeLocation('London, UK')).toContain('uk');
  });
});

describe('matchesLocation — country search', () => {
  it('matches city+country strings to the country search', () => {
    expect(matchesLocation('Bengaluru, Karnataka, India', 'India')).toBe(true);
    expect(matchesLocation('Hyderabad, India', 'India')).toBe(true);
    expect(matchesLocation('Remote - India', 'India')).toBe(true);
    expect(matchesLocation('India', 'India')).toBe(true);
  });
  it('rejects other countries', () => {
    expect(matchesLocation('Remote - US', 'India')).toBe(false);
    expect(matchesLocation('London, UK', 'India')).toBe(false);
    expect(matchesLocation('Remote - Ireland', 'India')).toBe(false);
  });
});

describe('matchesLocation — remote search', () => {
  it('remote jobs pass, hybrid passes by default, onsite fails', () => {
    expect(matchesLocation('Remote', 'Remote', { remote: true })).toBe(true);
    expect(matchesLocation('Remote - India', 'Remote', { remote: true })).toBe(true);
    expect(matchesLocation('Hybrid - Bengaluru', 'Remote', { remote: true })).toBe(true);
    expect(matchesLocation('Bengaluru, India', 'Remote', { remote: true })).toBe(false);
  });
  it('strict remote rejects hybrid when disallowed', () => {
    expect(matchesLocation('Hybrid - Bengaluru', 'Remote', { remote: true, allowHybridForRemote: false })).toBe(false);
  });
});

describe('matchesLocation — empty search', () => {
  it('no location constraint → everything passes', () => {
    expect(matchesLocation('London, UK', '')).toBe(true);
    expect(matchesLocation(undefined, undefined)).toBe(true);
  });
});