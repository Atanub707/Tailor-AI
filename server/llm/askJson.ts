// askJson — the ONE model-agnostic way every LLM JSON consumer gets a
// parseable object.
//
// Users pick any model (minimax, kimi, qwen, grok, deepseek…) and each
// model has its own quirks: <thinking> wrappers, markdown fences, prose
// glued around the object, unquoted keys, trailing commas, literal "[...]"
// placeholders, occasional double-answers. Chasing per-model fixes is a
// losing game, so askJson:
//
//   1. wraps the prompt with explicit begin/end markers,
//   2. runs extraction through the repair cascade (jsonExtract),
//   3. retries ONCE with the parse error stated when a model misbehaves,
//   4. only then throws — the caller sees one clean failure, never
//      a model-dependent crash.
//
// Deterministic, no per-model branches, no guessing.

import { ask } from './llmAdapter.js';
import { extractJsonObject } from './jsonExtract.js';

const MARKER = 'JSON_RESULT';

export interface AskJsonOptions {
  temperature?: number;
  /** Bounded retries — 1 extra attempt on parse failure (costed, never infinite). */
  maxRetries?: number;
}

export async function askJson<T = unknown>(prompt: string, opts: AskJsonOptions = {}): Promise<T> {
  const { temperature = 0.2, maxRetries = 1 } = opts;
  const base = `${prompt}

Return ONLY ONE JSON object. Put it between these two markers:
begin ${MARKER}
end ${MARKER}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const finalPrompt = attempt === 0 ? base : `${base}

Retry — your previous answer could not be used because: ${String(lastErr instanceof Error ? lastErr.message : lastErr).slice(0, 180)}. Output the corrected JSON object between the markers now.`;
    const raw = await ask(finalPrompt, temperature);

    try {
      const start = raw.indexOf(`begin ${MARKER}`);
      const end = raw.indexOf(`end ${MARKER}`);
      const segment = start !== -1 && end > start
        ? raw.slice(start + `begin ${MARKER}`.length, end)
        : raw;
      return extractJsonObject(segment) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}