/**
 * Phase 3.5 (M9.5) — SearchAgent.
 *
 * Fetches articles from OpenSearch when `chat_params.data_source ==
 * 'opensearch'` and the boolean query has been confirmed. The autonomy
 * primitive of Phase 3.5: it pages the cluster, persists the rows to
 * `articles`, detects whether reach is present, records the run in
 * `search_history` for memory, and hands off to EnrichmentAgent with
 * the source-aware payload from M9.4.5.
 *
 * Lifecycle (Phase 1 §5.4):
 *   perceive — load chat_params + boolean_queries row + structured query;
 *              check search_history cache (log only, no short-circuit yet)
 *   reason   — resolve indices (M9.1.2) and build the DSL (M9.1)
 *   plan     — fix the per-page DSL builder + cap pages at OPENSEARCH_MAX_PAGES
 *   act      — pagination loop with search_after; per-page bulk insert
 *              (M9.5 article-bulk-insert.service); emit search:progress
 *              every page; emit search:fetched when the loop terminates
 *   reflect  — run field-presence detector on the first batch; when
 *              reach coverage < 80% AND enrichmentType == 'standard' the
 *              agent pauses, emits `reach:absent`, and stops short of
 *              the EnrichmentAgent dispatch. M9.5.5 wires the chat-state
 *              probe; M9.5 just stops cleanly.
 *   learn    — record one row in search_history regardless of pause or
 *              completion, so the memory contract holds for the next
 *              re-execution attempt
 *
 * Sentinel UUID: `00000000-0000-0000-0000-00000053ea4c` (53ea4c ~ "Search").
 * Singleton — no `agents` table row; `logAction` is overridden to no-op
 * (matches the M7.7 / M8.4 pattern).
 *
 * The agent is dispatched by the `data-extract` BullMQ worker (M9.5
 * branches the worker on `chat_params.dataSource`), not via a new
 * queue — that keeps the M7.6 `confirmQuery` trigger contract intact.
 *
 * @file backend/src/agents/search.agent.ts
 */
import { BaseAgent, type AgentInput } from './base-agent.js';
import { withUser } from '../lib/prisma-rls.js';
import { publishAgentBus, publishChatEvent } from '../lib/event-bus.js';
import { resolveIndices } from '../lib/opensearch-indices.js';
import { buildOpenSearchDsl } from '../lib/opensearch-dsl.js';
import { mapHitToArticle, type NormalizedArticleFields } from '../lib/opensearch-mapping.js';
import { search } from '../lib/opensearch-client.js';
import { detectFieldPresence } from '../lib/field-presence-detector.js';
import { hashSearchQuery } from '../lib/query-hash.js';
import {
  bulkInsertArticles,
  type ArticleRowForInsert,
} from '../services/article-bulk-insert.service.js';
import {
  findCachedSearch,
  recordSearchExecution,
} from '../services/search-history.service.js';
import { hasOpenSearchConfig, loadEnv } from '../env.js';
import { MediaTypeSchema, type MediaType } from '../lib/media-types.js';
import type { BooleanQueryStructured } from '../lib/boolean-query-engine.js';

/** Reach coverage below this fraction → emit `reach:absent` and pause. */
const PRESENCE_THRESHOLD = 0.8;

/** How many of the first inserted articles to use for presence detection.
 *  Matches `field-presence-detector.DEFAULT_SAMPLE`. */
const PRESENCE_SAMPLE_SIZE = 50;

interface SearchAgentInput extends AgentInput {
  metadata: {
    /** Confirmed boolean_queries row id. The agent re-reads the row inside
     *  perceive() to lock the `query_structured` snapshot. */
    queryId: string;
  };
}

interface PerceivedContext {
  userId: string;
  chatId: string;
  queryId: string;
  structured: BooleanQueryStructured;
  enrichmentType: 'standard' | 'reach';
  mediaTypes: MediaType[];
  queryHash: string;
  /** Cached search_history row from a previous identical query, if any.
   *  M9.5 logs this for visibility; doesn't short-circuit (see file docstring). */
  cachedRun: { id: string; totalHits: number } | null;
}

