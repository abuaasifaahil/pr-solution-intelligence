/**
 * M9.4 — intent-application.service unit tests.
 *
 * Mocks `patchParams` so we can assert exactly which fields the service
 * tried to persist, the enrichmentType value translation, and the
 * confidence-threshold filtering. No DB, no LLM.
 *
 * M9.6b additions — supplement path tests. Mock `sampleClassifier`,
 * `createAdapter`, `resolveOpenSearchConfig`, and `withUser` so we can
 * assert the feature-flagged classifier-supplement integration without
 * spinning up DB / OS / adapters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Intent } from '../../src/types/intent.js';

// Typed as (userId, chatId, patch) so call-tuple indexing in assertions
// preserves the patch shape (Record<string, unknown>) rather than `never`.
const patchParamsMock = vi.fn(
  async (_userId: string, _chatId: string, _patch: Record<string, unknown>) => ({}),
);
vi.mock('../../src/services/chat-params.service.js', () => ({
  patchParams: patchParamsMock,
}));

// ─── M9.6b supplement-path mocks ──────────────────────────────────────────
let chatParamsRow: Record<string, unknown> | null = {
  brand: null,
  dateStart: null,
  dateEnd: null,
  competitors: [],
  intention: null,
  enrichmentType: null,
  mediaTypes: [],
  dataSource: 'opensearch',
  uploadId: null,
};

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      chatParams: {
        findUnique: vi.fn(async () => chatParamsRow),
      },
    };
    return fn(tx);
  }),
}));

const classifyAndProbeMock = vi.fn(async () => ({
  inferred: { brand: 'FreshSip' },
  confidence: { brand: 0.85 },
  probes: [
    {
      field: 'competitors' as const,
      question: 'Compare against?',
      chips: [],
      allowFreeText: true,
      rationale: 'stub',
    },
  ],
  rationale: 'stub',
  perSourceStats: [],
}));
vi.mock('../../src/lib/sample-classifier.js', () => ({
  sampleClassifier: { classifyAndProbe: classifyAndProbeMock },
}));

const fakeAdapter = {
  declaredCapabilities: () => ({
    hasReach: 'usually' as const,
    hasArticleSentiment: 'usually' as const,
    hasEntities: 'usually' as const,
    hasThemes: 'usually' as const,
    hasEngagement: 'usually' as const,
    hasCountry: 'usually' as const,
    hasAuthor: 'usually' as const,
  }),
  // eslint-disable-next-line @typescript-eslint/require-await
  fetch: async function* () {
    yield { articles: [], progress: { page: 1, cumulativeArticles: 0, isLastPage: true } };
  },
};
const createAdapterMock = vi.fn(() => fakeAdapter);
vi.mock('../../src/data-sources/registry.js', () => ({
  createAdapter: createAdapterMock,
}));

const resolveOpenSearchConfigMock = vi.fn(async () => ({
  url: 'https://os.example.com',
  username: 'u',
  password: 'p',
  indexName: 'amx*',
  indexType: 'daywise' as const,
}));
vi.mock('../../src/data-sources/opensearch/config-resolver.js', () => ({
  resolveOpenSearchConfig: resolveOpenSearchConfigMock,
}));

const { applyIntentToChatParams, markIntentExtracted } = await import(
  '../../src/services/intent-application.service.js'
);

const USER_A = '00000000-0000-0000-0000-00000000aaaa';
const CHAT_A = '00000000-0000-0000-0000-00000000bbbb';

/** Build a fully-confident, fully-populated Intent for the happy-path test. */
function fullIntent(): Intent {
  return {
    brand: 'FreshSip',
    dateStart: '2026-04-01',
    dateEnd: '2026-05-01',
    competitors: ['PepsiCo', 'Coca-Cola'],
    intention: 'intention_based',
    enrichmentType: 'enrichment_plus_reach',
    mediaTypes: ['x_twitter', 'linkedin'],
    dataSource: 'opensearch',
    confidence: {
      brand: 0.95,
      dateRange: 0.95,
      competitors: 0.95,
      intention: 0.95,
      enrichmentType: 0.95,
      mediaTypes: 0.95,
      dataSource: 0.95,
    },
  };
}

/** Build an empty / unconfident Intent — nothing the user named. */
function emptyIntent(): Intent {
  return {
    brand: null,
    dateStart: null,
    dateEnd: null,
    competitors: [],
    intention: null,
    enrichmentType: null,
    mediaTypes: [],
    dataSource: null,
    confidence: {
      brand: 0,
      dateRange: 0,
      competitors: 0,
      intention: 0,
      enrichmentType: 0,
      mediaTypes: 0,
      dataSource: 0,
    },
  };
}

