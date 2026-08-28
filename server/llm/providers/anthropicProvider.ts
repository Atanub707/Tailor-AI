export async function askAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
  timeoutMs = 60_000
): Promise<string> {
  function providerError(code: string, message: string): Error {
    const e = new Error(message);
    (e as any).code = code;
    return e;
  }

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw providerError(err?.name === 'TimeoutError' || /abort|timeout/i.test(String(err?.name || err)) ? 'TIMEOUT' : 'NETWORK', String(err?.message || err).slice(0, 200));
  }

  if (response.status === 401 || response.status === 403) throw providerError('AUTH', `auth failed (${response.status})`);
  if (response.status === 429) throw providerError('RATE_LIMIT', `rate limited (${response.status})`);
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw providerError(response.status >= 500 ? 'PROVIDER' : 'PROVIDER', `Anthropic API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw providerError('MALFORMED', 'malformed provider response');
  }

  const content = data?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  if (!content) throw providerError('MALFORMED', 'No response content from Anthropic');
  return content;
}
