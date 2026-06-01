/**
 * Phase 3.5 (M9.5) — Chunked bulk insert into the articles table for the
 * OpenSearch fetch path.
 *
 * Mirrors the CSV path's BATCH_SIZE=500 chunking pattern (see
 * `workers/parse-upload.worker.ts`). Each chunk is one `createMany` call
 * with `skipDuplicates: true`, leveraging the partial UNIQUE index on
 * `(chat_id, open_search_id)` added by M9.5's migration.
 *
 * The per-call RLS context (`withUser`) is supplied by the caller via a
 * transaction handle. That keeps this service composable: SearchAgent
 * controls the outer transaction lifetime so a failure mid-fetch leaves
 * partial pages intact (Phase 3.5 spec: zero hits is a valid state, so
 * is "first 3 pages succeeded then OpenSearch returned a 500").
 *
 * @file services/article-bulk-insert.service.ts
 */
import type { Prisma, PrismaClient } from '@prsi/shared/db';
import type { NormalizedArticleFields } from '../lib/opensearch-mapping.js';

/**
 * Each row carries the canonical fields plus `openSearchId` (the
 * cluster's `_id`) and the full `rawData`. The mapping layer
 * (`mapHitToArticle`) returns exactly this shape — we extend it with the
 * chat-scoping ids the table requires.
 */
export type ArticleRowForInsert = NormalizedArticleFields & {
  openSearchId: string;
  rawData: Prisma.InputJsonValue;
};

export interface BulkInsertOptions {
  chatId: string;
  userId: string;
  /** Articles already mapped to the canonical Article shape. */
  articles: ReadonlyArray<ArticleRowForInsert>;
  /** Override the default 500-row chunk size (test fixtures use smaller). */
  batchSize?: number;
}

export interface BulkInsertResult {
  /** Sum of `createMany.count` across all chunks. With skipDuplicates this
   *  may be less than `articles.length` when a re-run hits the unique
   *  index on (chat_id, open_search_id). */
  inserted: number;
  /** Number of createMany calls actually executed (= ceil(N / batchSize)). */
  batches: number;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Bulk-insert OpenSearch-sourced articles inside the caller's transaction.
 * The caller MUST have already wrapped this call in `withUser(userId, …)`
 * so RLS scopes the writes; we expect to receive the transaction client
 * directly (matches the M7.4 parse-upload pattern).
 *
 * `published_date` is stored as DATE (no time component), matching the
 * existing schema; we slice the ISO string at the day boundary.
 */
export async function bulkInsertArticles(
  tx: PrismaClient | Prisma.TransactionClient,
  opts: BulkInsertOptions,
): Promise<BulkInsertResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize <= 0) throw new Error('batchSize must be > 0');

  let inserted = 0;
  let batches = 0;

  for (let i = 0; i < opts.articles.length; i += batchSize) {
    const slice = opts.articles.slice(i, i + batchSize);
    const result = await tx.article.createMany({
      data: slice.map((a) => ({
        chatId: opts.chatId,
        userId: opts.userId,
        // uploadId stays NULL for OpenSearch articles — Phase 3.5 spec.
        uploadId: null,
        title: a.title,
        content: a.content,
        description: a.description,
        source: a.source,
        author: a.author,
        publishedDate: a.publishedDate,
        url: a.url,
        publisherDomain: a.publisherDomain,
        language: a.language,
        rawData: a.rawData,
        openSearchId: a.openSearchId,
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
    batches += 1;
  }

  return { inserted, batches };
}