describe('intent-application.service', () => {
  beforeEach(() => {
    patchParamsMock.mockClear();
  });

  it('full-spec Intent → all 7 fields applied', async () => {
    const out = await applyIntentToChatParams(USER_A, CHAT_A, fullIntent());
    expect(out.appliedFields.sort()).toEqual(
      [
        'brand',
        'competitors',
        'dataSource',
        'dateRange',
        'enrichmentType',
        'intention',
        'mediaTypes',
      ].sort(),
    );
    expect(out.skippedDueToConfidence).toEqual([]);
    expect(patchParamsMock).toHaveBeenCalledTimes(1);
  });

  it("enrichmentType: 'enrichment_plus_reach' → patch.enrichmentType: 'reach' (translation)", async () => {
    await applyIntentToChatParams(USER_A, CHAT_A, fullIntent());
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { enrichmentType?: string }).enrichmentType).toBe('reach');
  });

  it("enrichmentType: 'enrichment' → patch.enrichmentType: 'standard' (translation)", async () => {
    const intent = fullIntent();
    intent.enrichmentType = 'enrichment';
    await applyIntentToChatParams(USER_A, CHAT_A, intent);
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { enrichmentType?: string }).enrichmentType).toBe('standard');
  });

  it('confidence.brand=0.3 → brand skipped, included in skippedDueToConfidence', async () => {
    const intent = fullIntent();
    intent.confidence.brand = 0.3;
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.appliedFields).not.toContain('brand');
    expect(out.skippedDueToConfidence).toContain('brand');
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { brand?: string }).brand).toBeUndefined();
  });

  it('all confidence=0 + all values=null → patchParams NOT called', async () => {
    const out = await applyIntentToChatParams(USER_A, CHAT_A, emptyIntent());
    expect(out.appliedFields).toEqual([]);
    expect(out.skippedDueToConfidence).toEqual([]);
    expect(patchParamsMock).not.toHaveBeenCalled();
  });

  it('brand=null → NOT counted as skipped-due-to-confidence (different category)', async () => {
    const intent = fullIntent();
    intent.brand = null;
    // Confidence stays at 0.95 — but value is null, so the user just
    // didn't mention it. That's distinct from a low-confidence guess.
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.appliedFields).not.toContain('brand');
    expect(out.skippedDueToConfidence).not.toContain('brand');
  });

  it('competitors=[] → not included in patch (regardless of confidence)', async () => {
    const intent = fullIntent();
    intent.competitors = [];
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.appliedFields).not.toContain('competitors');
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { competitors?: unknown }).competitors).toBeUndefined();
  });

  it("mediaTypes=['x_twitter','linkedin'] confidence=0.95 → patch.mediaTypes set correctly", async () => {
    await applyIntentToChatParams(USER_A, CHAT_A, fullIntent());
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { mediaTypes?: string[] }).mediaTypes).toEqual([
      'x_twitter',
      'linkedin',
    ]);
  });

  it('dateRange: writes start, end, and dateRangeType="custom" together', async () => {
    await applyIntentToChatParams(USER_A, CHAT_A, fullIntent());
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    const p = patch as { dateStart?: Date; dateEnd?: Date; dateRangeType?: string };
    expect(p.dateStart).toBeInstanceOf(Date);
    expect(p.dateEnd).toBeInstanceOf(Date);
    expect(p.dateRangeType).toBe('custom');
    expect(p.dateStart!.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(p.dateEnd!.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('half-filled date range (only dateStart, no dateEnd) → date NOT applied', async () => {
    const intent = fullIntent();
    intent.dateEnd = null;
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.appliedFields).not.toContain('dateRange');
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { dateStart?: Date }).dateStart).toBeUndefined();
    expect((patch as { dateEnd?: Date }).dateEnd).toBeUndefined();
  });

  it('competitors → also writes competitorSet="custom" alongside the array', async () => {
    await applyIntentToChatParams(USER_A, CHAT_A, fullIntent());
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { competitorSet?: string }).competitorSet).toBe('custom');
    expect((patch as { competitors?: string[] }).competitors).toEqual([
      'PepsiCo',
      'Coca-Cola',
    ]);
  });

  it('confidence threshold is exactly 0.5 — value AT threshold is APPLIED', async () => {
    const intent = fullIntent();
    intent.confidence.brand = 0.5;
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.appliedFields).toContain('brand');
  });

  it('confidence just below 0.5 (e.g. 0.49) → skipped', async () => {
    const intent = fullIntent();
    intent.confidence.brand = 0.49;
    const out = await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(out.skippedDueToConfidence).toContain('brand');
  });

  it('markIntentExtracted → calls patchParams with intentExtractedAt set', async () => {
    const at = new Date('2026-06-01T12:00:00Z');
    await markIntentExtracted(USER_A, CHAT_A, at);
    expect(patchParamsMock).toHaveBeenCalledTimes(1);
    const [, , patch] = patchParamsMock.mock.calls[0]!;
    expect((patch as { intentExtractedAt?: Date }).intentExtractedAt).toEqual(at);
  });
});

