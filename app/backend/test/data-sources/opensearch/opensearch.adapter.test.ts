/**
 * M9.6a — OpenSearchAdapter unit tests.
 *
 * Mocks `lib/opensearch-client.search`, `lib/opensearch-indices.resolveIndices`,
 * and `lib/opensearch-dsl.buildOpenSearchDsl`. Drives the adapter end-to-end
 * without touching a real cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Programmable mock state ─────────────────────────────────────────────
type Hit = { _id: string; _source: Record<string, unknown>; sort?: unknown[] };
let scriptedPages: Hit[][] = [];
let scriptedTotalHits = 0;
let scriptedRetries = 0;
let scriptedError: Error | null = null;

// env stub — adapter reads OPENSEARCH_MAX_PAGES + OPENSEARCH_PAGE_SIZE
let envMaxPages = 3;
let envPageSize = 500;
vi.mock('../../../src/env.js', () => ({
  hasOpenSearchConfig: vi.fn(() => true),
  loadEnv: vi.fn(() => ({
    OPENSEARCH_MAX_PAGES: envMaxPages,
    OPENSEARCH_PAGE_SIZE: envPageSize,
    OPENSEARCH_FIELDS_FOR_QUERY: 'title,content,description,summary',
    OPENSEARCH_TIMEOUT_MS: 30_000,
  })),
}));

const resolveIndicesMock = vi.fn((_input: unknown) => [
  'amx-data-2026-05-01*',
  'amx-print*',
]);
vi.mock('../../../src/lib/opensearch-indices.js', () => ({
  resolveIndices: resolveIndicesMock,
}));

vi.mock('../../../src/lib/opensearch-dsl.js', () => ({
  buildOpenSearchDsl: vi.fn(
    (_s: unknown, opts?: { searchAfter?: unknown[] }) => ({
      query: { match_all: {} },
      sort: [{ pubDate: 'desc' }, { _id: 'desc' }],
      size: envPageSize,
      _source: true,
      ...(opts?.searchAfter ? { search_after: opts.searchAfter } : {}),
    }),
  ),
}));

const searchMock = vi.fn(async (_opts: unknown) => {
  if (scriptedError) throw scriptedError;
  const page = scriptedPages.shift() ?? [];
  return {
    hits: page,
    totalHits: scriptedTotalHits,
    retriesUsed: scriptedRetries,
    latencyMs: 5,
    raw: {},
  };
});
vi.mock('../../../src/lib/opensearch-client.js', () => ({
  search: searchMock,
}));

const { OpenSearchAdapter } = await import(
  '../../../src/data-sources/opensearch/opensearch.adapter.js'
);

const VALID_CONFIG = {
  url: 'https://os.example.com',
  username: 'u',
  password: 'p',
  indexName: 'amx-data*',
  indexType: 'daywise' as const,
};

function makeHit(id: string, opts?: { reach?: number | null }): Hit {
  return {
    _id: id,
    _source: {
      title: `Article ${id}`,
      content: `body ${id}`,
      pubDate: '2026-05-10',
      ...(opts?.reach !== undefined ? { reach: opts.reach } : {}),
    },
    sort: [`2026-05-10`, id],
  };
}

function fullPage(n: number, prefix = 'os', opts?: { reach?: number | null }): Hit[] {
  return Array.from({ length: n }, (_, i) => makeHit(`${prefix}-${i}`, opts));
}

const STRUCTURED = {
  brand: 'FreshSip',
  brandFields: ['title'],
  competitors: ['PepsiCo'],
  competitorFields: ['content'],
  dateRange: { start: '2026-05-01', end: '2026-05-20' },
  language: 'en',
};

beforeEach(() => {
  scriptedPages = [];
  scriptedTotalHits = 0;
  scriptedRetries = 0;
  scriptedError = null;
  envMaxPages = 3;
  envPageSize = 500;
  searchMock.mockClear();
  resolveIndicesMock.mockClear();
});

async function consume(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const b of it) out.push(b);
  return out;
}

describe('OpenSearchAdapter — construction', () => {
  it('rejects invalid config (missing url)', () => {
    expect(
      () => new OpenSearchAdapter({ username: 'u', password: 'p' }),
    ).toThrow(/config invalid/);
  });

  it('kind === "opensearch"', () => {
    const a = new OpenSearchAdapter(VALID_CONFIG);
    expect(a.kind).toBe('opensearch');
  });

  it('declaredCapabilities returns all 7 fields', () => {
    const a = new OpenSearchAdapter(VALID_CONFIG);
    const caps = a.declaredCapabilities();
    expect(Object.keys(caps).sort()).toEqual([
      'hasArticleSentiment',
      'hasAuthor',
      'hasCountry',
      'hasEngagement',
      'hasEntities',
      'hasReach',
      'hasThemes',
    ]);
  });

  it('meta() returns plausible defaults before fetch()', () => {
    const a = new OpenSearchAdapter(VALID_CONFIG);
    const m = a.meta();
    expect(m.totalHits).toBeNull();
    expect(m.retriesUsed).toBe(0);
    expect(m.latencyMsTotal).toBe(0);
    expect(m.indicesQueried).toEqual([]);
  });
});

describe('OpenSearchAdapter — fetch()', () => {
  it('3-page fetch with search_after threading', async () => {
    envMaxPages = 3;
    envPageSize = 500;
    scriptedTotalHits = 1500;
    scriptedPages = [
      fullPage(500, 'p1', { reach: 1000 }),
      fullPage(500, 'p2', { reach: 1000 }),
      fullPage(500, 'p3', { reach: 1000 }),
    ];

    const a = new OpenSearchAdapter(VALID_CONFIG);
    const batches = (await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: { sourceArticleId: string }[]; progress: { page: number; isLastPage: boolean; cumulativeArticles: number } }>;

    expect(batches).toHaveLength(3);
    expect(batches[0]!.articles).toHaveLength(500);
    expect(batches[0]!.progress.page).toBe(1);
    expect(batches[0]!.progress.cumulativeArticles).toBe(500);
    expect(batches[2]!.progress.isLastPage).toBe(true);

    // searchMock called 3x with progressive search_after.
    expect(searchMock).toHaveBeenCalledTimes(3);
    const calls = searchMock.mock.calls;
    expect(((calls[0]![0] as { body: { search_after?: unknown } }).body.search_after)).toBeUndefined();
    expect((calls[1]![0] as { body: { search_after: unknown[] } }).body.search_after).toEqual([
      '2026-05-10',
      'p1-499',
    ]);
  });

  it('uses resolveIndices result', async () => {
    scriptedPages = [[]];
    const a = new OpenSearchAdapter(VALID_CONFIG);
    await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    );
    expect(resolveIndicesMock).toHaveBeenCalledTimes(1);
    const callArg = searchMock.mock.calls[0]![0] as { indices: string[] };
    expect(callArg.indices).toEqual(['amx-data-2026-05-01*', 'amx-print*']);
  });

  it('mediaTypes empty → resolveIndices called with mediaTypes:null', async () => {
    scriptedPages = [[]];
    const a = new OpenSearchAdapter(VALID_CONFIG);
    await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    );
    const arg = resolveIndicesMock.mock.calls[0]![0] as {
      mediaTypes: unknown;
    };
    expect(arg.mediaTypes).toBeNull();
  });

  it('mediaTypes ["x_twitter"] → resolveIndices receives that list', async () => {
    scriptedPages = [[]];
    const a = new OpenSearchAdapter(VALID_CONFIG);
    await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: ['x_twitter'],
      }),
    );
    const arg = resolveIndicesMock.mock.calls[0]![0] as { mediaTypes: string[] };
    expect(arg.mediaTypes).toEqual(['x_twitter']);
  });

  it('reach absent in raw → NormalizedArticle.reach === null', async () => {
    scriptedTotalHits = 1;
    scriptedPages = [[makeHit('h1')]]; // no `reach` field
    const a = new OpenSearchAdapter(VALID_CONFIG);
    const [batch] = (await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: Array<{ reach: number | null; sourceKind: string }> }>;
    expect(batch!.articles[0]!.reach).toBeNull();
    expect(batch!.articles[0]!.sourceKind).toBe('opensearch');
  });

  it('reach present numeric → NormalizedArticle.reach reflects value', async () => {
    scriptedTotalHits = 1;
    scriptedPages = [[makeHit('h1', { reach: 12345 })]];
    const a = new OpenSearchAdapter(VALID_CONFIG);
    const [batch] = (await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: Array<{ reach: number | null }> }>;
    expect(batch!.articles[0]!.reach).toBe(12345);
  });

  it('search() throws → adapter re-throws and meta() reflects state', async () => {
    scriptedError = new Error('Invalid OpenSearch query syntax or parameters.');
    const a = new OpenSearchAdapter(VALID_CONFIG);
    await expect(
      consume(
        a.fetch({
          userId: 'u1',
          chatId: 'c1',
          config: null,
          structured: STRUCTURED,
          mediaTypes: [],
        }),
      ),
    ).rejects.toThrow(/Invalid OpenSearch/);
    // meta() still reflects the indices we tried to query + zero total
    // (we threw before the first response landed).
    const m = a.meta();
    expect(m.indicesQueried).toEqual(['amx-data-2026-05-01*', 'amx-print*']);
    expect(m.totalHits).toBeNull();
  });

  it('AbortSignal mid-iteration stops further pages', async () => {
    envMaxPages = 5;
    envPageSize = 500;
    scriptedTotalHits = 2500;
    scriptedPages = [
      fullPage(500, 'p1'),
      fullPage(500, 'p2'),
      fullPage(500, 'p3'),
      fullPage(500, 'p4'),
      fullPage(500, 'p5'),
    ];

    const ctrl = new AbortController();
    const a = new OpenSearchAdapter(VALID_CONFIG);
    const it = a.fetch({
      userId: 'u1',
      chatId: 'c1',
      config: null,
      structured: STRUCTURED,
      mediaTypes: [],
      signal: ctrl.signal,
    });

    const collected: unknown[] = [];
    for await (const b of it) {
      collected.push(b);
      if (collected.length === 2) ctrl.abort();
    }
    expect(collected.length).toBe(2);
    expect(searchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('totalHits and retriesUsed update on meta() AFTER iteration', async () => {
    scriptedTotalHits = 500;
    scriptedRetries = 1;
    scriptedPages = [fullPage(500, 'p1'), []]; // small page then empty terminal

    const a = new OpenSearchAdapter(VALID_CONFIG);
    await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    );
    const m = a.meta();
    expect(m.totalHits).toBe(500);
    // 2 calls × 1 retry each = 2 (both pages used retries in this mock).
    expect(m.retriesUsed).toBeGreaterThanOrEqual(1);
    expect(m.latencyMsTotal).toBeGreaterThanOrEqual(0);
  });

  it('passes per-config to search() so client cache routes per-user', async () => {
    scriptedPages = [[]];
    const a = new OpenSearchAdapter(VALID_CONFIG);
    await consume(
      a.fetch({
        userId: 'u1',
        chatId: 'c1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    );
    const arg = searchMock.mock.calls[0]![0] as {
      config?: { url: string; username: string; password: string };
    };
    expect(arg.config).toEqual({
      url: 'https://os.example.com',
      username: 'u',
      password: 'p',
    });
  });
});
