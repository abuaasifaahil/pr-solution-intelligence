/**
 * M9.3 — extractIntent() wraps the llm-gateway in a JSON-mode call and
 * validates the response against IntentSchema. These tests mock the
 * gateway end-to-end — no live Azure call. Mirrors the mocking style
 * from `enrichment.agent.test.ts` (vi.mock at module load, named export
 * substitution).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the LLM gateway ──────────────────────────────────────────────
// We let `validateJSON` flow through to the real implementation so the
// IntentSchema actually validates the mocked LLM response — that's what
// gives us coverage of the schema enforcement edge cases below.
const completeMock = vi.fn();
const fakeProvider = {
  id: 'azure-openai' as const,
  config: {
    modelName: 'gpt-4.1',
    maxInputTokens: 200_000,
    defaultMaxOutputTokens: 4_000,
  },
  countTokens: (s: string) => s.length,
  complete: completeMock,
};
const getModelMock = vi.fn(async () => fakeProvider);

vi.mock('../../src/lib/llm-gateway.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/llm-gateway.js')>(
    '../../src/lib/llm-gateway.js',
  );
  return {
    ...actual,
    getModel: getModelMock,
  };
});

const { extractIntent } = await import('../../src/lib/intent-extractor.js');

const USER = '00000000-0000-0000-0000-00000000aaaa';

function validIntentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brand: 'FreshSip',
    dateStart: '2026-04-01',
    dateEnd: '2026-05-01',
    competitors: ['PepsiCo'],
    intention: 'intention_based',
    enrichmentType: null,
    mediaTypes: [],
    dataSource: null,
    confidence: {
      brand: 0.95,
      dateRange: 0.95,
      competitors: 0.9,
      intention: 0.9,
      enrichmentType: 0.0,
      mediaTypes: 0.0,
      dataSource: 0.0,
    },
    ...overrides,
  });
}

function completionFor(text: string) {
  return {
    text,
    tokensInput: 100,
    tokensOutput: 50,
    model: 'gpt-4.1',
    durationMs: 250,
  };
}

beforeEach(() => {
  completeMock.mockReset();
  getModelMock.mockClear();
});

describe('extractIntent — happy path', () => {
  it('returns the Zod-validated Intent for a well-formed LLM response', async () => {
    completeMock.mockResolvedValueOnce(completionFor(validIntentJson()));
    const intent = await extractIntent(USER, 'Analyze FreshSip vs PepsiCo April 1 to May 1');
    expect(intent.brand).toBe('FreshSip');
    expect(intent.dateStart).toBe('2026-04-01');
    expect(intent.competitors).toEqual(['PepsiCo']);
    expect(intent.intention).toBe('intention_based');
    expect(intent.confidence.brand).toBe(0.95);
  });

  it('strips unknown keys (Zod default strip) and returns valid Intent', async () => {
    const withExtras = JSON.stringify({
      brand: 'FreshSip',
      dateStart: null,
      dateEnd: null,
      competitors: [],
      intention: null,
      enrichmentType: null,
      mediaTypes: [],
      dataSource: null,
      confidence: {
        brand: 0.8,
        dateRange: 0,
        competitors: 0,
        intention: 0,
        enrichmentType: 0,
        mediaTypes: 0,
        dataSource: 0,
      },
      // Hallucinated extras the LLM might add — must be silently stripped.
      hallucination: 'this should be dropped',
      extra: { nested: true },
    });
    completeMock.mockResolvedValueOnce(completionFor(withExtras));
    const intent = await extractIntent(USER, 'just my brand FreshSip');
    expect(intent.brand).toBe('FreshSip');
    expect((intent as Record<string, unknown>).hallucination).toBeUndefined();
  });
});

describe('extractIntent — validation failures', () => {
  it('throws when the LLM response is missing required confidence fields', async () => {
    const missingConf = JSON.stringify({
      brand: 'FreshSip',
      dateStart: null,
      dateEnd: null,
      competitors: [],
      intention: null,
      enrichmentType: null,
      mediaTypes: [],
      dataSource: null,
      // confidence object is missing entirely
    });
    completeMock.mockResolvedValueOnce(completionFor(missingConf));
    await expect(extractIntent(USER, 'foo')).rejects.toThrow(/schema validation/i);
  });

  it('throws when mediaTypes contains a legacy "twitter" label (non-enum)', async () => {
    // The prompt teaches the LLM to normalize to `x_twitter`. If it slips
    // through anyway, the Zod enum guard rejects it — we don't silently
    // accept legacy labels on the way in.
    completeMock.mockResolvedValueOnce(
      completionFor(validIntentJson({ mediaTypes: ['twitter'] })),
    );
    await expect(extractIntent(USER, 'twitter please')).rejects.toThrow();
  });
});

describe('extractIntent — gateway / call shape', () => {
  it('truncates free text > 8000 chars before calling the LLM', async () => {
    completeMock.mockResolvedValueOnce(completionFor(validIntentJson()));
    const longInput = 'x'.repeat(8001);
    await extractIntent(USER, longInput);
    expect(completeMock).toHaveBeenCalledTimes(1);
    const call = completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = call.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content.length).toBe(8000);
  });

  it('calls complete() with jsonMode=true, temperature=0, maxTokens=400', async () => {
    completeMock.mockResolvedValueOnce(completionFor(validIntentJson()));
    await extractIntent(USER, 'hello');
    expect(completeMock).toHaveBeenCalledTimes(1);
    const req = completeMock.mock.calls[0]![0] as {
      jsonMode: boolean;
      temperature: number;
      maxTokens: number;
    };
    expect(req.jsonMode).toBe(true);
    expect(req.temperature).toBe(0);
    expect(req.maxTokens).toBe(400);
  });

  it('rethrows when the LLM provider throws', async () => {
    completeMock.mockRejectedValueOnce(new Error('Azure 429'));
    await expect(extractIntent(USER, 'hello')).rejects.toThrow('Azure 429');
  });

  it('passes the user-supplied `today` to the system prompt builder', async () => {
    completeMock.mockResolvedValueOnce(completionFor(validIntentJson()));
    await extractIntent(USER, 'hello', { today: new Date('2026-06-01T00:00:00Z') });
    const call = completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const sysMsg = call.messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain("Today's date is 2026-06-01");
  });
});