describe('M9.6b — sample-classifier supplement (feature-flagged)', () => {
  beforeEach(() => {
    patchParamsMock.mockClear();
    classifyAndProbeMock.mockClear();
    createAdapterMock.mockClear();
    resolveOpenSearchConfigMock.mockClear();
    chatParamsRow = {
      brand: null,
      dateStart: null,
      dateEnd: null,
      competitors: [],
      intention: null,
      enrichmentType: null,
      mediaTypes: [],
      dataSource: 'opensearch',
      uploadId: null,
    };
  });

  afterEach(() => {
    delete process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT;
  });

  function lowConfidenceIntent(): Intent {
    return {
      brand: null,
      dateStart: null,
      dateEnd: null,
      competitors: [],
      intention: null,
      enrichmentType: null,
      mediaTypes: [],
      dataSource: null,
      confidence: {
        brand: 0.3,
        dateRange: 0,
        competitors: 0,
        intention: 0,
        enrichmentType: 0,
        mediaTypes: 0,
        dataSource: 0,
      },
    };
  }

  it('flag OFF (default) → classifier is NOT called even when brand confidence is low', async () => {
    // Explicitly unset just to be sure.
    delete process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT;
    const out = await applyIntentToChatParams(USER_A, CHAT_A, lowConfidenceIntent());
    expect(classifyAndProbeMock).not.toHaveBeenCalled();
    expect(out.supplementedFromSample).toBeUndefined();
    expect(out.probes).toBeUndefined();
  });

  it('flag ON + brand confidence 0.3 + source attached → classifier supplements brand', async () => {
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT = 'true';
    const out = await applyIntentToChatParams(USER_A, CHAT_A, lowConfidenceIntent());
    expect(classifyAndProbeMock).toHaveBeenCalledTimes(1);
    expect(out.supplementedFromSample).toContain('brand');
    expect(out.probes).toBeDefined();
    // patchParams called by the supplement path with brand: 'FreshSip'.
    const brandWrite = patchParamsMock.mock.calls.find(
      (c) => (c[2] as { brand?: string }).brand === 'FreshSip',
    );
    expect(brandWrite).toBeDefined();
  });

  it('flag ON + classifier confidence below 0.6 floor → no supplement applied', async () => {
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT = 'true';
    classifyAndProbeMock.mockResolvedValueOnce({
      inferred: { brand: 'WeakGuess' },
      confidence: { brand: 0.55 }, // below SUPPLEMENT_INFERRED_CONFIDENCE_FLOOR
      probes: [],
      rationale: '',
      perSourceStats: [],
    });
    const out = await applyIntentToChatParams(USER_A, CHAT_A, lowConfidenceIntent());
    expect(classifyAndProbeMock).toHaveBeenCalled();
    expect(out.supplementedFromSample).toEqual([]);
    // No brand write because we declined to apply the weak inference.
    const brandWrites = patchParamsMock.mock.calls.filter(
      (c) => (c[2] as { brand?: string }).brand === 'WeakGuess',
    );
    expect(brandWrites).toHaveLength(0);
  });

  it('flag ON + no source attached (csv with no uploadId) → no supplement', async () => {
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT = 'true';
    chatParamsRow = {
      ...(chatParamsRow ?? {}),
      dataSource: 'csv_upload',
      uploadId: null,
    };
    const out = await applyIntentToChatParams(USER_A, CHAT_A, lowConfidenceIntent());
    // Classifier never called because no adapter sample is available.
    expect(classifyAndProbeMock).not.toHaveBeenCalled();
    expect(out.supplementedFromSample).toBeUndefined();
  });

  it('flag ON + high-confidence brand → no supplement (LLM result trusted)', async () => {
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT = 'true';
    const intent = lowConfidenceIntent();
    intent.brand = 'HighConfBrand';
    intent.confidence.brand = 0.9;
    await applyIntentToChatParams(USER_A, CHAT_A, intent);
    expect(classifyAndProbeMock).not.toHaveBeenCalled();
  });

  it('flag ON + LLM left brand null AND classifier fails → no error, no supplement', async () => {
    process.env.ENABLE_SAMPLE_CLASSIFIER_SUPPLEMENT = 'true';
    classifyAndProbeMock.mockRejectedValueOnce(new Error('boom'));
    const out = await applyIntentToChatParams(USER_A, CHAT_A, lowConfidenceIntent());
    // Best-effort — failure is swallowed.
    expect(out.appliedFields).toEqual([]);
    expect(out.supplementedFromSample).toBeUndefined();
  });
});
