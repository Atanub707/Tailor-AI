export type LlmErrorCode = 'no_api_key' | 'no_model' | 'invalid_key' | 'invalid_model' | 'llm_error' | 'timeout' | 'network' | 'rate_limit' | 'provider' | 'malformed';

export function llmErrorMessage(code: string | undefined, raw: string): string {
  switch (code) {
    case 'no_api_key':
      return 'No API token configured — add your API key in Settings. This process will not run.';
    case 'invalid_key':
      return 'Your API key appears to be expired or invalid — update it in Settings.';
    case 'no_model':
      return 'No AI model selected — choose a model in Settings.';
    case 'invalid_model':
      return 'The model name or endpoint was not found — check the model and base URL in Settings.';
    case 'timeout':
      return "The AI provider didn't respond in time. Check your AI provider and try again.";
    case 'network':
      return "Couldn't reach the configured AI provider. Check your network/endpoint and try again.";
    case 'rate_limit':
      return 'The AI provider is rate-limiting requests — wait a moment and try again.';
    case 'provider':
      return 'The AI provider returned an error. Please try again.';
    case 'malformed':
      return 'The AI provider returned an unexpected response.';
    case 'llm_error':
      return raw || "Tailoring couldn't complete because the configured AI provider did not respond. Check your AI provider/API key and try again.";
    default:
      return raw || 'Something went wrong.';
  }
}
