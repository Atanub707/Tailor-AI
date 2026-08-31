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
      return "The AI provider didn't respond in time. This usually happens during the provider's peak hours when big requests (like tailoring a CV) queue up. Wait a few minutes and try again — or pick a different model (e.g. minimax-m3 or a Free model) in Settings, which are not affected by DeepSeek peak hours.";
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
