/**
 * M9.6a — CsvUploadAdapter unit tests.
 *
 * Verifies that the adapter reads the already-normalized rows from the
 * `articles` table and yields canonical `NormalizedArticle` batches.
 *
 * Mocks `withUser` to provide an in-memory `article` model. No live DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../../src/lib/prisma-rls.js', () => ({
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
              .slice()
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

const { CsvUploadAdapter, CSV_BATCH_SIZE } = await import(
  '../../../src/data-sources/csv-upload/csv-upload.adapter.js'
);

const CHAT = 'chat-1';
const UPLOAD = '00000000-0000-0000-0000-000000000001';
const USER = 'user-1';

const STRUCTURED = {
  brand: 'Acme',
  brandFields: ['title'],
  competitors: [],
  competitorFields: ['content'],
  dateRange: null,
  language: 'en',
};

function seedRows(n: number): void {
  articleStore = Array.from({ length: n }, (_, i) => ({
    id: `a-${i}`,
    uploadId: UPLOAD,
    chatId: CHAT,
    title: `Article ${i}`,
    content: `body ${i}`,
    description: null,
    source: i % 2 === 0 ? `Publisher ${i}` : null,
    author: `Author ${i}`,
    publishedDate: new Date(`2025-01-${(i % 28) + 1}`),
    url: `https://example.com/${i}`,
    publisherDomain: `pub${i % 3}.example.com`,
    language: 'en',
    rawData: { rowIndex: i, original: `data ${i}` },
    createdAt: new Date(2025, 0, 1, 0, 0, i),
  }));
}

async function consume(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const b of it) out.push(b);
  return out;
}

beforeEach(() => {
  articleStore = [];
});

describe('CsvUploadAdapter — construction', () => {
  it('rejects invalid config (no uploadId)', () => {
    expect(() => new CsvUploadAdapter({})).toThrow(/config invalid/);
  });

  it('kind === "csv_upload"', () => {
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    expect(a.kind).toBe('csv_upload');
  });

  it('declaredCapabilities returns all 7 fields', () => {
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
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
    // CSV cap matrix: author 'usually', everything else 'rarely' / 'never'.
    expect(caps.hasAuthor).toBe('usually');
    expect(caps.hasThemes).toBe('never');
  });

  it('meta() returns plausible defaults before fetch()', () => {
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const m = a.meta();
    expect(m.totalHits).toBeNull();
    expect(m.latencyMsTotal).toBe(0);
  });
});

describe('CsvUploadAdapter — fetch()', () => {
  it('100-row upload → single batch with NormalizedArticle shape', async () => {
    seedRows(100);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const batches = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: Array<{ sourceKind: string }> }>;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.articles).toHaveLength(100);
    for (const art of batches[0]!.articles) {
      expect(art.sourceKind).toBe('csv_upload');
    }
  });

  it('rawData is preserved on the yielded article', async () => {
    seedRows(1);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const [batch] = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: Array<{ rawData: { rowIndex: number; original: string } }> }>;
    expect(batch!.articles[0]!.rawData).toMatchObject({
      rowIndex: 0,
      original: 'data 0',
    });
  });

  it('articles have the canonical 13-field NormalizedArticle shape', async () => {
    seedRows(1);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const [batch] = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: Record<string, unknown>[] }>;
    const art = batch!.articles[0]!;
    expect(Object.keys(art).sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('batch boundaries match CSV_BATCH_SIZE constant', async () => {
    // Seed 1.5 batches worth — verify 2 batches, sizes 500 + half.
    seedRows(CSV_BATCH_SIZE + 50);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const batches = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: unknown[]; progress: { page: number; isLastPage: boolean; cumulativeArticles: number } }>;
    expect(batches.length).toBe(2);
    expect(batches[0]!.articles).toHaveLength(CSV_BATCH_SIZE);
    expect(batches[0]!.progress.isLastPage).toBe(false);
    expect(batches[1]!.articles).toHaveLength(50);
    expect(batches[1]!.progress.isLastPage).toBe(true);
  });

  it('zero rows in DB → yields ONE empty terminal batch', async () => {
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const batches = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{ articles: unknown[]; progress: { isLastPage: boolean } }>;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.articles).toHaveLength(0);
    expect(batches[0]!.progress.isLastPage).toBe(true);
  });

  it('meta().totalHits matches row count after fetch()', async () => {
    seedRows(42);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    );
    expect(a.meta().totalHits).toBe(42);
  });

  it('sources is built from publisherDomain + source when present', async () => {
    seedRows(1);
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const [batch] = (await consume(
      a.fetch({
        userId: USER,
        chatId: CHAT,
        config: null,
        structured: STRUCTURED,
        mediaTypes: [],
      }),
    )) as Array<{
      articles: Array<{
        sources: { domain: string | null; name: string | null } | null;
      }>;
    }>;
    expect(batch!.articles[0]!.sources).toEqual({
      domain: 'pub0.example.com',
      name: 'Publisher 0',
    });
  });

  it('AbortSignal mid-iteration stops further batches', async () => {
    seedRows(CSV_BATCH_SIZE * 3);
    const ctrl = new AbortController();
    const a = new CsvUploadAdapter({ uploadId: UPLOAD });
    const collected: unknown[] = [];
    for await (const b of a.fetch({
      userId: USER,
      chatId: CHAT,
      config: null,
      structured: STRUCTURED,
      mediaTypes: [],
      signal: ctrl.signal,
    })) {
      collected.push(b);
      if (collected.length === 1) ctrl.abort();
    }
    // After the first batch, the abort stops further pages.
    expect(collected.length).toBe(1);
  });
});
