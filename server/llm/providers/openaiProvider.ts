export interface OpenAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  responseFormat?: 'json' | 'text';
  extraBody?: Record<string, any>;
  timeoutMs?: number;
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
  if (response.status === 429) {
    throw providerError('RATE_LIMIT', `rate limited (${response.status})`);
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
