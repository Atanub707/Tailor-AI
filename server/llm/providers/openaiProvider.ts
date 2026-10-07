export interface OpenAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  responseFormat?: 'json' | 'text';
  extraBody?: Record<string, any>;
  timeoutMs?: number;
  /** Extra headers (e.g. x-opencode-session for OpenCode Go). */
  extraHeaders?: Record<string, string>;
}

function providerError(code: string, message: string): Error {
  const e = new Error(message);
  (e as any).code = code;
  return e;
}

export async function askOpenAi(options: OpenAiOptions): Promise<string> {
  const url = options.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const timeoutMs = options.timeoutMs ?? 60_000;

  const body: Record<string, any> = {
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    temperature: options.temperature,
  };

  if (options.responseFormat !== 'text') {
    body.response_format = { type: 'json_object' };
  }

  if (options.extraBody) {
    Object.assign(body, options.extraBody);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    // AbortSignal.timeout aborts the ACTUAL request; DNS/network errors
    // surface as TypeError. Both are mapped upstream by normalizeLlmError.
    throw providerError(err?.name === 'TimeoutError' || /abort|timeout/i.test(String(err?.name || err)) ? 'TIMEOUT' : 'NETWORK', String(err?.message || err).slice(0, 200));
  }

  if (response.status === 401 || response.status === 403) {
    throw providerError('AUTH', `auth failed (${response.status})`);
  }
  if (response.status === 404) {
    throw providerError('INVALID_MODEL', `model/endpoint not found (404) — check the model name and base URL`);
  }
  if (response.status === 429) {
    // Two very different 429s: a TRANSIENT burst limit (retry in seconds)
    // vs a QUOTA/budget exhaustion (retry in hours/days — retrying is
    // pointless and burns nothing but user time). The Go gateway types them
    // in the body and sends Retry-After seconds.
    let retryAfterSec = 0;
    try { retryAfterSec = Number(response.headers?.get?.('retry-after') || 0); } catch { /* stub responses */ }
    let errType = '';
    try {
      const j: any = await response.json();
      errType = String(j?.error?.type || '');
    } catch { /* body may be empty */ }
    const quota = /UsageLimit|Quota|Budget|CreditLimit|InsufficientBalance/i.test(errType) || (Number.isFinite(retryAfterSec) && retryAfterSec > 90);
    const e = providerError(quota ? 'QUOTA' : 'RATE_LIMIT', quota ? `usage limit exceeded (${errType || 'quota'})` : `rate limited (${response.status})`);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) (e as any).retryAfterMs = retryAfterSec * 1000;
    throw e;
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw providerError(response.status >= 500 ? 'PROVIDER' : 'PROVIDER', `OpenAI-compatible API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw providerError('MALFORMED', 'malformed provider response');
  }

  if (!data.choices?.[0]?.message?.content) {
    throw providerError('MALFORMED', 'No response content from OpenAI-compatible API');
  }

  return data.choices[0].message.content;
}
