import type { ZodSchema } from 'zod';
import { withUser } from './prisma-rls.js';
import { createAzureOpenAIProvider } from './llm-providers/azure-openai.js';
import type {
  LLMProvider,
  LLMCompleteRequest,
  LLMCompleteResponse,
} from './llm-providers/types.js';

/**
 * Multi-model LLM gateway. Phase 3 wires up Azure OpenAI as the sole concrete
 * provider; Claude / Ollama / Perplexity register here in later phases. All
 * agent code should depend on this surface so swapping providers (per-user
 * routing, fallbacks) does not ripple through callers.
 */

/** Cached default provider — most callers won't need user-specific routing yet. */
let defaultProvider: LLMProvider | undefined;

function getDefaultProvider(): LLMProvider {
  if (!defaultProvider) defaultProvider = createAzureOpenAIProvider();
  return defaultProvider;
}

/** Test-only hook: reset the cached default provider between tests. */
export function _resetDefaultProviderForTests(): void {
  defaultProvider = undefined;
}

/**
 * Resolve the LLM provider for a given user. Phase 3 reads M5's `llm_configs`
 * to pick a model; if absent (no per-user config), returns the default Azure
 * OpenAI provider. Future Claude / Ollama / Perplexity providers register here.
 */
export async function getModel(userId: string): Promise<LLMProvider> {
  const config = await withUser(userId, async (tx) =>
    tx.lLMConfig.findFirst({
      where: { isDefault: true },
      orderBy: { createdAt: 'desc' },
    }),
  );
  if (!config) return getDefaultProvider();

  // Only Azure OpenAI ("gpt") is implemented in Phase 3. For other providers,
  // log a warning and fall back to the default so the system stays operable.
  if (config.provider !== 'gpt') {
    // eslint-disable-next-line no-console
    console.warn(
      `[llm-gateway] provider ${config.provider} not yet implemented; falling back to azure-openai`,
    );
    return getDefaultProvider();
  }

  // GPT-via-`llm_configs` would use the user's BYOK API key (decrypted from
  // M5). For Azure OpenAI we currently use the platform-wide deployment, NOT
  // the user's key. Once user-BYOK lands, swap the provider construction here.
  // Returning the default for now is correct — same behavior.
  return getDefaultProvider();
}

/** Token count via the provider's tokenizer. */
export function countTokens(text: string, provider?: LLMProvider): number {
  return (provider ?? getDefaultProvider()).countTokens(text);
}

/**
 * Greedy bin-packing: groups articles into batches whose total token cost
 * stays ≤ targetTokens. Articles larger than targetTokens each get their
 * own batch (oversize), so the caller is responsible for any truncation.
 */
export function createBatches(
  articleTokens: number[],
  targetTokens: number,
): Array<{ indices: number[]; tokenSum: number }> {
  const batches: Array<{ indices: number[]; tokenSum: number }> = [];
  let current = { indices: [] as number[], tokenSum: 0 };
  for (let i = 0; i < articleTokens.length; i++) {
    const t = articleTokens[i]!;
    if (current.tokenSum + t > targetTokens && current.indices.length > 0) {
      batches.push(current);
      current = { indices: [i], tokenSum: t };
    } else {
      current.indices.push(i);
      current.tokenSum += t;
    }
  }
  if (current.indices.length > 0) batches.push(current);
  return batches;
}

/**
 * Compute batch sizing for a given provider and article corpus. Targets 80%
 * of the provider's max input window to leave room for the system prompt
 * and few-shot examples.
 */
export function planBatching(
  articles: Array<{ id: string; content: string }>,
  provider: LLMProvider,
): {
  batches: Array<{ articleIds: string[]; estimatedTokens: number }>;
  totalEstimatedTokens: number;
} {
  const target = Math.floor(provider.config.maxInputTokens * 0.8);
  const tokens = articles.map((a) => provider.countTokens(a.content));
  const packed = createBatches(tokens, target);
  return {
    batches: packed.map((b) => ({
      articleIds: b.indices.map((i) => articles[i]!.id),
      estimatedTokens: b.tokenSum,
    })),
    totalEstimatedTokens: tokens.reduce((a, b) => a + b, 0),
  };
}

/**
 * Forward to the provider's `complete()`. Convenience wrapper for callers
 * who don't care which provider answered.
 */
export async function complete(
  request: LLMCompleteRequest,
  provider?: LLMProvider,
): Promise<LLMCompleteResponse> {
  return (provider ?? getDefaultProvider()).complete(request);
}

/**
 * Validate an LLM text response as JSON, optionally against a Zod schema.
 * Strips markdown code fences, leading prose, and trailing prose before
 * giving up. Returns a discriminated union so callers can pattern-match.
 */
export function validateJSON<T>(
  raw: string,
  schema?: ZodSchema<T>,
): { valid: true; data: T } | { valid: false; errors: string[] } {
  let text = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences (multi-line tolerant).
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1]!.trim();

  // Strip leading prose like "Here is the JSON:" by finding the first `{` or `[`.
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const candidates: number[] = [];
  if (firstObj !== -1) candidates.push(firstObj);
  if (firstArr !== -1) candidates.push(firstArr);
  if (candidates.length > 0) {
    const firstBracket = Math.min(...candidates);
    if (firstBracket > 0) text = text.slice(firstBracket);
  }

  // Strip trailing prose after the last `}` or `]`.
  const lastBracket = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastBracket >= 0 && lastBracket < text.length - 1) {
    text = text.slice(0, lastBracket + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`JSON parse failed: ${(err as Error).message}`] };
  }
  if (!schema) return { valid: true, data: parsed as T };

  const result = schema.safeParse(parsed);
  if (result.success) return { valid: true, data: result.data };
  return {
    valid: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

// Re-export provider types for callers.
export type {
  LLMProvider,
  LLMCompleteRequest,
  LLMCompleteResponse,
} from './llm-providers/types.js';
