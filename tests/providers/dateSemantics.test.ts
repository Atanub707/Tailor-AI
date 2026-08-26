import { describe, it, expect } from 'vitest';
import { isWithinPostedWindow } from '../../server/storage/v2Tables.js';

// All mocked — no live API calls.

const now = Date.now();
const hour = 60 * 60 * 1000;

describe('isWithinPostedWindow — semantics-aware', () => {
  it('published timestamp within window passes', () => {
    const j = { postedDate: new Date(now - 2 * hour).toISOString(), postedDateParsed: new Date(now - 2 * hour).toISOString().slice(0, 10), postedDateSemantics: 'published' };
    expect(isWithinPostedWindow(j, '24h')).toBe(true);
  });
  it('published timestamp older than window fails', () => {
    const j = { postedDate: new Date(now - 48 * hour).toISOString(), postedDateParsed: new Date(now - 48 * hour).toISOString().slice(0, 10), postedDateSemantics: 'published' };
    expect(isWithinPostedWindow(j, '24h')).toBe(false);
    expect(isWithinPostedWindow(j, '7d')).toBe(true);
  });
  it('created timestamp within window passes', () => {
    const j = { postedDate: new Date(now - 3 * hour).toISOString(), postedDateParsed: new Date(now - 3 * hour).toISOString().slice(0, 10), postedDateSemantics: 'created' };
    expect(isWithinPostedWindow(j, '24h')).toBe(true);
  });
  it('updated-only timestamp within window passes (eligible, labelled updated)', () => {
    const j = { postedDate: new Date(now - 6 * hour).toISOString(), postedDateParsed: new Date(now - 6 * hour).toISOString().slice(0, 10), postedDateSemantics: 'updated' };
    expect(isWithinPostedWindow(j, '24h')).toBe(true);
  });
  it('unknown timestamp excluded from a strict window', () => {
    const j = { postedDate: undefined, postedDateParsed: undefined, postedDateSemantics: 'unknown' };
    expect(isWithinPostedWindow(j, '24h')).toBe(false);
    expect(isWithinPostedWindow(j, 'all')).toBe(true); // no filter → pass
  });
  it('missing semantics falls back to the raw postedDate', () => {
    const j = { postedDate: new Date(now - 5 * hour).toISOString(), postedDateParsed: new Date(now - 5 * hour).toISOString().slice(0, 10) };
    expect(isWithinPostedWindow(j, '24h')).toBe(true);
  });
  it('30d window is more lenient than 7d', () => {
    const old = new Date(now - 10 * 24 * hour).toISOString();
    const j = { postedDate: old, postedDateParsed: old.slice(0, 10), postedDateSemantics: 'published' };
    expect(isWithinPostedWindow(j, '7d')).toBe(false);
    expect(isWithinPostedWindow(j, '30d')).toBe(true);
  });
});