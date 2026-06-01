/**
 * Provider-agnostic LLM types. Each concrete provider (Azure OpenAI today;
 * Claude / Ollama / Perplexity later) implements `LLMProvider`. Callers
 * should depend on this surface — not on a specific SDK — so the gateway
 * can switch providers per-user without rippling into agent code.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompleteRequest {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Optional structured output mode (JSON object) — provider-specific implementation. */
  jsonMode?: boolean;
}

export interface LLMCompleteResponse {
  text: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  durationMs: number;
}

export interface LLMProviderConfig {
  /** Model identifier (e.g. "gpt-4.1", "claude-sonnet-4"). */
  modelName: string;
  /** Max input token window for batch sizing. */
  maxInputTokens: number;
  /** Max output tokens to request by default. */
  defaultMaxOutputTokens: number;
}

export type LLMProviderId = 'azure-openai' | 'claude' | 'ollama' | 'perplexity';

export interface LLMProvider {
  readonly id: LLMProviderId;
  config: LLMProviderConfig;
  /** Token count for a given string per this provider's tokenizer. */
  countTokens(text: string): number;
  /** Full completion call (handles retries internally). */
  complete(request: LLMCompleteRequest): Promise<LLMCompleteResponse>;
}

export interface LLMProviderError extends Error {
  retriable: boolean;
  statusCode?: number;
}
