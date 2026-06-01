/**
 * M9.3 — buildIntentSystemPrompt + INTENT_PROMPT_TOKENS sanity.
 *
 * Snapshot-light structural assertions: today's ISO date is interpolated,
 * every MediaType wire value appears, every few-shot example is present,
 * and the token-cost constant is within a sane range. No LLM call.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIntentSystemPrompt,
  INTENT_PROMPT_TOKENS,
} from '../../src/lib/intent-prompt.js';
import { ALL_MEDIA_TYPES } from '../../src/lib/media-types.js';

describe('buildIntentSystemPrompt', () => {
  it("interpolates today's ISO date", () => {
    const prompt = buildIntentSystemPrompt(new Date('2026-06-01T00:00:00Z'));
    expect(prompt).toContain("Today's date is 2026-06-01");
  });

  it('mentions every MediaType wire value', () => {
    const prompt = buildIntentSystemPrompt(new Date('2026-06-01T00:00:00Z'));
    for (const m of ALL_MEDIA_TYPES) {
      expect(prompt).toContain(m);
    }
  });

  it('includes all four few-shot user examples', () => {
    const prompt = buildIntentSystemPrompt(new Date('2026-06-01T00:00:00Z'));
    expect(prompt).toContain('Analyze FreshSip brand coverage from April 1 to May 1');
    expect(prompt).toContain("What's the buzz around FreshSip on Twitter and LinkedIn last week?");
    expect(prompt).toContain('thinking about my brand');
    expect(prompt).toContain('Pull live data from OpenSearch on Pepsi vs Coke');
  });

  it('uses hardcoded ISO range for the "last week" few-shot example', () => {
    // The example dates are deliberately fixed for prompt stability — they do
    // NOT shift with the `today` argument.
    const prompt = buildIntentSystemPrompt(new Date('2026-06-01T00:00:00Z'));
    expect(prompt).toContain('"dateStart": "2026-05-25", "dateEnd": "2026-06-01"');
  });

  it('teaches media-type normalization for legacy "twitter" label', () => {
    const prompt = buildIntentSystemPrompt(new Date('2026-06-01T00:00:00Z'));
    expect(prompt).toContain('x_twitter');
    expect(prompt.toLowerCase()).toContain('twitter');
  });
});

describe('INTENT_PROMPT_TOKENS', () => {
  it('is within the documented 500..900 range (allows drift)', () => {
    expect(INTENT_PROMPT_TOKENS).toBeGreaterThanOrEqual(500);
    expect(INTENT_PROMPT_TOKENS).toBeLessThanOrEqual(900);
  });
});
