/**
 * M8.3 — Enrichment prompt assembly tests.
 *
 * Snapshot-style structural assertions on the LLMMessage[] sequence, plus
 * truncation + social-engagement + missing-field behaviour. The token-cost
 * test uses the Azure OpenAI provider's tiktoken-backed `countTokens` to
 * verify FEW_SHOT_OVERHEAD_TOKENS stays within ±100 of reality.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.AZURE_OPENAI_ENDPOINT ??= 'https://example.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY ??= 'test-key-1234567890abcdef';
  process.env.AZURE_OPENAI_API_VERSION ??= '2025-03-01-preview';
  process.env.AZURE_OPENAI_DEPLOYMENT ??= 'gpt-4.1';
  process.env.ENCRYPTION_KEY ??=
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// Provider import path must resolve at module load (lazy client init).
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

const {
  buildEnrichmentMessages,
  SYSTEM_PROMPT,
  FEW_SHOT_USER,
  FEW_SHOT_ASSISTANT,
  FEW_SHOT_OVERHEAD_TOKENS,
  MAX_ARTICLE_CHARS,
} = await import('../../src/lib/enrichment-prompt.js');
const { createAzureOpenAIProvider } = await import(
  '../../src/lib/llm-providers/azure-openai.js'
);
import type { PromptArticle } from '../../src/lib/enrichment-prompt.js';
import type { LLMMessage } from '../../src/lib/llm-providers/types.js';

function makeArticle(overrides: Partial<PromptArticle> = {}): PromptArticle {
  return {
    id: 'art-1',
    title: 'Test headline',
    content: 'Body content goes here.',
    description: null,
    source: 'Reuters',
    author: 'Jane Doe',
    url: 'https://reuters.com/a',
    publisherDomain: 'reuters.com',
    publishedDate: new Date('2026-04-15T12:00:00Z'),
    language: 'en',
    ...overrides,
  };
}

/** Helper: assert exactly 4 messages and return them as a tuple so the
 *  test body can destructure without `Object is possibly undefined`. */
function unpack4(msgs: LLMMessage[]): [LLMMessage, LLMMessage, LLMMessage, LLMMessage] {
  expect(msgs).toHaveLength(4);
  const [sys, fsUser, fsAsst, batch] = msgs;
  if (!sys || !fsUser || !fsAsst || !batch) throw new Error('unreachable');
  return [sys, fsUser, fsAsst, batch];
}

describe('buildEnrichmentMessages — structure', () => {
  it('returns 4 messages (system + few-shot user + few-shot assistant + user batch)', () => {
    const [sys, fsUser, fsAsst, batch] = unpack4(
      buildEnrichmentMessages([makeArticle()]),
    );
    expect(sys.role).toBe('system');
    expect(fsUser.role).toBe('user');
    expect(fsAsst.role).toBe('assistant');
    expect(batch.role).toBe('user');
  });

  it('uses the SYSTEM_PROMPT constant verbatim as the system message', () => {
    const [sys] = unpack4(buildEnrichmentMessages([makeArticle()]));
    expect(sys.content).toBe(SYSTEM_PROMPT);
  });

  it('uses the few-shot constants verbatim', () => {
    const [, fsUser, fsAsst] = unpack4(buildEnrichmentMessages([makeArticle()]));
    expect(fsUser.content).toBe(FEW_SHOT_USER);
    expect(fsAsst.content).toBe(FEW_SHOT_ASSISTANT);
  });

  it('embeds [A:<id>] for each article in the user batch message', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({ id: 'art-1' }),
        makeArticle({ id: 'art-2' }),
      ]),
    );
    expect(batch.content).toContain('[A:art-1]');
    expect(batch.content).toContain('[A:art-2]');
  });

  it('separates multiple articles with --- delimiter', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({ id: 'art-1' }),
        makeArticle({ id: 'art-2' }),
      ]),
    );
    expect(batch.content).toContain('\n\n---\n\n');
  });
});

describe('buildEnrichmentMessages — content formatting', () => {
  it('truncates very long content to ~MAX_ARTICLE_CHARS with marker', () => {
    const long = 'a'.repeat(MAX_ARTICLE_CHARS + 5_000);
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ content: long })]),
    );
    expect(batch.content).toContain('[...truncated...]');
    // The user message must NOT contain the full long string verbatim.
    expect(batch.content.length).toBeLessThan(long.length);
  });

  it('does not truncate short content', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ content: 'short body' })]),
    );
    expect(batch.content).toContain('short body');
    expect(batch.content).not.toContain('[...truncated...]');
  });

  it('falls back to description when content is null', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({ content: null, description: 'desc fallback' }),
      ]),
    );
    expect(batch.content).toContain('desc fallback');
  });

  it('renders unknown for missing source/author/domain/date', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({
          source: null,
          author: null,
          publisherDomain: null,
          publishedDate: null,
        }),
      ]),
    );
    expect(batch.content).toContain('Source: unknown');
    expect(batch.content).toContain('Domain: unknown');
    expect(batch.content).toContain('Author: unknown');
    expect(batch.content).toContain('Date: unknown');
  });

  it('renders ISO date (yyyy-mm-dd) when publishedDate is set', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({ publishedDate: new Date('2026-04-15T12:00:00Z') }),
      ]),
    );
    expect(batch.content).toContain('Date: 2026-04-15');
  });

  it('includes URL line when url is present', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ url: 'https://x.test/y' })]),
    );
    expect(batch.content).toContain('URL: https://x.test/y');
  });

  it('omits URL line when url is null', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ url: null })]),
    );
    expect(batch.content).not.toContain('URL:');
  });

  it('includes Social engagement line when isSocial=true and any metric is present', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([
        makeArticle({ isSocial: true, likes: 50, comments: 10, shares: 5 }),
      ]),
    );
    expect(batch.content).toContain('Social:');
    expect(batch.content).toContain('likes=50');
    expect(batch.content).toContain('comments=10');
    expect(batch.content).toContain('shares=5');
  });

  it('omits Social line for non-social articles', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ isSocial: false })]),
    );
    expect(batch.content).not.toContain('Social:');
  });

  it('omits Social line when isSocial=true but no metrics are provided', () => {
    const [, , , batch] = unpack4(
      buildEnrichmentMessages([makeArticle({ isSocial: true })]),
    );
    expect(batch.content).not.toContain('Social:');
  });
});

describe('FEW_SHOT_OVERHEAD_TOKENS estimate', () => {
  it('is within ±100 of the actual token count for system + few-shot prefix', () => {
    const provider = createAzureOpenAIProvider();
    const actual =
      provider.countTokens(SYSTEM_PROMPT) +
      provider.countTokens(FEW_SHOT_USER) +
      provider.countTokens(FEW_SHOT_ASSISTANT);
    const drift = Math.abs(actual - FEW_SHOT_OVERHEAD_TOKENS);
    expect(drift).toBeLessThanOrEqual(100);
  });
});
