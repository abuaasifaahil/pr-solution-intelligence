import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Ensure required env is set before any module loads (loadEnv reads at import).
beforeAll(() => {
  process.env.AZURE_OPENAI_ENDPOINT ??= 'https://example.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY ??= 'test-key-1234567890abcdef';
  process.env.AZURE_OPENAI_API_VERSION ??= '2025-03-01-preview';
  process.env.AZURE_OPENAI_DEPLOYMENT ??= 'gpt-4.1';
  process.env.ENCRYPTION_KEY ??=
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const createMock = vi.fn();
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { createAzureOpenAIProvider } = await import(
  '../../../src/lib/llm-providers/azure-openai.js'
);

function err(status: number, message = 'boom'): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe('azure-openai provider', () => {
  beforeEach(() => createMock.mockReset());

  it('countTokens returns a positive integer for non-empty input', () => {
    const p = createAzureOpenAIProvider();
    const n = p.countTokens('Hello world, this is a test sentence for tokenization.');
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it('countTokens returns 0 for empty string', () => {
    const p = createAzureOpenAIProvider();
    expect(p.countTokens('')).toBe(0);
  });

  it('complete returns text + usage on the happy path', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello there.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });
    const p = createAzureOpenAIProvider();
    const res = await p.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('Hello there.');
    expect(res.tokensInput).toBe(12);
    expect(res.tokensOutput).toBe(5);
    expect(res.model).toBe('gpt-4.1');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('complete forwards jsonMode as response_format', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const p = createAzureOpenAIProvider();
    await p.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonMode: true,
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('complete retries on 429 then succeeds', async () => {
    createMock
      .mockRejectedValueOnce(err(429, 'rate limit'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'after retry' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    const p = createAzureOpenAIProvider();
    const res = await p.complete({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(res.text).toBe('after retry');
    expect(createMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('complete retries on 503 then succeeds', async () => {
    createMock
      .mockRejectedValueOnce(err(503, 'unavailable'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    const p = createAzureOpenAIProvider();
    const res = await p.complete({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(res.text).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('complete does NOT retry on 400 client errors', async () => {
    createMock.mockRejectedValueOnce(err(400, 'bad request'));
    const p = createAzureOpenAIProvider();
    await expect(
      p.complete({ messages: [{ role: 'user', content: 'go' }] }),
    ).rejects.toThrow('bad request');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('complete exhausts retries and throws on persistent 5xx', async () => {
    // 1 initial attempt + 3 retries = 4 calls; use `Once` per call so vitest
    // does not flag leftover queued rejections as unhandled.
    createMock
      .mockRejectedValueOnce(err(500, 'server error'))
      .mockRejectedValueOnce(err(500, 'server error'))
      .mockRejectedValueOnce(err(500, 'server error'))
      .mockRejectedValueOnce(err(500, 'server error'));
    const p = createAzureOpenAIProvider();
    await expect(
      p.complete({ messages: [{ role: 'user', content: 'go' }] }),
    ).rejects.toThrow('server error');
    expect(createMock).toHaveBeenCalledTimes(4);
  }, 15_000);
});
