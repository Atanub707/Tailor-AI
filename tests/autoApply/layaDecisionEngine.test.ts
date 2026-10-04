// Laya decision engine — adapter + policy tests.
//
// The Laya runtime is a LOCAL Python sidecar (127.0.0.1 only). These tests
// use a real HTTP mock server on loopback — never the model itself, never
// the network. They pin:
//   * the adapter never throws (unavailable/timeout/malformed → null)
//   * non-loopback URLs are refused before any request
//   * minimal request payloads (no PII)
//   * hard-block policy (consent/EEO/legal/sensitive at ANY confidence)
//   * confidence thresholds (high/review/low)
//   * values only ever come from the EXISTING package answer catalog
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decideFieldSuggestion,
  isHardBlockedField,
  layaConfigFromEnv,
  normalizeLayaCategory,
  type DecisionEngine,
  type FieldClassificationInput,
  type FieldClassificationResult,
} from '../../server/autoApply/decisionEngine.js';
import { LayaDecisionEngine, isLoopbackUrl } from '../../server/autoApply/layaDecisionEngine.js';
import { RulesDecisionEngine } from '../../server/autoApply/rulesDecisionEngine.js';

// ── Mock local sidecar (real HTTP on 127.0.0.1) ──────────────────────────

interface MockServer {
  url: string;
  requests: Array<{ path: string; body: any }>;
  close: () => Promise<void>;
}

const servers: MockServer[] = [];

async function startMock(
  handler: (body: any, res: http.ServerResponse) => void | Promise<void>
): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep null */ }
      requests.push({ path: String(req.url || ''), body });
      void handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const mock: MockServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
  servers.push(mock);
  return mock;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  delete process.env.LAYA_ENABLED;
  delete process.env.LAYA_URL;
  delete process.env.LAYA_REQUEST_TIMEOUT_MS;
  delete process.env.LAYA_HIGH_CONFIDENCE;
  delete process.env.LAYA_REVIEW_CONFIDENCE;
});

// ── Config ───────────────────────────────────────────────────────────────

