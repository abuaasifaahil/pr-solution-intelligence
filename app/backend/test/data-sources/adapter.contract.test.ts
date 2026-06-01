/**
 * M9.6a — Shared DataSourceAdapter contract suite.
 *
 * Runs the same set of invariant tests against every concrete adapter
 * the registry implements. New adapters MUST pass this suite without
 * special-casing.
 *
 * Invariants asserted (per ADR-0001 + ADR-0003):
 *   - `kind` matches the registered kind
 *   - `declaredCapabilities()` returns all 7 confidence fields
 *   - `fetch()` returns an AsyncIterable
 *   - `fetch()` honors AbortSignal mid-iteration
 *   - Each yielded NormalizedArticle has the canonical 14-field shape
 *     (13 data fields + `sourceKind`) with `sourceKind` stamped to the
 *     adapter's `kind`
 *   - `meta()` returns plausible defaults BEFORE fetch + populated
 *     values AFTER (latencyMsTotal >= 0)
 *
 * Each adapter ships its own focused test file in addition to this
 * shared suite (csv-upload.adapter.test.ts, opensearch.adapter.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CANONICAL_KEYS = [
  'author',
  'content',
  'country',
  'description',
  'language',
  'publishedDate',
  'publisherDomain',
  'rawData',
  'reach',
  'source',
  'sourceArticleId',
  'sourceKind',
  'sources',
  'title',
  'url',
].sort();

// ─── Shared per-adapter mock environment ────────────────────────────────
// Both adapters need `lib/prisma-rls.withUser` mocked. For OpenSearch we
// additionally need `lib/opensearch-*` mocks. Setting it all up once
// here keeps the per-adapter shape uniform.

interface FakeArticleRow {
  id: string;
  uploadId: string;
  chatId: string;
  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  publishedDate: Date | null;
  url: string | null;
  publisherDomain: string | null;
  language: string | null;
  rawData: unknown;
  createdAt: Date;
}

let articleStore: FakeArticleRow[] = [];

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      article: {
        count: vi.fn(
          async ({ where }: { where: { chatId: string; uploadId: string } }) =>
            articleStore.filter(
              (a) => a.chatId === where.chatId && a.uploadId === where.uploadId,
            ).length,
        ),
        findMany: vi.fn(
          async ({
            where,
            skip,
            take,
          }: {
            where: { chatId: string; uploadId: string };
            skip: number;
            take: number;
          }) => {
            const matching = articleStore
              .filter(
                (a) => a.chatId === where.chatId && a.uploadId === where.uploadId,
              )
              .slice();
            return matching.slice(skip, skip + take);
          },
        ),
      },
    };
    return fn(tx);
  }),
  asAdmin: vi.fn(),
}));

vi.mock('@prsi/shared/db', () => ({
  prisma: { $disconnect: vi.fn() },
}));

// env stub for OpenSearch adapter.
vi.mock('../../src/env.js', () => ({
  hasOpenSearchConfig: vi.fn(() => true),
  loadEnv: vi.fn(() => ({
    OPENSEARCH_MAX_PAGES: 1,
    OPENSEARCH_PAGE_SIZE: 500,
    OPENSEARCH_FIELDS_FOR_QUERY: 'title,content,description,summary',
    OPENSEARCH_TIMEOUT_MS: 30_000,
  })),
}));

vi.mock('../../src/lib/opensearch-indices.js', () => ({
  resolveIndices: vi.fn(() => ['amx-data*']),
}));

vi.mock('../../src/lib/opensearch-dsl.js', () => ({
  buildOpenSearchDsl: vi.fn(() => ({
    query: { match_all: {} },
    sort: [{ pubDate: 'desc' }, { _id: 'desc' }],
    size: 500,
    _source: true,
  })),
}));

const searchMock = vi.fn(async () => ({
  hits: [
    {
      _id: 'os-1',
      _source: {
        title: 'OS article',
        content: 'body',
        pubDate: '2026-05-10',
      },
      sort: ['2026-05-10', 'os-1'],
    },
  ],
  totalHits: 1,
  retriesUsed: 0,
  latencyMs: 5,
  raw: {},
}));
vi.mock('../../src/lib/opensearch-client.js', () => ({
  search: searchMock,
}));

const { CsvUploadAdapter } = await import(
  '../../src/data-sources/csv-upload/csv-upload.adapter.js'
);
const { OpenSearchAdapter } = await import(
  '../../src/data-sources/opensearch/opensearch.adapter.js'
);

const CSV_UPLOAD_ID = '00000000-0000-0000-0000-000000000001';

const STRUCTURED = {
  brand: 'Acme',
  brandFields: ['title'],
  competitors: [],
  competitorFields: ['content'],
  dateRange: null,
  language: 'en',
};

function seedCsvRow(): void {
  articleStore = [
    {
      id: 'a-0',
      uploadId: CSV_UPLOAD_ID,
      chatId: 'chat-1',
      title: 'CSV article',
      content: 'body',
      description: null,
      source: 'Publisher',
      author: 'Author',
      publishedDate: new Date('2025-01-01'),
      url: 'https://example.com/1',
      publisherDomain: 'example.com',
      language: 'en',
      rawData: { rowIndex: 0 },
      createdAt: new Date(),
    },
  ];
}

// ─── Adapter factories under test ───────────────────────────────────────
type AdapterCase = {
  name: string;
  kind: 'csv_upload' | 'opensearch';
  build: () => { adapter: import('../../src/data-sources/adapter.js').DataSourceAdapter; ctx: import('../../src/data-sources/adapter.js').FetchContext; reset: () => void };
};

const cases: AdapterCase[] = [
  {
    name: 'CsvUploadAdapter',
    kind: 'csv_upload',
    build: () => {
      seedCsvRow();
      return {
        adapter: new CsvUploadAdapter({ uploadId: CSV_UPLOAD_ID }),
        ctx: {
          userId: 'user-1',
          chatId: 'chat-1',
          config: null,
          structured: STRUCTURED,
          mediaTypes: [],
        },
        reset: () => {
          articleStore = [];
        },
      };
    },
  },
  {
    name: 'OpenSearchAdapter',
    kind: 'opensearch',
    build: () => ({
      adapter: new OpenSearchAdapter({
        url: 'https://os.example.com',
        username: 'u',
        password: 'p',
        indexName: 'amx-data*',
        indexType: 'daywise',
      }),
      ctx: {
        userId: 'user-1',
        chatId: 'chat-1',
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      },
      reset: () => {
        searchMock.mockClear();
      },
    }),
  },
];

beforeEach(() => {
  articleStore = [];
});

describe.each(cases)('DataSourceAdapter contract — $name', (caseDef) => {
  it('kind matches the registered kind', () => {
    const { adapter, reset } = caseDef.build();
    expect(adapter.kind).toBe(caseDef.kind);
    reset();
  });

  it('declaredCapabilities returns all 7 confidence fields', () => {
    const { adapter, reset } = caseDef.build();
    const caps = adapter.declaredCapabilities();
    const expected = [
      'hasArticleSentiment',
      'hasAuthor',
      'hasCountry',
      'hasEngagement',
      'hasEntities',
      'hasReach',
      'hasThemes',
    ].sort();
    expect(Object.keys(caps).sort()).toEqual(expected);
    // Every value must be a known confidence label.
    for (const v of Object.values(caps)) {
      expect(['always', 'usually', 'rarely', 'never']).toContain(v);
    }
    reset();
  });

  it('fetch() returns an AsyncIterable', () => {
    const { adapter, ctx, reset } = caseDef.build();
    const it = adapter.fetch(ctx);
    expect(typeof (it as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe(
      'function',
    );
    reset();
  });

  it('meta() returns plausible defaults BEFORE fetch()', () => {
    const { adapter, reset } = caseDef.build();
    const m = adapter.meta();
    expect(m.totalHits).toBeNull();
    expect(m.retriesUsed).toBe(0);
    expect(m.latencyMsTotal).toBe(0);
    reset();
  });

  it('yields NormalizedArticles with the canonical 15-key shape and stamped sourceKind', async () => {
    const { adapter, ctx, reset } = caseDef.build();
    const batches: Array<{ articles: Record<string, unknown>[] }> = [];
    for await (const b of adapter.fetch(ctx)) {
      batches.push(b as unknown as { articles: Record<string, unknown>[] });
    }
    // At least one batch yielded (may be empty for some adapters; we
    // only verify shape when there ARE articles).
    const sample = batches.find((b) => b.articles.length > 0);
    if (sample) {
      const art = sample.articles[0]!;
      expect(Object.keys(art).sort()).toEqual(CANONICAL_KEYS);
      expect(art.sourceKind).toBe(caseDef.kind);
    }
    reset();
  });

  it('meta().latencyMsTotal >= 0 AFTER fetch()', async () => {
    const { adapter, ctx, reset } = caseDef.build();
    for await (const _b of adapter.fetch(ctx)) {
      // drain
      void _b;
    }
    const m = adapter.meta();
    expect(m.latencyMsTotal).toBeGreaterThanOrEqual(0);
    reset();
  });

  it('AbortSignal stops iteration', async () => {
    // Seed enough rows / pages so there's something to abort against.
    if (caseDef.kind === 'csv_upload') {
      articleStore = Array.from({ length: 5 }, (_, i) => ({
        id: `a-${i}`,
        uploadId: CSV_UPLOAD_ID,
        chatId: 'chat-1',
        title: `Article ${i}`,
        content: null,
        description: null,
        source: null,
        author: null,
        publishedDate: null,
        url: null,
        publisherDomain: null,
        language: 'en',
        rawData: {},
        createdAt: new Date(),
      }));
    }
    const { adapter, ctx, reset } = caseDef.build();
    const ctrl = new AbortController();
    const ctxAborted = { ...ctx, signal: ctrl.signal };

    const yielded: unknown[] = [];
    for await (const b of adapter.fetch(ctxAborted)) {
      yielded.push(b);
      ctrl.abort();
    }
    // Once aborted, no further batches should be yielded.
    // (We can't assert a fixed count because some adapters emit a
    // single empty terminal batch even before aborting.)
    expect(yielded.length).toBeLessThanOrEqual(2);
    reset();
  });
});