interface Reasoned {
  ctx: PerceivedContext;
  indices: string[];
  pageSize: number;
  maxPages: number;
}

interface PlanItem {
  ctx: PerceivedContext;
  indices: string[];
  pageSize: number;
  maxPages: number;
}

export interface SearchAgentResult {
  articlesInserted: number;
  totalHits: number;
  pagesScanned: number;
  indicesQueried: string[];
  coverageReach: number | null;
  /** Articles for the first-batch presence-detection sample, used by
   *  reflect() and the handoff. Kept on the result so reflect() and
   *  learn() see exactly the same sample (the act result is the only
   *  bridge between lifecycle phases per BaseAgent.execute()). */
  presenceSample: NormalizedArticleFields[];
  /** OpenSearch _id list for memory persistence. */
  openSearchIds: string[];
  /** True when reflect() decided to pause (reach absent + standard
   *  enrichment). Determines whether learn() should also dispatch the
   *  enrichment handoff or stop short. */
  paused: boolean;
  /** Total wall-clock ms inside act(). */
  latencyMsTotal: number;
}

/**
 * Errors raised by `search()` (M9.1.2) inside the agent loop bubble up
 * here. We classify them once for the `search:error` payload so the
 * frontend can surface a friendly message without parsing exception
 * strings client-side.
 */
function classifySearchError(err: unknown): {
  message: string;
  retriesUsed?: number;
} {
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: 'OpenSearch search failed.' };
}

export class SearchAgent extends BaseAgent {
  /**
   * Singleton override — SearchAgent has no `agents` table row, so the
   * BaseAgent default would violate the agent_logs FK. Lifecycle
   * observability flows through the `search:*` WS events instead.
   */
  override async logAction(): Promise<void> {
    /* no-op — singleton has no agents-table row */
  }

  // ─────────────────────────────────────────────────────────────────────
  // perceive
  // ─────────────────────────────────────────────────────────────────────

