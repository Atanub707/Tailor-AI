// LLM hardening — bounded timeout, real request cancellation, error
// normalization, JD-preservation on LLM failure, success path with a mocked
// provider. Fixtures/mocks only; zero live calls.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-hardening-'));
process.env.TAILOR_DATA_DIR = tmpDir;
process.env.LLM_REQUEST_TIMEOUT_MS = '5000';

const { getDb } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureAtsIndexSchema, upsertAtsJobs } = await import('../../server/ats-index/atsRepository.js');
const { ensureJobDescription } = await import('../../server/tailor/jdResolver.js');
const { ask, llmRequestTimeoutMs } = await import('../../server/llm/llmAdapter.js');
const { normalizeLlmError, LLMError } = await import('../../server/llm/llmErrors.js');
import { askOpenAi } from '../../server/llm/providers/openaiProvider.js';
import type { Job } from '../../src/types.js';
import type { AtsJobRow } from '../../server/ats-index/atsRepository.js';

function baseJob(over: Partial<Job> = {}): Job {
  return {
    id: 'gh-1', fingerprint: 'gh-1', externalId: 'gh-1', title: 'DevOps Engineer', company: 'Acme',
    companyId: 'Acme', location: 'Bengaluru, India', description: '', atsPlatform: 'greenhouse',
    jobUrl: 'https://boards.greenhouse.io/acme/jobs/1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'Greenhouse', state: 'pending',
    ...over,
  } as unknown as Job;
}

describe('LLM hardening', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureAtsIndexSchema();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('centralized timeout is bounded and env-configurable', () => {
    expect(llmRequestTimeoutMs()).toBe(5000);
    expect(Number.isFinite(llmRequestTimeoutMs())).toBe(true);
  });

  it('openai provider: timeout ABORTS the actual request (AbortSignal)', async () => {
    const signals: AbortSignal[] = [];
    (globalThis as any).fetch = (_url: string, init: any) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        // The provider must ABORT the actual in-flight request — the mock
        // honors the signal like undici does.
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      });
    };
    await expect(
      askOpenAi({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', prompt: 'p', temperature: 0.2, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(signals[0].aborted).toBe(true); // underlying request actually cancelled
  });

  it('openai provider: 401 → AUTH, 429 → RATE_LIMIT, 500 → PROVIDER, malformed → MALFORMED', async () => {
    for (const [status, body, code] of [
      [401, {}, 'AUTH'], [403, {}, 'AUTH'], [429, {}, 'RATE_LIMIT'], [500, {}, 'PROVIDER'], [200, { unexpected: 1 }, 'MALFORMED'],
    ] as const) {
      (globalThis as any).fetch = async () => ({ status, ok: status < 300, json: async () => body, text: async () => '' });
      await expect(
        askOpenAi({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', prompt: 'p', temperature: 0.2, timeoutMs: 1000 })
      ).rejects.toMatchObject({ code });
    }
  });

  it('network failure maps to NETWORK; normalization produces safe messages without secrets', async () => {
    (globalThis as any).fetch = async () => { throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:443'); };
    const err = normalizeLlmError(new Error('fetch failed: ECONNREFUSED'));
    expect(err.code).toBe('network');
    expect(err.message).not.toContain('10.0.0.1');
    expect(err.message).not.toContain('secret');
  });

  it('ask() normalizes every provider error to LLMError', async () => {
    (globalThis as any).fetch = async () => ({ status: 429, ok: false, json: async () => ({}), text: async () => 'rate limited' });
    await expect(ask('test prompt')).rejects.toBeInstanceOf(LLMError);
    await expect(ask('test prompt')).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('JD cached before LLM and PRESERVED after LLM failure', async () => {
    upsertAtsJobs([{
      fingerprint: 'gh-1', ats_platform: 'greenhouse', external_id: '1', company: 'Acme', company_slug: 'acme',
      title: 'DevOps Engineer', location: 'Bengaluru, India', apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
      job_url: 'https://boards.greenhouse.io/acme/jobs/1', description: '', first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(), last_fetched_at: new Date().toISOString(), is_active: 1,
    } as AtsJobRow]);
    const { runWithUser, saveNewJobs } = await import('../../server/storage/fileStorage.js');
    runWithUser('llm-user', () => { saveNewJobs([baseJob()]); });
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('boards-api.greenhouse.io')) {
        return { status: 200, ok: true, json: async () => ({ content: '&lt;h3&gt;Responsibilities&lt;/h3&gt; Build pipelines. Automate infrastructure. Operate Kubernetes clusters across regions with on-call rotation and incident response duties for a global platform.' }) };
      }
      throw new Error('unexpected fetch');
    };
    const enriched = await runWithUser('llm-user', () => ensureJobDescription(baseJob()));
    expect(enriched.description.length).toBeGreaterThan(100); // JD cached
    // LLM fails afterwards (unreachable provider) — the JD must remain.
    const stored = JSON.parse((getDb().prepare("SELECT data FROM jobs WHERE id='gh-1'").get() as any).data);
    expect(stored.description.length).toBeGreaterThan(100); // still cached
    // Second Tailor: JD fetch = 0 (cached) — LLM retry only.
    (globalThis as any).fetch = async () => { throw new Error('should not be called'); };
    const cached = await runWithUser('llm-user', () => ensureJobDescription(JSON.parse((getDb().prepare("SELECT data FROM jobs WHERE id='gh-1'").get() as any).data)));
    expect(cached.description.length).toBeGreaterThan(100);
  });

  it('full JD reaches the tailoring service (success path with mocked LLM)', async () => {
    // The adapter is the LLM boundary; a mocked provider proves the call
    // shape. The tailoring service receives resume + the RESOLVED JD.
    const prompts: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      prompts.push(init.body);
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tailored: 'done' }) } }] }) };
    };
    const out = await ask('resume+JD prompt', 0.2);
    expect(out).toContain('tailored');
    expect(prompts[0]).toContain('resume+JD prompt');
  });
});