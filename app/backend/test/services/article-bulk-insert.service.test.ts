/**
 * M9.5 — article-bulk-insert service unit tests.
 *
 * Pure-unit suite: Prisma's `tx.article.createMany` is mocked and we
 * assert the chunking behavior + payload shape. No DB / RLS layer is
 * exercised; the caller's responsibility for `withUser` is documented in
 * the service file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bulkInsertArticles, type ArticleRowForInsert } from '../../src/services/article-bulk-insert.service.js';

function mockArticle(i: number): ArticleRowForInsert {
  return {
    title: `Article ${i}`,
    content: `content ${i}`,
    description: null,
    source: null,
    author: null,
    publishedDate: new Date('2026-05-10'),
    url: `https://example.com/${i}`,
    publisherDomain: 'example.com',
    language: 'en',
    country: null,
    reach: null,
    sources: null,
    openSearchId: `os-${i}`,
    rawData: { _id: `os-${i}` },
  };
}

interface CreateManyCall {
  data: Array<{
    chatId: string;
    userId: string;
    uploadId: string | null;
    openSearchId: string | null;
    rawData: unknown;
  }>;
  skipDuplicates: boolean;
}

function makeTx(perCallCount: number[]) {
  let call = 0;
  const createMany = vi.fn(async (_args: CreateManyCall) => {
    const count = perCallCount[call++] ?? 0;
    return { count };
  });
  const tx = { article: { createMany } };
  return { tx, createMany };
}

describe('bulkInsertArticles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chunks at the 500-row boundary by default', async () => {
    const articles = Array.from({ length: 1234 }, (_, i) => mockArticle(i));
    const { tx, createMany } = makeTx([500, 500, 234]);
    const result = await bulkInsertArticles(tx as never, {
      chatId: 'chat-1',
      userId: 'user-1',
      articles,
    });
    expect(createMany).toHaveBeenCalledTimes(3);
    expect(result.batches).toBe(3);
    expect(result.inserted).toBe(1234);
    const calls = createMany.mock.calls as Array<[CreateManyCall]>;
    // First chunk = 500 rows.
    expect(calls[0]![0].data).toHaveLength(500);
    expect(calls[1]![0].data).toHaveLength(500);
    expect(calls[2]![0].data).toHaveLength(234);
  });

  it('respects a custom batchSize override', async () => {
    const articles = Array.from({ length: 7 }, (_, i) => mockArticle(i));
    const { tx, createMany } = makeTx([3, 3, 1]);
    await bulkInsertArticles(tx as never, {
      chatId: 'chat-1',
      userId: 'user-1',
      articles,
      batchSize: 3,
    });
    expect(createMany).toHaveBeenCalledTimes(3);
  });

  it('always sets skipDuplicates=true on every createMany call', async () => {
    const articles = Array.from({ length: 10 }, (_, i) => mockArticle(i));
    const { tx, createMany } = makeTx([10]);
    await bulkInsertArticles(tx as never, {
      chatId: 'c',
      userId: 'u',
      articles,
      batchSize: 100,
    });
    const calls = createMany.mock.calls as Array<[CreateManyCall]>;
    expect(calls[0]![0].skipDuplicates).toBe(true);
  });

  it('preserves openSearchId + rawData + sets uploadId=null', async () => {
    const articles = [mockArticle(0)];
    const { tx, createMany } = makeTx([1]);
    await bulkInsertArticles(tx as never, {
      chatId: 'chat-1',
      userId: 'user-1',
      articles,
    });
    const calls = createMany.mock.calls as Array<[CreateManyCall]>;
    const row = calls[0]![0].data[0]!;
    expect(row.openSearchId).toBe('os-0');
    expect(row.uploadId).toBeNull();
    expect(row.rawData).toEqual({ _id: 'os-0' });
    expect(row.chatId).toBe('chat-1');
    expect(row.userId).toBe('user-1');
  });
});
