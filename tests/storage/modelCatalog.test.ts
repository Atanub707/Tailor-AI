// Live model catalog — provider /models proxied with cache + fallback;
// Settings UI never hardcodes the list. No network: injected fetcher.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { fetchModelCatalog, isOpenAiCompatible, CATALOG_TTL_MS, clearModelCache } = await import('../../server/llm/modelCatalog.js');
const { PROVIDER_FALLBACK_MODELS, PROVIDER_BASE_URLS } = await import('../../src/constants/llmPresets.js');

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const modelsPayload = (ids: string[]) => ({ object: 'list', data: ids.map((id, i) => ({ id, object: 'model', created: 1700000000 + i, owned_by: 'zen' })) });

describe('Live model catalog', () => {
  it('every provider has a static fallback list (never empty)', () => {
    for (const p of Object.keys(PROVIDER_BASE_URLS)) {
      const list = PROVIDER_FALLBACK_MODELS[p as keyof typeof PROVIDER_FALLBACK_MODELS];
      expect(Array.isArray(list)).toBe(true);
      // openrouter is a 100+ model gateway with no stable list — custom-only
      // fallback is its documented strategy; every other provider ships
      // at least one concrete model.
      if (p === 'openrouter') {
        expect(list).toEqual(['Custom (type below)']);
      } else {
        expect(list.filter((m) => m !== 'Custom (type below)').length).toBeGreaterThan(0);
      }
    }
  });

  it('opencode-go is OpenAI-compatible; gemini/anthropic are not', () => {
    expect(isOpenAiCompatible('opencode-go')).toBe(true);
    expect(isOpenAiCompatible('openrouter')).toBe(true);
    expect(isOpenAiCompatible('openai')).toBe(true);
    expect(isOpenAiCompatible('nvidia')).toBe(true);
    expect(isOpenAiCompatible('gemini')).toBe(false);
    expect(isOpenAiCompatible('anthropic')).toBe(false);
  });

  it('fetches and parses the live catalog (id/created/owned_by), non-stale', async () => {
    clearModelCache();
    const fetcher = async (url: string, init: any) => {
      expect(url).toContain('/models');
      expect(init.headers.Authorization).toMatch(/^Bearer .+/);
      return { ok: true, json: async () => modelsPayload(['deepseek-v4-flash', 'qwen3.8-max', 'grok-4.6']) } as any;
    };
    const r = await fetchModelCatalog(fetcher, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(r.stale).toBe(false);
    expect(r.provider).toBe('opencode-go');
    expect(r.fetchedAt).toBeTruthy();
    expect(r.models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'qwen3.8-max', 'grok-4.6']);
    expect(r.models[0].owned_by).toBe('zen');
  });

  it('caches for the TTL — a second call does not re-fetch', async () => {
    clearModelCache();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { ok: true, json: async () => modelsPayload(['kimi-k3']) } as any;
    };
    await fetchModelCatalog(fetcher, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    await fetchModelCatalog(fetcher, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(calls).toBe(1);
    expect(CATALOG_TTL_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 1);
  });

  it('falls back (stale) on HTTP failure, empty list or missing key — never throws', async () => {
    clearModelCache();
    const fail = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' } as any);
    const r1 = await fetchModelCatalog(fail, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(r1.stale).toBe(true);
    expect(r1.reason).toContain('HTTP 429');
    expect(r1.models.length).toBeGreaterThan(0);
    clearModelCache();
    const empty = async () => ({ ok: true, json: async () => ({ data: [] }) } as any);
    const r2 = await fetchModelCatalog(empty, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(r2.stale).toBe(true);
    clearModelCache();
    const r3 = await fetchModelCatalog((async () => { throw new Error('ECONNRESET'); }) as any, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(r3.stale).toBe(true);
    expect(r3.reason).toContain('ECONNRESET');
  });

  it('never calls a non-compatible provider and never skips the key', async () => {
    clearModelCache();
    let called = false;
    const fetcher = async () => { called = true; return { ok: true, json: async () => modelsPayload(['x']) } as any; };
    const r = await fetchModelCatalog(fetcher, { provider: 'gemini', baseUrl: '', apiKey: 'k' });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe('PROVIDER_NON_COMPATIBLE');
    expect(called).toBe(false);
    const r2 = await fetchModelCatalog(fetcher, { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' });
    expect(r2.stale).toBe(true);
    expect(r2.reason).toBe('NO_API_KEY');
    expect(called).toBe(false);
  });
});

describe('Settings UI wiring — live catalog', () => {
  it('SettingsModal fetches /api/models and marks Free/New models', () => {
    const scr = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsModal.tsx'), 'utf8');
    expect(scr).toContain('/api/models');
    expect(scr).toContain('Refresh model list');
    expect(scr).toContain('— Free');
    expect(scr).toContain('· New');
    expect(scr).toContain('PROVIDER_FALLBACK_MODELS');
    expect(scr).not.toContain("const PROVIDER_MODELS: Record<LlmProvider, string[]>");
  });

  it('the server exposes GET /api/models', () => {
    const srv = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(srv).toContain("app.get('/api/models'");
    expect(srv).toContain('fetchModelCatalog');
  });
});

const { extractJsonObject } = await import('../../server/llm/jsonExtract.js');

describe('LLM JSON extraction — reasoning-model noise', () => {

  it('parses clean JSON unchanged', () => {
    expect(extractJsonObject('{"matchScore": 87, "missingSkills": ["go"]}').matchScore).toBe(87);
  });

  it('strips minimax/DeepSeek <thinking> blocks before the JSON', () => {
    const raw = '<thinking>Let me analyze this CV against the requirements. The candidate lacks Kubernetes, GitOps and cloud security experience.</thinking>\n{"matchScore": 42, "missingSkills": ["Kubernetes", "GitOps"]}';
    const parsed = extractJsonObject(raw);
    expect(parsed.matchScore).toBe(42);
    expect(parsed.missingSkills).toEqual(['Kubernetes', 'GitOps']);
  });

  it('strips markdown fences and leading prose', () => {
    expect(extractJsonObject('```json\n{"afterScore": 91}\n```').afterScore).toBe(91);
    expect(extractJsonObject('Here is the result:\n{"afterScore": 91}').afterScore).toBe(91);
  });

  it('survives the exact crash shape: <thinking>Let... is not valid JSON', () => {
    const raw = '<thinking>Let me carefully check every bullet point of the candidate resume against the job description and decide how to rephrase each highlight.</thinking>\n{"candidateName": "Alex Mercer", "targetRole": "Senior Software Engineer", "professionalSummary": "Results-driven engineer", "coreCompetencies": ["Kubernetes"], "workExperience": [{"title": "Senior Software Engineer", "company": "Apex", "highlights": ["Architected platform"]}], "education": [{"degree": "B.S."}], "technicalSkills": [{"category": "Cloud", "skills": ["AWS"]}], "inExperience": ["Kubernetes"], "inSkills": [], "afterScore": 91, "auditNotes": ["Note"]}';
    const parsed = extractJsonObject(raw);
    expect(parsed.candidateName).toBe('Alex Mercer');
    expect(parsed.afterScore).toBe(91);
    expect(parsed.workExperience[0].company).toBe('Apex');
  });

  it('repairs literal schema echoes — "experience": [...] becomes []', () => {
    const raw = '{"candidateName":"Alex", "workExperience": [...], "education": [...], "coreCompetencies": ["K8s"]}';
    const parsed = extractJsonObject(raw);
    expect(parsed.workExperience).toEqual([]);
    expect(parsed.education).toEqual([]);
    expect(parsed.coreCompetencies).toEqual(['K8s']);
  });

  it('repairs unquoted keys — the "Expected double-quoted property name" crash', () => {
    const raw = '{"candidateName": "Alex", auditNotes: ["note a", "note b"], afterScore: 91, workExperience: [{"title": "SE", company: "Apex", dates: "2022 - Present"}]}';
    const parsed = extractJsonObject(raw);
    expect(parsed.auditNotes).toEqual(['note a', 'note b']);
    expect(parsed.afterScore).toBe(91);
    expect(parsed.workExperience[0].company).toBe('Apex');
  });

  it('repairs trailing commas and missing commas between members', () => {
    const trailing = '{"a": 1, "b": [1, 2, ], }';
    expect(extractJsonObject(trailing).b).toEqual([1, 2]);
    const missing = '{"title": "Engineer" "company": "Veo", "skills": ["k8s"]}';
    expect(extractJsonObject(missing).company).toBe('Veo');
  });

  it('never repairs inside string literals (apostrophes/hours stay intact)', () => {
    const raw = '{"summary": "don\'t change {this} or 10:30pm - it\'s a string", "count": 2}';
    const parsed = extractJsonObject(raw);
    expect(parsed.summary).toBe("don\'t change {this} or 10:30pm - it\'s a string");
  });

  it('cuts appended prose after the object — "non-whitespace after JSON" crash', () => {
    const raw = '{"matchScore": 87, "summaryAnalysis": "ok"} NOTE: This was done quickly. {{extra}}';
    expect(extractJsonObject(raw).matchScore).toBe(87);
    const raw2 = '{"a": 1} {"b": 2}';
    expect(extractJsonObject(raw2).a).toBe(1);
  });

  it('finds the real object when prose has braces first (position-6586 shape)', () => {
    const raw = 'Before the answer there is {prose with braces} and more text. Then the real result: {"candidateName": "Alex", "afterScore": 91, "workExperience": [{"title": "SE", "company": "Apex", "highlights": ["Architected x"]}]} — done.';
    const parsed = extractJsonObject(raw);
    expect(parsed.candidateName).toBe('Alex');
    expect(parsed.afterScore).toBe(91);
    expect(parsed.workExperience[0].company).toBe('Apex');
  });

  it('throws a helpful error when no JSON exists at all', () => {
    expect(() => extractJsonObject('<thinking>just prose</thinking> no object')).toThrow(/No JSON object found/);
  });
});
