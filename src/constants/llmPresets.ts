import { LlmProvider } from '../types';

// Per-provider LLM presets — the SINGLE source of truth for default base
// URLs, consumed by BOTH the Settings UI (auto-filled when the user picks a
// provider) and the server's LLM adapter (fallback when baseUrl is empty).
// Empty string = the provider's SDK does not need a base URL (Gemini,
// Anthropic use their official SDKs).
export const PROVIDER_BASE_URLS: Record<LlmProvider, string> = {
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  'openrouter': 'https://openrouter.ai/api/v1',
  'openai': 'https://api.openai.com/v1',
  'gemini': '',
  'anthropic': '',
  'nvidia': 'https://integrate.api.nvidia.com/v1',
};

// FALLBACK model list per provider — used ONLY when the live provider
// catalog (GET /models) cannot be fetched. The Settings UI prefers the
// live catalog (opencode-go / openrouter / openai / nvidia expose
// OpenAI-compatible /models); gemini + anthropic keep these static
// presets. 'Custom (type below)' is a UI sentinel, never sent to the API.
export const PROVIDER_FALLBACK_MODELS: Record<LlmProvider, string[]> = {
  'opencode-go': [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'grok-4.5',
    'glm-5.2',
    'glm-5.1',
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'minimax-m3',
    'minimax-m2.7',
    'hy3',
    'Custom (type below)',
  ],
  'openrouter': ['Custom (type below)'],
  'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini', 'Custom (type below)'],
  'gemini': ['gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'Custom (type below)'],
  'anthropic': ['claude-sonnet-4-20250514', 'claude-3.5-haiku', 'claude-opus-4', 'Custom (type below)'],
  'nvidia': ['deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct', 'mistralai/mistral-large', 'Custom (type below)'],
};
