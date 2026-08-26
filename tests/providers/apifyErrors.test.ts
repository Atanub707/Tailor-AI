import { describe, expect, it } from 'vitest';
import { readableApifyError } from '../../server/scraper/apifyBase.js';

describe('readableApifyError', () => {
  it('extracts the useful message from an Apify JSON error', () => {
    const body = JSON.stringify({ error: { type: 'record-or-token-not-found', message: 'The provided token is not valid.' } });
    expect(readableApifyError(403, body)).toBe('Apify actor returned 403: The provided token is not valid.');
  });

  it('keeps short non-JSON responses readable', () => {
    expect(readableApifyError(502, 'Upstream gateway failed')).toBe('Apify actor returned 502: Upstream gateway failed');
  });
});
