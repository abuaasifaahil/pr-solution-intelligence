import { AzureOpenAI } from 'openai';
import { loadEnv } from '../env.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let client: AzureOpenAI | undefined;

function getClient(): AzureOpenAI {
  if (!client) {
    const env = loadEnv();
    client = new AzureOpenAI({
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiKey: env.AZURE_OPENAI_API_KEY,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return client;
}

export interface ChatCompleteInput {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}

export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  const env = loadEnv();
  const response = await getClient().chat.completions.create({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    temperature: input.temperature ?? 0.3,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages,
    ],
  });
  const choice = response.choices[0];
  if (!choice?.message?.content) {
    throw new Error('LLM returned no content');
  }
  return choice.message.content;
}

/**
 * Ask the LLM to pick one of `options` based on free-text user input.
 * Returns the matching option string, or null if the LLM says "unclear".
 */
export async function parseChoice(userInput: string, options: string[]): Promise<string | null> {
  const env = loadEnv();
  const response = await getClient().chat.completions.create({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    temperature: 0,
    response_format: { type: 'json_object' },
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
  const content = response.choices[0]?.message?.content;
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
 */
export async function* chatCompleteStream(
  input: ChatCompleteInput,
): AsyncGenerator<string, void, void> {
  const env = loadEnv();
  const stream = await getClient().chat.completions.create({
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