  async perceive(input: AgentInput): Promise<PerceivedContext> {
    const d = input as unknown as SearchAgentInput;
    const userId = d.userId;
    const chatId = d.chatId;
    const queryId = d.metadata?.queryId;
    if (!chatId) throw new Error('chatId required');
    if (!queryId) throw new Error('metadata.queryId required');

    // Defensive config check. The dispatcher (data-extract worker)
    // already verifies hasOpenSearchConfig(), but a misconfigured Render
    // env could trip here too — fail with a clear message.
    if (!hasOpenSearchConfig()) {
      throw new Error('OpenSearch is not configured.');
    }

    const { params, query } = await withUser(userId, async (tx) => {
      const q = await tx.booleanQuery.findFirst({
        where: { id: queryId, chatId, isConfirmed: true },
      });
      if (!q) throw new Error(`confirmed query ${queryId} not found`);
      const p = await tx.chatParams.findUnique({ where: { chatId } });
      if (!p) throw new Error(`chat_params for chat ${chatId} missing`);
      return { params: p, query: q };
    });

    if (params.dataSource !== 'opensearch') {
      throw new Error(
        `SearchAgent requires chat_params.dataSource='opensearch' (got '${params.dataSource}')`,
      );
    }

    // `query_structured` is stored as Json. We narrow it to the
    // BooleanQueryStructured shape — the M7.6 engine writes this shape
    // verbatim and we never write any other JSON to that column.
    const structured = query.queryStructured as unknown as BooleanQueryStructured;
    if (!structured?.brand) {
      throw new Error('confirmed query missing structured.brand');
    }

    // Parse media types defensively — the column is TEXT[]; bad strings
    // are silently dropped (and unparseable yields []).
    const mediaTypes: MediaType[] = (params.mediaTypes ?? [])
      .map((s) => MediaTypeSchema.safeParse(s))
      .filter((r): r is { success: true; data: MediaType } => r.success)
      .map((r) => r.data);

    const queryHash = hashSearchQuery({ structured, mediaTypes });

    // Memory READ (logging only — no short-circuit in M9.5).
    let cachedRun: PerceivedContext['cachedRun'] = null;
    try {
      const row = await findCachedSearch(userId, chatId, queryHash);
      if (row) {
        cachedRun = { id: row.id, totalHits: row.totalHits };
      }
    } catch (err) {
      // Memory lookup failures must never break the run. Log once and
      // proceed as if no cache existed.
      // eslint-disable-next-line no-console
      console.warn('[search-agent] findCachedSearch failed', {
        chatId,
        err: (err as Error).message,
      });
    }

    const enrichmentType: 'standard' | 'reach' =
      params.enrichmentType === 'reach' ? 'reach' : 'standard';

    return {
      userId,
      chatId,
      queryId,
      structured,
      enrichmentType,
      mediaTypes,
      queryHash,
      cachedRun,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // reason
  // ─────────────────────────────────────────────────────────────────────

  async reason(ctxIn: unknown): Promise<Reasoned> {
    const ctx = ctxIn as PerceivedContext;
    const env = loadEnv();

    // resolveIndices accepts `mediaTypes: null` as "use all 11 types".
    // chat_params.mediaTypes==[] is the "no override" sentinel — pass null
    // so the resolver falls through to env defaults.
    const dateRange =
      ctx.structured.dateRange != null
        ? {
            start: new Date(ctx.structured.dateRange.start),
            end: new Date(ctx.structured.dateRange.end),
          }
        : null;
    const mediaTypes = ctx.mediaTypes.length > 0 ? ctx.mediaTypes : null;

    const indices = resolveIndices({ dateRange, mediaTypes });

    return {
      ctx,
      indices,
      pageSize: env.OPENSEARCH_PAGE_SIZE,
      maxPages: env.OPENSEARCH_MAX_PAGES,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // plan
  // ─────────────────────────────────────────────────────────────────────

  async plan(goalIn: unknown): Promise<PlanItem> {
    const { ctx, indices, pageSize, maxPages } = goalIn as Reasoned;
    return { ctx, indices, pageSize, maxPages };
  }

  // ─────────────────────────────────────────────────────────────────────
  // act — search_after pagination loop
  // ─────────────────────────────────────────────────────────────────────

  async act(planIn: unknown): Promise<SearchAgentResult> {
    const { ctx, indices, pageSize, maxPages } = planIn as PlanItem;
    const t0 = Date.now();

    await publishChatEvent(ctx.chatId, 'search:start', {
      chatId: ctx.chatId,
      totalIndicesQueried: indices.length,
      indicesPreview: indices.slice(0, 5),
    });

    let pagesScanned = 0;
    let searchAfter: unknown[] | undefined = undefined;
    let totalHits = 0;
    let articlesInserted = 0;
    const indicesWithHits = new Set<string>();
    const presenceSample: NormalizedArticleFields[] = [];
    const openSearchIds: string[] = [];

    try {
      while (pagesScanned < maxPages) {
        const dsl = buildOpenSearchDsl(ctx.structured, { searchAfter });
        const outcome = await search({
          indices,
          body: dsl as unknown as Record<string, unknown>,
        });

        // totalHits only valid on first response (search_after pages return
        // the same `hits.total` per OpenSearch). Capture once.
        if (pagesScanned === 0) totalHits = outcome.totalHits;

        const hits = outcome.hits;
        pagesScanned += 1;

        // Empty page → loop terminates. Emit a final progress event so
        // the frontend always sees at least one. lastPage:true.
        if (hits.length === 0) {
          await publishChatEvent(ctx.chatId, 'search:progress', {
            chatId: ctx.chatId,
            totalSoFar: articlesInserted,
            pagesScanned,
            lastPage: true,
          });
          break;
        }

        // Map hits → article rows for bulk insert.
        const mapped = hits.map((h) =>
          mapHitToArticle({ _id: h._id, _source: h._source as Record<string, unknown> }),
        );

        // Track index attribution. Hits in OpenSearch carry `_index`
        // but the M9.1.2 wrapper strips it; we conservatively attribute
        // every queried index. Phase 4 can refine if needed.
        for (const ix of indices) indicesWithHits.add(ix);

        // Accumulate the presence-detection sample BEFORE persistence —
        // we always inspect the first N inserted hits, even when the
        // first page exceeds N.
        for (const m of mapped) {
          if (presenceSample.length < PRESENCE_SAMPLE_SIZE) {
            presenceSample.push(m);
          }
          openSearchIds.push(m.openSearchId);
        }

        // Bulk insert inside a fresh RLS transaction per page. This
        // keeps the lock window short — millions of hits would otherwise
        // hold one txn open for the whole loop.
        const insertResult = await withUser(ctx.userId, async (tx) => {
          return bulkInsertArticles(tx, {
            chatId: ctx.chatId,
            userId: ctx.userId,
            articles: mapped as ArticleRowForInsert[],
          });
        });
        articlesInserted += insertResult.inserted;

        // Update search_after using the last hit's sort tuple. When the
        // page is shorter than pageSize, this is the last page — flag
        // it and emit lastPage:true before breaking.
        const last = hits[hits.length - 1]!;
        searchAfter = last.sort;

        const lastPage = hits.length < pageSize || pagesScanned >= maxPages;
        await publishChatEvent(ctx.chatId, 'search:progress', {
          chatId: ctx.chatId,
          totalSoFar: articlesInserted,
          pagesScanned,
          lastPage,
        });

        if (lastPage) break;
      }
    } catch (err) {
      const classified = classifySearchError(err);
      await publishChatEvent(ctx.chatId, 'search:error', {
        chatId: ctx.chatId,
        message: classified.message,
        ...(classified.retriesUsed !== undefined
          ? { retriesUsed: classified.retriesUsed }
          : {}),
      });
      throw err;
    }

    const latencyMsTotal = Date.now() - t0;

    await publishChatEvent(ctx.chatId, 'search:fetched', {
      chatId: ctx.chatId,
      articlesInserted,
      indicesQueried: Array.from(indicesWithHits).sort(),
      latencyMsTotal,
    });

    return {
      articlesInserted,
      totalHits,
      pagesScanned,
      indicesQueried: Array.from(indicesWithHits).sort(),
      coverageReach: null, // reflect() fills this
      presenceSample,
      openSearchIds,
      paused: false,
      latencyMsTotal,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // reflect — presence detection + reach probe gate
  // ─────────────────────────────────────────────────────────────────────

  async reflect(resultIn: unknown): Promise<void> {
    const r = resultIn as SearchAgentResult & {
      _ctx?: PerceivedContext;
    };
    // act() doesn't carry the perceive context through; we rely on the
    // execute() override below to wire reflect via a closure. The flat
    // `r._ctx` field is set by our execute() override before invoking
    // reflect. Defensive fallback: if missing, skip the probe.
    const ctx = r._ctx;
    if (!ctx) return;

    // Zero hits → presence detection meaningless. Coverage stays null.
    if (r.presenceSample.length === 0) {
      r.coverageReach = null;
      return;
    }

    const presence = detectFieldPresence(r.presenceSample, {
      sampleSize: PRESENCE_SAMPLE_SIZE,
      threshold: PRESENCE_THRESHOLD,
    });
    r.coverageReach = presence.coverage.reach;

    // Probe gate: only emit `reach:absent` for the (standard enrichment
    // + low coverage) combo. In the other branches (reach enrichment,
    // OR presence ≥ threshold) the enrichment path knows what to do.
    if (
      ctx.enrichmentType === 'standard' &&
      presence.coverage.reach < PRESENCE_THRESHOLD
    ) {
      await publishChatEvent(ctx.chatId, 'reach:absent', {
        chatId: ctx.chatId,
        coverageReach: presence.coverage.reach,
        sampleSize: presence.sampleSize,
        suggestUpgrade: true,
      });
      r.paused = true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // learn — persist search_history; dispatch enrichment unless paused
  // ─────────────────────────────────────────────────────────────────────

  override async learn(outcomeIn: unknown): Promise<void> {
    const r = outcomeIn as SearchAgentResult & {
      _ctx?: PerceivedContext;
    };
    const ctx = r._ctx;
    if (!ctx) return;

    // Memory ALWAYS records, regardless of pause. M9.5.5 reading the
    // row would otherwise see no row when resuming the chat.
    try {
      await recordSearchExecution(ctx.userId, {
        chatId: ctx.chatId,
        queryHash: ctx.queryHash,
        articleIds: r.openSearchIds,
        totalHits: r.totalHits,
        indicesQueried: r.indicesQueried,
        coverageReach: r.coverageReach,
      });
    } catch (err) {
      // Memory write failure must never break the user-visible run.
      // Log + continue.
      // eslint-disable-next-line no-console
      console.error('[search-agent] search_history insert failed', {
        chatId: ctx.chatId,
        err: (err as Error).message,
      });
    }

    if (r.paused) {
      // Reach absent + standard enrichment → STOP. M9.5.5 will resume
      // via the chat-state machine after the user picks an upgrade
      // chip. We do NOT emit `search:complete` here — the chat is in
      // an explicit "awaiting user decision" state.
      return;
    }

    // Happy path: emit terminal `search:complete` and hand off to
    // EnrichmentAgent on the cross-agent bus (same channel that the
    // CSV path uses — M8.4's enrichment-subscriber picks this up).
    await publishChatEvent(ctx.chatId, 'search:complete', {
      chatId: ctx.chatId,
      ready: r.articlesInserted > 0,
      count: r.articlesInserted,
    });

    if (r.articlesInserted > 0) {
      await publishAgentBus('agent:enrichment:incoming', {
        chatId: ctx.chatId,
        userId: ctx.userId,
        // Empty articleIds = enrich all articles for the chat (matches
        // the M7.7 CSV path contract).
        articleIds: [],
        enrichmentType: ctx.enrichmentType,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // execute — override to thread ctx through reflect/learn
  // ─────────────────────────────────────────────────────────────────────

  /**
   * The BaseAgent default execute() passes the act-result straight to
   * reflect() and learn(), but those steps need the perceive context too
   * (so we can compare presence against `enrichmentType`, hash for memory,
   * etc.). We override execute() to thread `_ctx` onto the result object.
   *
   * On a thrown error, `act()` is the canonical `search:error` emitter
   * for failures during the fetch loop. Failures in perceive/reason/plan
   * happen before any WS event has been published, so the execute()
   * catch emits one — but only when we already have a `chatId` to route
   * to AND the error did NOT come out of act() (avoid duplicate emits).
   */
  override async execute<T = unknown>(input: AgentInput): Promise<T> {
    const start = Date.now();
    let ctx: PerceivedContext | undefined;
    let actStarted = false;
    try {
      ctx = await this.perceive(input);
      const goal = await this.reason(ctx);
      const plan = await this.plan(goal);
      actStarted = true;
      const result = (await this.act(plan)) as SearchAgentResult;
      // Attach ctx so reflect/learn can see it without a side channel.
      (result as SearchAgentResult & { _ctx: PerceivedContext })._ctx = ctx;
      await this.reflect(result);
      await this.learn(result);
      // logAction is a no-op for singleton agents (no agents-table row).
      // Lifecycle observability flows through the `search:*` WS events.
      // Reference `start` so the linter sees it's intentionally tracked
      // for parity with BaseAgent.execute().
      void start;
      return result as T;
    } catch (err) {
      // act() owns its own `search:error` emit — don't double-publish.
      // We only emit defensively for failures BEFORE the loop started.
      if (ctx && !actStarted) {
        try {
          await publishChatEvent(ctx.chatId, 'search:error', {
            chatId: ctx.chatId,
            message: (err as Error).message,
          });
        } catch {
          /* swallow; original error wins */
        }
      }
      throw err;
    }
  }
}
