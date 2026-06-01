import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { z } from 'zod';

beforeAll(() => {
  process.env.AZURE_OPENAI_ENDPOINT ??= 'https://example.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY ??= 'test-key-1234567890abcdef';
  process.env.AZURE_OPENAI_API_VERSION ??= '2025-03-01-preview';
  process.env.AZURE_OPENAI_DEPLOYMENT ??= 'gpt-4.1';
  process.env.ENCRYPTION_KEY ??=
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// Mock the openai SDK because the Azure OpenAI provider imports it at module
// load (cached client is lazy, but the import path must resolve).
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

// Mock prisma-rls so getModel can route through a fake `withUser`.
const mockLLM = { findFirst: vi.fn() };
vi.mock('@prsi/shared/db', () => ({
  prisma: { lLMConfig: mockLLM, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_u: string, fn: (tx: unknown) => unknown) =>
    fn({ lLMConfig: mockLLM }),
  ),
  asAdmin: vi.fn(),
}));

const {
  createBatches,
  planBatching,
  validateJSON,
  getModel,
  countTokens,
} = await import('../../src/lib/llm-gateway.js');

describe('llm-gateway.createBatches', () => {
  it('packs 3 articles of 100/100/100 into 2 batches at target 200', () => {
    const out = createBatches([100, 100, 100], 200);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ indices: [0, 1], tokenSum: 200 });
    expect(out[1]).toEqual({ indices: [2], tokenSum: 100 });
  });

  it('gives an oversize article its own batch', () => {
    const out = createBatches([5_000], 1_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ indices: [0], tokenSum: 5_000 });
  });

  it('packs many small articles into a single batch when they all fit', () => {
    const tokens = [10, 20, 30, 40, 50];
    const out = createBatches(tokens, 1_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.indices).toEqual([0, 1, 2, 3, 4]);
    expect(out[0]?.tokenSum).toBe(150);
  });

  it('handles an empty input gracefully', () => {
    expect(createBatches([], 100)).toEqual([]);
  });
});

describe('llm-gateway.planBatching', () => {
  it('returns batches with articleIds and per-batch estimatedTokens', () => {
    const articles = [
      { id: 'a', content: 'hello world' },
      { id: 'b', content: 'another article' },
      { id: 'c', content: 'a third one' },
    ];
    const fakeProvider = {
      id: 'azure-openai' as const,
      config: { modelName: 'fake', maxInputTokens: 10, defaultMaxOutputTokens: 2 },
      countTokens: (t: string) => t.length,
      complete: vi.fn(),
    };
    const plan = planBatching(articles, fakeProvider);
    expect(plan.batches.length).toBeGreaterThan(0);
    for (const b of plan.batches) {
      expect(b.articleIds.length).toBeGreaterThan(0);
      expect(b.estimatedTokens).toBeGreaterThan(0);
    }
    const allIds = plan.batches.flatMap((b) => b.articleIds);
    expect(allIds).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(plan.totalEstimatedTokens).toBe(
      articles.reduce((sum, a) => sum + a.content.length, 0),
    );
  });
});

describe('llm-gateway.validateJSON', () => {
  it('parses clean JSON', () => {
    const res = validateJSON('{"a":1}');
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    const raw = '```json\n{"a":1}\n```';
    const res = validateJSON(raw);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual({ a: 1 });
  });

  it('strips a plain ``` fence', () => {
    const raw = '```\n{"x":"y"}\n```';
    const res = validateJSON(raw);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual({ x: 'y' });
  });

  it('strips leading prose before JSON', () => {
    const raw = 'Here is the JSON: {"a":1}';
    const res = validateJSON(raw);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual({ a: 1 });
  });

  it('strips trailing prose after JSON', () => {
    const raw = '{"a":1}\nHope that helps!';
    const res = validateJSON(raw);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual({ a: 1 });
  });

  it('validates against a Zod schema (pass)', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const res = validateJSON('{"name":"alice","age":30}', schema);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data.name).toBe('alice');
  });

  it('validates against a Zod schema (fail) and returns errors', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const res = validateJSON('{"name":"alice","age":"old"}', schema);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors.some((e) => e.includes('age'))).toBe(true);
    }
  });

  it('returns errors for completely malformed input', () => {
    const res = validateJSON('not json at all');
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors[0]).toMatch(/parse failed/i);
  });

  it('parses an array root', () => {
    const res = validateJSON('[1,2,3]');
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.data).toEqual([1, 2, 3]);
  });
});

describe('llm-gateway.getModel', () => {
  beforeEach(() => mockLLM.findFirst.mockReset());

  it('returns the default provider when no llm_configs row exists', async () => {
    mockLLM.findFirst.mockResolvedValueOnce(null);
    const provider = await getModel('user-1');
    expect(provider.id).toBe('azure-openai');
    expect(provider.config.modelName).toBe('gpt-4.1');
  });

  it('falls back to default + warns when provider is claude (not yet implemented)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLLM.findFirst.mockResolvedValueOnce({
      id: 'cfg-1',
      provider: 'claude',
      modelName: 'claude-sonnet-4',
      isDefault: true,
    });
    const provider = await getModel('user-2');
    expect(provider.id).toBe('azure-openai');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/provider claude not yet implemented/i),
    );
    warnSpy.mockRestore();
  });

  it('returns default for a gpt-provider config (Azure deployment used)', async () => {
    mockLLM.findFirst.mockResolvedValueOnce({
      id: 'cfg-2',
      provider: 'gpt',
      modelName: 'gpt-4.1',
      isDefault: true,
    });
    const provider = await getModel('user-3');
    expect(provider.id).toBe('azure-openai');
  });
});

describe('llm-gateway.countTokens', () => {
  it('routes through the default provider when none is passed', () => {
    const n = countTokens('Hello there.');
    expect(n).toBeGreaterThan(0);
  });

  it('uses an explicit provider when supplied', () => {
    const fakeProvider = {
      id: 'azure-openai' as const,
      config: { modelName: 'fake', maxInputTokens: 1, defaultMaxOutputTokens: 1 },
      countTokens: (t: string) => t.length * 2,
      complete: vi.fn(),
    };
    expect(countTokens('abc', fakeProvider)).toBe(6);
  });
});