describe('Laya config', () => {
  it('defaults: disabled, loopback URL, conservative thresholds, strict timeout', () => {
    const cfg = layaConfigFromEnv();
    expect(cfg.enabled).toBe(false);
    expect(cfg.url).toBe('http://127.0.0.1:8765');
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.highConfidence).toBe(0.9);
    expect(cfg.reviewConfidence).toBe(0.7);
  });

  it('loopback-only guard accepts 127.0.0.1/localhost/::1 and refuses everything else', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8765')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8765')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8765')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.50:8765')).toBe(false);
    expect(isLoopbackUrl('https://laya.example.com')).toBe(false);
    expect(isLoopbackUrl('http://0.0.0.0:8765')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

// ── Adapter (LayaDecisionEngine) ─────────────────────────────────────────

describe('LayaDecisionEngine adapter', () => {
  it('healthy response → normalized classification', async () => {
    const mock = await startMock((_body, res) =>
      json(res, 200, { canonicalKey: 'portfolioUrl', category: 'contact', answerSource: 'PROFILE', confidence: 0.94 })
    );
    const engine = new LayaDecisionEngine({ url: mock.url, timeoutMs: 2000 });
    const result = await engine.classifyField({ label: 'Personal website', type: 'URL', required: false });
    expect(result).not.toBeNull();
    expect(result!.canonicalKey).toBe('portfolioUrl');
    expect(result!.category).toBe('CONTACT');
    expect(result!.answerSource).toBe('PROFILE');
    expect(result!.confidence).toBeCloseTo(0.94);
    expect(result!.mappingMethod).toBe('AI_SUGGESTED');
    expect(result!.requiresUser).toBe(true); // engine is conservative; policy may relax
  });

  it('sends a minimal payload — label/type/required/options only, no PII', async () => {
    const mock = await startMock((_body, res) =>
      json(res, 200, { canonicalKey: 'email', category: 'contact', confidence: 0.99 })
    );
    const engine = new LayaDecisionEngine({ url: mock.url, timeoutMs: 2000 });
    await engine.classifyField({ label: 'Are you authorized to work here?', type: 'SINGLE_SELECT', required: true, options: ['Yes', 'No'] });
    expect(mock.requests).toHaveLength(1);
    const body = mock.requests[0].body;
    expect(Object.keys(body).sort()).toEqual(['label', 'options', 'required', 'type']);
    const serialized = JSON.stringify(body);
    // The wire payload carries classification inputs ONLY — no candidate facts.
    expect(serialized).not.toMatch(/email|phone|salary|resume|address|profile|answer/i);
    expect(serialized).not.toMatch(/@/);
  });

  it('runtime unavailable (connection refused) → null, never throws', async () => {
    // Grab a free port, then close the server so the connection is refused.
    const tmp = await startMock((_b, res) => json(res, 200, {}));
    const deadUrl = tmp.url;
    await tmp.close();
    servers.pop();
    const engine = new LayaDecisionEngine({ url: deadUrl, timeoutMs: 1000 });
    await expect(engine.classifyField({ label: 'Personal website', type: 'URL', required: false })).resolves.toBeNull();
  });

  it('timeout → null, bounded by the configured timeout', async () => {
    const mock = await startMock((_body, res) => {
      setTimeout(() => json(res, 200, { canonicalKey: 'portfolioUrl', category: 'contact', confidence: 0.99 }), 500);
    });
    const engine = new LayaDecisionEngine({ url: mock.url, timeoutMs: 80 });
    const started = Date.now();
    const result = await engine.classifyField({ label: 'Personal website', type: 'URL', required: false });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('malformed JSON / wrong shape / out-of-range confidence → null', async () => {
    const cases: Array<(res: http.ServerResponse) => void> = [
      (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json'); },
      (_res) => { /* handler below */ },
      (res) => json(res, 200, { confidence: 0.95 }),                       // no category
      (res) => json(res, 200, { category: 'contact', confidence: 7 }),     // out of range
      (res) => json(res, 500, { error: 'boom' }),                          // server error
    ];
    // Replace the second placeholder with a real "empty body" case.
    cases[1] = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(''); };

    for (const respond of cases) {
      const mock = await startMock((_b, res) => respond(res));
      const engine = new LayaDecisionEngine({ url: mock.url, timeoutMs: 1000 });
      const result = await engine.classifyField({ label: 'Personal website', type: 'URL', required: false });
      expect(result).toBeNull();
    }
  });

  it('non-loopback URL → refused without any network call', async () => {
    const mock = await startMock((_b, res) => json(res, 200, { canonicalKey: 'portfolioUrl', category: 'contact', confidence: 0.99 }));
    const engine = new LayaDecisionEngine({ url: 'http://192.168.1.50:8765', timeoutMs: 500 });
    const result = await engine.classifyField({ label: 'Personal website', type: 'URL', required: false });
    expect(result).toBeNull();
    expect(mock.requests).toHaveLength(0); // the mock (loopback) was never reached
  });

  it('unknown category vocabulary is normalized to the existing FieldCategory enum', () => {
    expect(normalizeLayaCategory('contact')).toBe('CONTACT');
    expect(normalizeLayaCategory('work_authorization')).toBe('WORK_AUTHORIZATION');
    expect(normalizeLayaCategory('salary')).toBe('COMPENSATION');
    expect(normalizeLayaCategory('motivation')).toBe('CUSTOM');
    expect(normalizeLayaCategory('file_upload')).toBe('RESUME');
    expect(normalizeLayaCategory('EEO')).toBe('EEO');
    expect(normalizeLayaCategory('something-else')).toBe('UNKNOWN');
  });
});

// ── Rules engine ─────────────────────────────────────────────────────────

describe('RulesDecisionEngine (deterministic first)', () => {
  const rules = new RulesDecisionEngine();

  it('classifies known labels deterministically (no Laya needed)', async () => {
    const result = await rules.classifyField({ label: 'LinkedIn URL', type: 'URL', required: false });
    expect(result).not.toBeNull();
    expect(result!.canonicalKey).toBe('linkedinUrl');
    expect(result!.mappingMethod).toBe('DETERMINISTIC');
  });

  it('returns null for genuinely ambiguous labels (Laya territory)', async () => {
    expect(await rules.classifyField({ label: 'Why are you interested in this role?', type: 'TEXTAREA', required: true })).toBeNull();
    expect(await rules.classifyField({ label: 'Preferred location', type: 'SINGLE_SELECT', required: false, options: ['Remote'] })).toBeNull();
  });

  it('classifies EEO labels as blocked (never auto-resolvable)', async () => {
    const result = await rules.classifyField({ label: 'Gender (voluntary)', type: 'SINGLE_SELECT', required: false });
    expect(result).not.toBeNull();
    expect(result!.category).toBe('EEO');
    expect(isHardBlockedField(result!)).toBe(true);
  });
});

// ── Policy (hard blocks + confidence thresholds) ─────────────────────────

describe('Decision policy', () => {
  const engineResult = (over: Partial<FieldClassificationResult>): FieldClassificationResult => ({
    category: 'CONTACT',
    confidence: 0.95,
    mappingMethod: 'AI_SUGGESTED',
    requiresUser: true,
    ...over,
  });

  const resolve = (key: string) =>
    key === 'portfolioUrl' ? { value: 'https://atanu.dev', source: 'PROFILE' } : undefined;

  it('high-confidence benign suggestion with a resolved profile value → AI_SUGGESTED, no user required', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'urls[Portfolio]', label: 'Personal website', required: false },
      engineResult({ canonicalKey: 'portfolioUrl' }),
      resolve
    );
    expect(s).not.toBeNull();
    expect(s!.mappingMethod).toBe('AI_SUGGESTED');
    expect(s!.proposedValue).toBe('https://atanu.dev');
    expect(s!.requiresUser).toBe(false);
    expect(s!.hardBlocked).toBe(false);
  });

  it('medium confidence (0.70–0.90) → suggestion shown, requiresUser=true', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'urls[Portfolio]', label: 'Personal website', required: false },
      engineResult({ canonicalKey: 'portfolioUrl', confidence: 0.8 }),
      resolve
    );
    expect(s).not.toBeNull();
    expect(s!.proposedValue).toBe('https://atanu.dev');
    expect(s!.requiresUser).toBe(true);
  });

  it('low confidence (<0.70) → no suggestion at all', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'urls[Portfolio]', label: 'Personal website', required: false },
      engineResult({ canonicalKey: 'portfolioUrl', confidence: 0.5 }),
      resolve
    );
    expect(s).toBeNull();
  });

  it('high confidence but NO resolved package value → suggestion without a value, requiresUser=true', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'q1', label: 'Why do you want this role?', required: true },
      engineResult({ canonicalKey: 'whyInterested', category: 'CUSTOM', answerSource: 'GENERATIVE_REQUIRED' }),
      resolve
    );
    expect(s).not.toBeNull();
    expect(s!.proposedValue).toBeNull();
    expect(s!.requiresUser).toBe(true);
    expect(s!.answerSource).toBe('GENERATIVE_REQUIRED');
  });

  it('sensitive key (sponsorship) at 0.99 → value may be shown, but always requires the user', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'sponsorship', label: 'Will you require immigration assistance now or later?', required: true },
      engineResult({ canonicalKey: 'requiresSponsorship', category: 'SPONSORSHIP' }),
      (key) => (key === 'requiresSponsorship' ? { value: 'No', source: 'PROFILE' } : undefined)
    );
    expect(s).not.toBeNull();
    expect(s!.proposedValue).toBe('No');
    expect(s!.requiresUser).toBe(true);
  });

  it('EEO at 0.99 → hard-blocked, no value ever attached, requiresUser=true', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'gender', label: 'Gender', required: false },
      engineResult({ canonicalKey: 'gender', category: 'EEO', confidence: 0.99 }),
      () => ({ value: 'Female', source: 'PROFILE' })
    );
    expect(s).not.toBeNull();
    expect(s!.hardBlocked).toBe(true);
    expect(s!.proposedValue).toBeNull();
    expect(s!.requiresUser).toBe(true);
  });

  it('consent at 0.99 → hard-blocked, no value ever attached, requiresUser=true', () => {
    const s = decideFieldSuggestion(
      { providerFieldId: 'privacy_consent', label: 'I consent to the processing of my application data', required: true },
      engineResult({ canonicalKey: undefined, category: 'CONSENT', confidence: 0.99 }),
      () => ({ value: true, source: 'USER' })
    );
    expect(s).not.toBeNull();
    expect(s!.hardBlocked).toBe(true);
    expect(s!.proposedValue).toBeNull();
    expect(s!.requiresUser).toBe(true);
  });

  it('legal/background-check label patterns are hard-blocked even when the engine claims contact', () => {
    expect(isHardBlockedField(engineResult({ category: 'CONTACT' }), 'I authorize a background check')).toBe(true);
    expect(isHardBlockedField(engineResult({ category: 'CONTACT' }), 'Enter the CAPTCHA code')).toBe(true);
    expect(isHardBlockedField(engineResult({ category: 'CONTACT' }), 'One-time password')).toBe(true);
    expect(isHardBlockedField(engineResult({ category: 'CONTACT' }), 'Disability status')).toBe(true);
    expect(isHardBlockedField(engineResult({ category: 'CONTACT' }), 'Personal website')).toBe(false);
  });
});

// ── Service integration seam (type-level contract) ───────────────────────

describe('DecisionEngine contract', () => {
  it('a custom engine only needs name + classifyField', async () => {
    const engine: DecisionEngine = {
      name: 'custom',
      async classifyField(_input: FieldClassificationInput) {
        return null;
      },
    };
    expect(await engine.classifyField({ label: 'x', required: false })).toBeNull();
  });
});
