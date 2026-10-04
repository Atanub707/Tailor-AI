// Auto Apply — LayaDecisionEngine adapter.
//
// Talks to the LOCAL Laya sidecar (local-ai/laya/service.py) over HTTP on
// 127.0.0.1 ONLY. Laya-specific wire types never leave this file: callers
// see the neutral DecisionEngine contract.
//
// Safety properties:
//   * loopback-only — a non-loopback LAYA_URL is refused BEFORE any request
//   * strict per-request timeout (AbortSignal.timeout)
//   * never throws: unavailable / timeout / non-200 / malformed / invalid
//     shapes all resolve to null (the dry run then keeps the field unresolved)
//   * minimal payloads: label/type/required/options only — no candidate PII

import type {
  DecisionEngine,
  FieldClassificationInput,
  FieldClassificationResult,
  QuestionClassificationInput,
  QuestionClassificationResult,
} from './decisionEngine.js';
import { normalizeAnswerSource, normalizeLayaCategory } from './decisionEngine.js';

export interface LayaAdapterConfig {
  url: string;
  timeoutMs: number;
  // Confidence thresholds are intentionally NOT part of the adapter: the
  // policy layer (decisionEngine.decideFieldSuggestion) owns them, so every
  // engine is judged by the same rules.
}

const MAX_RESPONSE_CHARS = 100_000;

/** Loopback-only guard — the decision runtime is local by construction. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export class LayaDecisionEngine implements DecisionEngine {
  readonly name = 'laya';
  private warnedNonLoopback = false;

  constructor(private readonly config: LayaAdapterConfig) {}

  async classifyField(input: FieldClassificationInput): Promise<FieldClassificationResult | null> {
    const raw = await this.post('/classify-field', {
      label: String(input.label || '').slice(0, 500),
      type: input.type ? String(input.type).slice(0, 40) : undefined,
      required: Boolean(input.required),
      options: Array.isArray(input.options) ? input.options.slice(0, 50).map((o) => String(o).slice(0, 200)) : undefined,
    });
    if (!raw) return null;

    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    if (raw.category === undefined && raw.canonicalKey === undefined) return null;

    const canonicalKey =
      typeof raw.canonicalKey === 'string' && raw.canonicalKey.trim() && raw.canonicalKey.length <= 64
        ? raw.canonicalKey.trim()
        : undefined;

    return {
      canonicalKey,
      category: normalizeLayaCategory(raw.category),
      answerSource: normalizeAnswerSource(raw.answerSource),
      confidence,
      mappingMethod: 'AI_SUGGESTED',
      requiresUser: true, // engine is conservative; only the policy may relax
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined,
    };
  }

  async classifyQuestion(input: QuestionClassificationInput): Promise<QuestionClassificationResult | null> {
    const raw = await this.post('/classify-question', {
      question: String(input.question || '').slice(0, 500),
      type: input.type ? String(input.type).slice(0, 40) : undefined,
      required: Boolean(input.required),
      options: Array.isArray(input.options) ? input.options.slice(0, 50).map((o) => String(o).slice(0, 200)) : undefined,
    });
    if (!raw) return null;
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return {
      category: normalizeLayaCategory(raw.category),
      answerSource: normalizeAnswerSource(raw.answerSource) ?? 'USER_REQUIRED',
      confidence,
      requiresUser: true,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined,
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!isLoopbackUrl(this.config.url)) {
      if (!this.warnedNonLoopback) {
        this.warnedNonLoopback = true;
        // No URL/PII in the log — configuration safety only.
        console.warn('[AutoApply][Laya] Non-loopback runtime URL refused — decision engine disabled.');
      }
      return null;
    }
    try {
      const res = await fetch(`${this.config.url.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) return null;
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data as Record<string, unknown>;
    } catch {
      return null; // timeout / refused / malformed — always a safe no-op
    }
  }
}
