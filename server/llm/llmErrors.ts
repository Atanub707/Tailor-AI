// LLM error normalization — every provider failure becomes a safe,
// user-presentable application error. Never leaks secrets, keys, or raw
// provider payloads to the browser.

export type LlmErrorCode =
  | 'no_api_key'
  | 'no_model'
  | 'invalid_key'
  | 'invalid_model'
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'provider'
  | 'malformed'
  | 'llm_error';

export class LLMError extends Error {
  code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
  }
}

/** Map a thrown provider error to a normalized LLMError. */
export function normalizeLlmError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const name = String((err as { name?: string })?.name || '');
  const code = String((err as { code?: string })?.code || '');
  const message = String((err as Error)?.message || err || 'llm error').slice(0, 300);

  if (name === 'AbortError' || name === 'TimeoutError' || /abort|timeout/i.test(message)) {
    return new LLMError('timeout', "The AI provider didn't respond in time. Check your AI provider and try again.");
  }
  if (code === 'NO_API_KEY') {
    return new LLMError('no_api_key', 'No API token configured — add your API key in Settings.');
  }
  if (code === 'NO_MODEL') {
    return new LLMError('no_model', 'No AI model selected — choose a model in Settings.');
  }
  if (code === 'INVALID_MODEL' || /404/.test(message)) {
    return new LLMError('invalid_model', 'The model name or endpoint was not found — check the model and base URL in Settings.');
  }
  if (code === 'AUTH' || /401|403|api key|invalid.*key|unauthorized/i.test(message)) {
    return new LLMError('invalid_key', 'Your API key appears to be expired or invalid — update it in Settings.');
  }
  if (code === 'RATE_LIMIT' || /429|rate.?limit/i.test(message)) {
    return new LLMError('rate_limit', 'The AI provider is rate-limiting requests — wait a moment and try again.');
  }
  if (code === 'PROVIDER' || /5\d\d|server error/i.test(message)) {
    return new LLMError('provider', "The AI provider returned an error. Please try again.");
  }
  if (code === 'MALFORMED' || /no response content|unexpected|malformed/i.test(message)) {
    return new LLMError('malformed', 'The AI provider returned an unexpected response.');
  }
  if (code === 'NETWORK' || /fetch failed|econnrefused|enotfound|network|dns/i.test(message)) {
    return new LLMError('network', "Couldn't reach the configured AI provider. Check your network/endpoint and try again.");
  }
  return new LLMError('llm_error', "Tailoring couldn't complete because the AI provider did not respond. Check your AI provider/API key and try again.");
}