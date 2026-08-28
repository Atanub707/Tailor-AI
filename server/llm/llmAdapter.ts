import { loadConfig } from '../config.js';
import { askOpenAi } from './providers/openaiProvider.js';
import { askGemini } from './providers/geminiProvider.js';
import { askAnthropic } from './providers/anthropicProvider.js';
import { PROVIDER_BASE_URLS } from '../../src/constants/llmPresets.js';
import { normalizeLlmError, type LLMError } from './llmErrors.js';

// ONE centralized bounded timeout for every outbound LLM request.
// Env-configurable; the default is generous for long Tailor generations but
// still finite — an unreachable provider must never hang a request forever.
export function llmRequestTimeoutMs(): number {
  const v = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 60_000;
}

function resolveApiKey(configuredKey: string): string | undefined {
  if (configuredKey) return configuredKey;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  return undefined;
}

export { resolveApiKey };

export async function ask(prompt: string, temperature?: number, responseFormat: 'json' | 'text' = 'json'): Promise<string> {
  const config = loadConfig();
  const temp = temperature ?? config.llm.temperature ?? 0.2;
  const provider = config.llm.provider || 'gemini';
  const apiKey = resolveApiKey(config.llm.apiKey);
  const model = config.llm.model || 'gemini-3.6-flash';
  const timeoutMs = llmRequestTimeoutMs();

  if (!apiKey) {
    const err = new Error('No API key configured. Set one in Settings or via GEMINI_API_KEY env var.');
    (err as any).code = 'NO_API_KEY';
    throw err;
  }

  try {
    switch (provider) {
      case 'opencode-go':
      case 'openrouter':
      case 'openai': {
        const baseUrl = config.llm.baseUrl || PROVIDER_BASE_URLS[provider];
        return await askOpenAi({ baseUrl, apiKey, model, prompt, temperature: temp, responseFormat, timeoutMs });
      }
      case 'gemini':
        return await askGemini(apiKey, model, prompt, temp, timeoutMs);
      case 'anthropic':
        return await askAnthropic(apiKey, model, prompt, temp, timeoutMs);
      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }
  } catch (err) {
    throw normalizeLlmError(err);
  }
}

export { LLMError };
export type { LlmErrorCode } from './llmErrors.js';
