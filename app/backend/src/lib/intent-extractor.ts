/**
 * IntentExtractor — single-shot LLM that parses a user's first chat
 * message into structured chat-params fields.
 *
 * Returns a validated `Intent` object or throws. Caller (M9.4) is
 * responsible for deciding whether confidence is high enough to act on
 * each field, and for persisting non-null values to chat_params.
 *
 * On LLM error, throws. M9.4 catches and falls back to the existing
 * 6-step wizard so a flaky LLM call doesn't break chat onboarding.
 *
 * @file lib/intent-extractor.ts
 */
import { getModel, validateJSON } from './llm-gateway.js';
import { IntentSchema, type Intent } from '../types/intent.js';
import { buildIntentSystemPrompt } from './intent-prompt.js';

/** Cap on output tokens — typical response is ~150, 400 is a safety ceiling. */
const MAX_OUTPUT_TOKENS = 400;

/**
 * Free-text character cap. We slice rather than reject so a runaway paste
 * still extracts intent from the leading content instead of failing. 8000
 * chars ≈ ~2000 tokens — bounds the input-token cost predictably.
 */
const MAX_FREE_TEXT_CHARS = 8000;

/**
 * Extract structured intent from a free-text user message.
 *
 * @param userId - For multi-model routing via llm-gateway
 * @param freeText - The user's first chat message
 * @param options.today - Override "today" for tests
 * @returns Parsed + Zod-validated Intent
 * @throws on LLM error or non-conforming JSON
 */
export async function extractIntent(
  userId: string,
  freeText: string,
  options: { today?: Date } = {},
): Promise<Intent> {
  const provider = await getModel(userId);
  const truncated =
    freeText.length > MAX_FREE_TEXT_CHARS
      ? freeText.slice(0, MAX_FREE_TEXT_CHARS)
      : freeText;
  const completion = await provider.complete({
    messages: [
      { role: 'system', content: buildIntentSystemPrompt(options.today) },
      { role: 'user', content: truncated },
    ],
    jsonMode: true,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
  });
  const validation = validateJSON(completion.text, IntentSchema);
  if (!validation.valid) {
    throw new Error(
      `IntentExtractor: schema validation failed: ${validation.errors.join('; ')}`,
    );
  }
  return validation.data;
}
