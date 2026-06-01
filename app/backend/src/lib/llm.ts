import { AzureOpenAI } from 'openai';
import { loadEnv } from '../env.js';
import { createAzureOpenAIProvider } from './llm-providers/azure-openai.js';
import type { LLMProvider } from './llm-providers/types.js';

/**
 * Legacy Phase 1/2 entry points. Kept verbatim signatures so the orchestrator,
 * chat.service, and any other caller continue to work unchanged. Internally,
 * `chatComplete` and `parseChoice` now delegate to the Azure OpenAI provider
 * via the M8.2 gateway. Streaming (`chatCompleteStream`) still uses the SDK
 * directly because the provider abstraction is request/response — streaming
 * deltas don't fit that surface and will move to the provider in a later
 * milestone if/when we need per-user streaming routing.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompleteInput {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}

let cachedProvider: LLMProvider | undefined;
function getProvider(): LLMProvider {
  if (!cachedProvider) cachedProvider = createAzureOpenAIProvider();
  return cachedProvider;
}

/**
 * Non-streaming chat completion. Returns the assistant's text only.
 * Delegates to the Azure OpenAI provider. Throws if the LLM returns no
 * content (matching the prior behaviour callers rely on).
 */
export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  const response = await getProvider().complete({
    messages: [
      { role: 'system', content: input.system },
      ...input.messages,
    ],
    temperature: input.temperature,
  });
  if (!response.text) {
    throw new Error('LLM returned no content');
  }
  return response.text;
}

/**
 * Ask the LLM to pick one of `options` based on free-text user input.
 * Returns the matching option string, or null if the LLM says "unclear".
 *
 * Uses JSON-mode on the provider for deterministic parsing. Behaviour and
 * return contract are unchanged from Phase 1.
 */
export async function parseChoice(userInput: string, options: string[]): Promise<string | null> {
  const response = await getProvider().complete({
    temperature: 0,
    jsonMode: true,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict classifier. Given a user input and a list of valid choices, reply with JSON ' +
          '{"choice":"<exact-choice-string-or-unclear>"}. Use exactly one of the provided choices. ' +
          'If the input does not clearly match any choice, return "unclear".',
      },
      {
        role: 'user',
        content: `Input: ${userInput}\nValid choices: ${options.join(', ')}`,
      },
    ],
  });
  const content = response.text;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { choice?: string };
    if (!parsed.choice || parsed.choice === 'unclear') return null;
    if (!options.includes(parsed.choice)) return null;
    return parsed.choice;
  } catch {
    return null;
  }
}

/**
 * Stream Azure OpenAI chat completions as an async generator of text deltas.
 * Each yielded string is the raw delta (a token or short token sequence) —
 * callers concatenate to build the full message. Empty/role-only chunks are
 * skipped so callers never see "" deltas.
 *
 * Still uses the Azure SDK directly because the provider abstraction is
 * request/response only. Will migrate to the provider surface once streaming
 * becomes a per-user routing concern (Phase 5+).
 */
let streamingClient: AzureOpenAI | undefined;
function getStreamingClient(): AzureOpenAI {
  if (!streamingClient) {
    const env = loadEnv();
    streamingClient = new AzureOpenAI({
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiKey: env.AZURE_OPENAI_API_KEY,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return streamingClient;
}

export async function* chatCompleteStream(
  input: ChatCompleteInput,
): AsyncGenerator<string, void, void> {
  const env = loadEnv();
  const stream = await getStreamingClient().chat.completions.create({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    temperature: input.temperature ?? 0.3,
    stream: true,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages,
    ],
  });
  for await (const chunk of stream as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>) {
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      yield delta;
    }
  }
}
