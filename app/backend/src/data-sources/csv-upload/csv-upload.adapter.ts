/**
 * CsvUploadAdapter — implements `DataSourceAdapter` for user-uploaded
 * CSV / JSON files.
 *
 * In the M7.4-shipped CSV path, articles are streamed + normalized +
 * bulk-inserted into the `articles` table by `parse-upload.worker.ts`
 * BEFORE DataExtractAgent ever runs. DataExtractAgent's job is the
 * 7-step verification pipeline + handoff. The adapter therefore reads
 * the already-normalized rows out of `articles` and yields them as
 * canonical `NormalizedArticle` batches.
 *
 * This preserves observable behavior for M7.7 callers while exposing a
 * uniform adapter surface that future M9.11 multi-source orchestration
 * can iterate alongside OpenSearch / Crawler / RSS adapters.
 *
 * Per ADR-0001:
 *   - Adapter produces canonical `NormalizedArticle` directly.
 *   - Stamps `sourceKind='csv_upload'` on every yielded article.
 *   - Honors `ctx.signal` for cancellation.
 *   - Updates `meta()` as iteration proceeds.
 *
 * @file backend/src/data-sources/csv-upload/csv-upload.adapter.ts
 */
import { z } from 'zod';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../../lib/prisma-rls.js';
import type {
  AdapterMeta,
  DataSourceAdapter,
  DataSourceKind,
  DeclaredCapabilities,
  FetchContext,
  NormalizedArticle,
  NormalizedArticleBatch,
} from '../adapter.js';

/**
 * Per-batch chunk size. Matches the M7.4 parse-upload `BATCH_SIZE=500`
 * so downstream bulk-insert costs stay aligned across the two paths.
 */
export const CSV_BATCH_SIZE = 500;

/**
 * Config the adapter accepts on construction. The CSV path needs the
 * upload id so it can scope the row read; `userId` arrives via the
 * fetch context so RLS scoping uses the live request user.
 */
export const CsvUploadConfigSchema = z.object({
  uploadId: z.string().uuid(),
});
export type CsvUploadConfig = z.infer<typeof CsvUploadConfigSchema>;

/**
 * Capability matrix for the CSV path. Most user uploads carry author /
 * byline columns and minimal else — analysts hand-curate CSVs of
 * articles they've already gathered. Reach, sentiment, entities, etc.
 * are rare in raw uploads.
 */
const CSV_CAPABILITIES: DeclaredCapabilities = {
  hasReach: 'rarely',
  hasArticleSentiment: 'rarely',
  hasEntities: 'rarely',
  hasThemes: 'never',
  hasEngagement: 'rarely',
  hasCountry: 'rarely',
  hasAuthor: 'usually',
};

export class CsvUploadAdapter implements DataSourceAdapter {
  readonly kind: DataSourceKind = 'csv_upload';

  private readonly config: CsvUploadConfig;
  private _meta: AdapterMeta = {
    totalHits: null,
    retriesUsed: 0,
    latencyMsTotal: 0,
  };

  constructor(config: unknown) {
    const parsed = CsvUploadConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        `CsvUploadAdapter config invalid: ${parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      );
    }
    this.config = parsed.data;
  }

  declaredCapabilities(): DeclaredCapabilities {
    return { ...CSV_CAPABILITIES };
  }

  meta(): AdapterMeta {
    return {
      totalHits: this._meta.totalHits,
      retriesUsed: this._meta.retriesUsed,
      latencyMsTotal: this._meta.latencyMsTotal,
    };
  }

  /**
   * Yield already-normalized CSV rows from the `articles` table in
   * `CSV_BATCH_SIZE` chunks. Articles are scoped by `(chatId, uploadId)`
   * so a re-run on the same chat sees its own rows.
   *
   * `ctx.sampleLimit` (M9.6b) — when set, yields AT MOST `sampleLimit`
   * articles in a SINGLE batch then returns. Used by SampleClassifier
   * to pull ~25 rows without a full pagination loop.
   */
  async *fetch(ctx: FetchContext): AsyncIterable<NormalizedArticleBatch> {
    const t0 = Date.now();
    // Per-call effective batch size. `sampleLimit` caps both the LIMIT
    // clause and the total — one batch, then stop.
    const sampleMode = typeof ctx.sampleLimit === 'number' && ctx.sampleLimit > 0;
    const batchSize = sampleMode ? Math.min(CSV_BATCH_SIZE, ctx.sampleLimit!) : CSV_BATCH_SIZE;

    try {
      // Single-pass count for `meta().totalHits` so callers can plan
      // batch sizing the same way the OS path does.
      const total = await withUser(ctx.userId, async (tx) =>
        tx.article.count({
          where: { chatId: ctx.chatId, uploadId: this.config.uploadId },
        }),
      );
      this._meta.totalHits = total;

      if (total === 0) {
        yield {
          articles: [],
          progress: { page: 1, cumulativeArticles: 0, isLastPage: true },
        };
        return;
      }

      let page = 0;
      let cumulative = 0;
      const effectiveTotal = sampleMode ? Math.min(total, ctx.sampleLimit!) : total;
      const totalPages = Math.ceil(effectiveTotal / batchSize);

      while (cumulative < effectiveTotal) {
        if (ctx.signal?.aborted) return;

        page += 1;
        const rows = await withUser(ctx.userId, async (tx) =>
          tx.article.findMany({
            where: {
              chatId: ctx.chatId,
              uploadId: this.config.uploadId,
            },
            orderBy: { createdAt: 'asc' },
            skip: cumulative,
            take: batchSize,
          }),
        );

        if (rows.length === 0) break;

        const articles: NormalizedArticle[] = rows.map((r) => ({
          sourceArticleId: r.id,
          title: r.title,
          content: r.content,
          description: r.description,
          source: r.source,
          author: r.author,
          publishedDate: r.publishedDate ?? null,
          url: r.url,
          publisherDomain: r.publisherDomain,
          language: r.language ?? 'en',
          // CSV path's M7.4 normalizer doesn't extract country / reach /
          // nested sources, so they're always null here. The bare row
          // shape declares them as optional in case a future migration
          // adds them to `articles`.
          country: null,
          reach: null,
          sources: r.publisherDomain
            ? { domain: r.publisherDomain, name: r.source ?? null }
            : null,
          rawData: (r.rawData ?? {}) as Prisma.InputJsonValue,
          sourceKind: 'csv_upload',
        }));

        cumulative += articles.length;
        // In sample mode the effectiveTotal cap is the LIMIT — one batch
        // satisfies the cap unconditionally. In normal mode we just check
        // against the real total.
        const isLastPage =
          cumulative >= effectiveTotal || page >= totalPages || sampleMode;

        yield {
          articles,
          progress: {
            page,
            cumulativeArticles: cumulative,
            isLastPage,
          },
        };

        if (isLastPage) break;
      }
    } finally {
      this._meta.latencyMsTotal = Date.now() - t0;
    }
  }
}
