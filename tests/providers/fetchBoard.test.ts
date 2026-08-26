import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// fileStorage opens the DB at import time — point it at a throwaway dir so
// the provider import never touches real data. All fetch calls are mocked.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-fetchboard-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { fetchBoard } = await import('../../server/providers/directAtsProvider.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBoard — board-level incremental fetch (mocked, zero live calls)', () => {
  it('fetches ONE board (slug from careerUrl) and returns normalized jobs', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => ({
          jobs: [
            {
              id: '123', title: 'DevOps Engineer',
              absolute_url: 'https://boards.greenhouse.io/stripe/123',
              location: { name: 'Remote' }, content: '<p>devops</p>',
              first_published: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      };
    }));

    const jobs = await fetchBoard('watcher', 'greenhouse', 'Stripe', 'https://boards.greenhouse.io/stripe', 10);
    // Exactly ONE board request — never the platform-level rotation.
    expect(requested).toEqual(['https://boards-api.greenhouse.io/v1/boards/stripe/jobs']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('gh-123');
    expect(jobs[0].company).toBe('Stripe');
    expect(jobs[0].atsPlatform).toBe('greenhouse');
    expect(jobs[0].provider).toBe('direct-ats');
  });

  it('returns [] on HTTP error (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const jobs = await fetchBoard('watcher', 'greenhouse', 'Stripe', 'https://boards.greenhouse.io/stripe', 10);
    expect(jobs).toEqual([]);
  });

  it('returns [] when the careerUrl has no board slug (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const jobs = await fetchBoard('watcher', 'greenhouse', 'Stripe', 'https://example.com/careers', 10);
    expect(jobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});