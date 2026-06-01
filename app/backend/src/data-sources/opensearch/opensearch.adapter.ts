/**
 * OpenSearchAdapter — implements `DataSourceAdapter` for the AlphaMetricX
 * OpenSearch cluster (and any compatible cluster the user attaches via
 * the M5 per-user override).
 *
 * Lifts the search_after pagination loop, the DSL build, the index
 * resolve, and the `mapHitToArticle` conversion out of `SearchAgent`.
 * SearchAgent now becomes a thin lifecycle wrapper that iterates this
 * adapter's `fetch()` async iterable, bulk-inserts each batch, and emits
 * WS events — preserving every observable behavior the M9.5 tests assert.
 *
 * Per ADR-0001:
 *   - Adapter produces canonical `NormalizedArticle` directly
 *     (no per-adapter shape leaks past this boundary).
 *   - Stamps `sourceKind='opensearch'` on every yielded article.
 *   - Honors `ctx.signal` for cancellation.
 *   - Updates `meta()` as iteration proceeds (totalHits known on first
 *     page; retriesUsed + latencyMsTotal known at the end).
 *
 * @file backend/src/data-sources/opensearch/opensearch.adapter.ts
 */
import { z } from 'zod';
import type { Prisma } from '@prsi/shared/db';
import { search } from '../../lib/opensearch-client.js';
import { resolveIndices } from '../../lib/opensearch-indices.js';
import { buildOpenSearchDsl } from '../../lib/opensearch-dsl.js';
import { mapHitToArticle } from '../../lib/opensearch-mapping.js';
import { loadEnv } from '../../env.js';
import { OpenSearchAdapterConfigSchema } from './config-resolver.js';
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
 * Config the adapter accepts on construction. Resolved via
 * `resolveOpenSearchConfig()` (or supplied directly in tests).
 *
 * Tightened relative to the resolver's full schema only by allowing
 * an explicit pass-through — adapter must NOT re-resolve the config.
 */
const OpenSearchAdapterCtorConfigSchema = OpenSearchAdapterConfigSchema;

/**
 * Capability matrix for the AMX OpenSearch cluster. Mirrors the
 * introspection done during M9.4.5 — most indices carry rich pre-
 * computed signals (reach, sentiment, entities, themes), so 'usually'
 * is the right default. Some social indices skew higher on engagement.
 */
const OS_CAPABILITIES: DeclaredCapabilities = {
  hasReach: 'usually',
  hasArticleSentiment: 'usually',
  hasEntities: 'usually',
  hasThemes: 'usually',
  hasEngagement: 'usually',
  hasCountry: 'usually',
  hasAuthor: 'usually',
};

export class OpenSearchAdapter implements DataSourceAdapter {
  readonly kind: DataSourceKind = 'opensearch';

  private readonly config: z.infer<typeof OpenSearchAdapterCtorConfigSchema>;
  private _meta: AdapterMeta = {
    totalHits: null,
    retriesUsed: 0,
    latencyMsTotal: 0,
    indicesQueried: [],
  };

  constructor(config: unknown) {
    const parsed = OpenSearchAdapterCtorConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        `OpenSearchAdapter config invalid: ${parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      );
    }
    this.config = parsed.data;
  }

  declaredCapabilities(): DeclaredCapabilities {
    return { ...OS_CAPABILITIES };
  }

  meta(): AdapterMeta {
    // Return a shallow clone so callers can't mutate the live counters.
    return {
      totalHits: this._meta.totalHits,
      retriesUsed: this._meta.retriesUsed,
      latencyMsTotal: this._meta.latencyMsTotal,
      indicesQueried: this._meta.indicesQueried
        ? [...this._meta.indicesQueried]
        : [],
    };
  }

  /**
   * Async iterable over `NormalizedArticleBatch` from the cluster.
   * One page = one batch. Caller bulk-inserts per batch.
   *
   * The page cap (`OPENSEARCH_MAX_PAGES`) and page size
   * (`OPENSEARCH_PAGE_SIZE`) come from env — these are global tuning
   * knobs, not per-chat. Future ADRs may move them per-chat.
   */
  async *fetch(ctx: FetchContext): AsyncIterable<NormalizedArticleBatch> {
    const t0 = Date.now();
    const env = loadEnv();
    const maxPages = env.OPENSEARCH_MAX_PAGES;
    const pageSize = env.OPENSEARCH_PAGE_SIZE;

    // resolveIndices accepts `mediaTypes: null` as "use all 11 types".
    // chat_params.mediaTypes==[] is the "no override" sentinel — pass null
    // so the resolver falls through to env defaults. (Matches the
    // pre-refactor SearchAgent.reason() behavior 1:1.)
    const dateRange =
      ctx.structured.dateRange != null
        ? {
            start: new Date(ctx.structured.dateRange.start),
            end: new Date(ctx.structured.dateRange.end),
          }
        : null;
    const mediaTypes = ctx.mediaTypes.length > 0 ? ctx.mediaTypes : null;
    const indices = resolveIndices({ dateRange, mediaTypes });
    this._meta.indicesQueried = [...indices];

    let pagesScanned = 0;
    let cumulative = 0;
    let searchAfter: unknown[] | undefined = undefined;
    let totalHits: number | null = null;

    try {
      while (pagesScanned < maxPages) {
        if (ctx.signal?.aborted) return;

        const dsl = buildOpenSearchDsl(ctx.structured, { searchAfter });
        const outcome = await search({
          indices,
          body: dsl as unknown as Record<string, unknown>,
          config: {
            url: this.config.url,
            username: this.config.username,
            password: this.config.password,
          },
        });

        // totalHits only valid on first response.
        if (pagesScanned === 0) {
          totalHits = outcome.totalHits;
          this._meta.totalHits = totalHits;
        }
        // Accumulate retries across pages — most pages succeed with 0,
        // a 503-then-200 page contributes 1, etc.
        this._meta.retriesUsed += outcome.retriesUsed;

        const hits = outcome.hits;
        pagesScanned += 1;

        // Empty page → terminal. Emit one final empty batch so callers
        // can flush their "last page" UI signal, then return.
        if (hits.length === 0) {
          yield {
            articles: [],
            progress: {
              page: pagesScanned,
              cumulativeArticles: cumulative,
              isLastPage: true,
            },
          };
          break;
        }

        // Map hits → canonical NormalizedArticle. The mapper already
        // returns NormalizedArticleFields + openSearchId + rawData; we
        // stamp `sourceArticleId` and `sourceKind` here so the contract
        // is single-shaped.
        const articles: NormalizedArticle[] = hits.map((h) => {
          const m = mapHitToArticle({
            _id: h._id,
            _source: h._source as Record<string, unknown>,
          });
          return {
            sourceArticleId: m.openSearchId,
            title: m.title,
            content: m.content,
            description: m.description,
            source: m.source,
            author: m.author,
            publishedDate: m.publishedDate,
            url: m.url,
            publisherDomain: m.publisherDomain,
            language: m.language,
            country: m.country,
            reach: m.reach,
            sources: m.sources,
            rawData: m.rawData as Prisma.InputJsonValue,
            sourceKind: 'opensearch',
          };
        });

        cumulative += articles.length;
        const last = hits[hits.length - 1]!;
        searchAfter = last.sort;
        const isLastPage = hits.length < pageSize || pagesScanned >= maxPages;

        yield {
          articles,
          progress: {
            page: pagesScanned,
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
