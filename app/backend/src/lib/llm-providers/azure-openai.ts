import { AzureOpenAI } from 'openai';
import { encoding_for_model, type TiktokenModel, type Tiktoken } from 'tiktoken';
import { loadEnv } from '../../env.js';
import type {
  LLMProvider,
  LLMProviderConfig,
  LLMCompleteRequest,
  LLMCompleteResponse,
} from './types.js';

/**
 * Azure OpenAI provider — wraps the existing Azure deployment with the
 * shared LLMProvider surface. Default for Phase 3 because Phase 1/2 already
 * use this deployment and existing callers (`chatComplete`, `parseChoice`)
 * delegate through here after the gateway refactor.
 */

// 3 retries, exponential-ish — matches the spec's "rate limits, 5xx" handling.
const RETRY_DELAYS_MS = [500, 1500, 4000];

// GPT-4.1 token window — adjust if the Azure deployment differs.
const GPT_41_MAX_INPUT = 200_000;
const GPT_41_DEFAULT_MAX_OUTPUT = 4_000;

let cachedClient: AzureOpenAI | undefined;
let cachedEncoder: Tiktoken | undefined;

function getClient(): AzureOpenAI {
  if (cachedClient) return cachedClient;
  const env = loadEnv();
  cachedClient = new AzureOpenAI({
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    apiKey: env.AZURE_OPENAI_API_KEY,
    apiVersion: env.AZURE_OPENAI_API_VERSION,
    deployment: env.AZURE_OPENAI_DEPLOYMENT,
  });
  return cachedClient;
}

function getEncoder(): Tiktoken {
  if (cachedEncoder) return cachedEncoder;
  // GPT-4.1 uses cl100k_base — tiktoken's "gpt-4" maps to it.
  cachedEncoder = encoding_for_model('gpt-4' satisfies TiktokenModel);
  return cachedEncoder;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  if (status === 429) return true; // rate limit
  if (typeof status === 'number' && status >= 500 && status < 600) return true; // server errors
  const msg = err.message ?? '';
  return /timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

export function createAzureOpenAIProvider(): LLMProvider {
  const config: LLMProviderConfig = {
    modelName: 'gpt-4.1',
    maxInputTokens: GPT_41_MAX_INPUT,
    defaultMaxOutputTokens: GPT_41_DEFAULT_MAX_OUTPUT,
  };

  return {
    id: 'azure-openai',
    config,
    countTokens(text: string): number {
      try {
        const enc = getEncoder();
        return enc.encode(text).length;
      } catch {
        // Fallback heuristic: 1 token ≈ 4 chars.
        return Math.ceil(text.length / 4);
      }
    },
    async complete(req: LLMCompleteRequest): Promise<LLMCompleteResponse> {
      const env = loadEnv();
      const client = getClient();
      const start = Date.now();
      let lastErr: unknown;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          const response = await client.chat.completions.create({
            model: env.AZURE_OPENAI_DEPLOYMENT,
            messages: req.messages,
            max_tokens: req.maxTokens ?? config.defaultMaxOutputTokens,
            temperature: req.temperature ?? 0.3,
            ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          });
          const text = response.choices[0]?.message?.content ?? '';
          const usage = response.usage;
          return {
            text,
            tokensInput: usage?.prompt_tokens ?? 0,
            tokensOutput: usage?.completion_tokens ?? 0,
            model: config.modelName,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          lastErr = err;
          if (!isRetriable(err) || attempt === RETRY_DELAYS_MS.length) break;
          await sleep(RETRY_DELAYS_MS[attempt]!);
        }
      }
      throw lastErr;
    },
  };
}
