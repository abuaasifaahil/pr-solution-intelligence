/**
 * Phase 3.5 (M9.5 → M9.6a) — SearchAgent.
 *
 * Thin lifecycle wrapper around `OpenSearchAdapter` (per ADR-0001's
 * adapter pattern). M9.5 fetch logic — the search_after pagination loop,
 * the DSL build, the index resolve, and the `mapHitToArticle` call —
 * moved into `data-sources/opensearch/opensearch.adapter.ts`. The agent
 * now:
 *
 *   - resolves the OpenSearch config (chat-attached > user M5 > env)
 *   - constructs the adapter via the registry
 *   - iterates the adapter's fetch() async iterable
 *   - bulk-inserts each yielded batch
 *   - emits the same `search:*` WS events the M9.5 contract guarantees
 *   - hands off to EnrichmentAgent on completion (or pauses for the
 *     M9.5.5 reach probe)
 *
 * BaseAgent lifecycle (unchanged externally):
 *   perceive — load chat_params + boolean_queries; check search_history
 *   reason   — resolve OS config; instantiate the adapter
 *   plan     — capture declared capabilities (planning hint for M9.11+)
 *   act      — drive adapter.fetch(); bulk-insert; emit `search:*`
 *   reflect  — presence detection + M9.5.5 reach-probe gate
 *   learn    — search_history write + handoff dispatch
 *
 * Sentinel UUID: `00000000-0000-0000-0000-00000053ea4c` (53ea4c ~ "Search").
 *
 * @file backend/src/agents/search.agent.ts
 */
import { BaseAgent, type AgentInput } from './base-agent.js';
import { withUser } from '../lib/prisma-rls.js';
import { publishAgentBus, publishChatEvent } from '../lib/event-bus.js';
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
import { enterReachProbe } from '../services/reach-probe.service.js';
import { hasOpenSearchConfig } from '../env.js';
import { MediaTypeSchema, type MediaType } from '../lib/media-types.js';
import type { BooleanQueryStructured } from '../lib/boolean-query-engine.js';
import { resolveOpenSearchConfig } from '../data-sources/opensearch/config-resolver.js';
import { createAdapter } from '../data-sources/registry.js';
import type {
  DataSourceAdapter,
  DeclaredCapabilities,
  NormalizedArticle,
} from '../data-sources/adapter.js';
import type { NormalizedArticleFields } from '../lib/opensearch-mapping.js';

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
  adapter: DataSourceAdapter;
}

interface PlanItem {
  ctx: PerceivedContext;
  adapter: DataSourceAdapter;
  capabilities: DeclaredCapabilities;
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
 * Errors raised by the adapter's underlying `search()` retry wrapper
 * bubble up here. We classify them once for the `search:error` payload.
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

/**
 * Convert a `NormalizedArticle` from the adapter back to the
 * `ArticleRowForInsert` shape the bulk-insert service consumes. They're
 * almost identical — `openSearchId` (used by the unique index) maps from
 * the canonical `sourceArticleId`.
 */
function toArticleRow(a: NormalizedArticle): ArticleRowForInsert {
  return {
    title: a.title,
    content: a.content,
    description: a.description,
    source: a.source,
    author: a.author,
    publishedDate: a.publishedDate,
    url: a.url,
    publisherDomain: a.publisherDomain,
    language: a.language,
    country: a.country,
    reach: a.reach,
    sources: a.sources,
    rawData: a.rawData,
    openSearchId: a.sourceArticleId,
  };
}

/**
 * Project a `NormalizedArticle` to the `NormalizedArticleFields` shape
 * `detectFieldPresence` consumes. Drops the adapter-specific
 * `sourceArticleId` / `sourceKind` fields so presence detection runs on
 * the canonical 13-field surface only.
 */
function toPresenceFields(a: NormalizedArticle): NormalizedArticleFields {
  return {
    title: a.title,
    content: a.content,
    description: a.description,
    source: a.source,
    author: a.author,
    publishedDate: a.publishedDate,
    url: a.url,
    publisherDomain: a.publisherDomain,
    language: a.language,
    country: a.country,
    reach: a.reach,
    sources: a.sources,
  };
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
  // reason — resolve config + build adapter
  // ─────────────────────────────────────────────────────────────────────

  async reason(ctxIn: unknown): Promise<Reasoned> {
    const ctx = ctxIn as PerceivedContext;

    // Resolve OpenSearch config with chat-attached > user M5 > env
    // precedence. M9.6a always passes undefined for chat-attached
    // (M9.11 will plumb chat_data_sources.source_config through).
    const config = await resolveOpenSearchConfig(ctx.userId);
    if (!config) {
      throw new Error('OpenSearch is not configured.');
    }

    const adapter = createAdapter({ kind: 'opensearch', config });
    return { ctx, adapter };
  }

  // ─────────────────────────────────────────────────────────────────────
  // plan — capture declared capabilities (M9.11+ uses these)
  // ─────────────────────────────────────────────────────────────────────

  async plan(goalIn: unknown): Promise<PlanItem> {
    const { ctx, adapter } = goalIn as Reasoned;
    return { ctx, adapter, capabilities: adapter.declaredCapabilities() };
  }

  // ─────────────────────────────────────────────────────────────────────
  // act — drive adapter.fetch(); bulk-insert; emit search:* events
  // ─────────────────────────────────────────────────────────────────────

  async act(planIn: unknown): Promise<SearchAgentResult> {
    const { ctx, adapter } = planIn as PlanItem;
    const t0 = Date.now();

    // M9.5 contract: `search:start` includes `totalIndicesQueried` +
    // `indicesPreview`. Indices are an adapter-internal concern under
    // the new architecture; we surface them via `adapter.meta()` AFTER
    // the first page lands. To preserve the event ordering, we read
    // the first-batch metadata before the second event fires.
    let startEventSent = false;
    let pagesScanned = 0;
    let articlesInserted = 0;
    const indicesWithHits = new Set<string>();
    const presenceSample: NormalizedArticleFields[] = [];
    const openSearchIds: string[] = [];
    let totalHits = 0;

    try {
      for await (const batch of adapter.fetch({
        userId: ctx.userId,
        chatId: ctx.chatId,
        config: null,
        structured: ctx.structured,
        mediaTypes: ctx.mediaTypes,
      })) {
        // Emit `search:start` once, on the first batch — the adapter's
        // `meta()` is now populated with the resolved index list.
        if (!startEventSent) {
          startEventSent = true;
          const meta0 = adapter.meta();
          const indices0 = meta0.indicesQueried ?? [];
          await publishChatEvent(ctx.chatId, 'search:start', {
            chatId: ctx.chatId,
            totalIndicesQueried: indices0.length,
            indicesPreview: indices0.slice(0, 5),
          });
        }

        pagesScanned = batch.progress.page;

        // Empty terminal batch → emit one final progress event with
        // lastPage:true and stop (matches the M9.5 pre-refactor
        // contract).
        if (batch.articles.length === 0) {
          await publishChatEvent(ctx.chatId, 'search:progress', {
            chatId: ctx.chatId,
            totalSoFar: articlesInserted,
            pagesScanned,
            lastPage: true,
          });
          break;
        }

        // Update presence sample + openSearchIds + index attribution
        // BEFORE persistence so reflect() always sees the first N rows.
        for (const a of batch.articles) {
          if (presenceSample.length < PRESENCE_SAMPLE_SIZE) {
            presenceSample.push(toPresenceFields(a));
          }
          openSearchIds.push(a.sourceArticleId);
        }
        const meta = adapter.meta();
        if (meta.totalHits !== null && pagesScanned === 1) totalHits = meta.totalHits;
        for (const ix of meta.indicesQueried ?? []) indicesWithHits.add(ix);

        // Bulk insert inside a fresh RLS transaction per batch. Keeps
        // the lock window short across very large fetches.
        const rows = batch.articles.map(toArticleRow);
        const insertResult = await withUser(ctx.userId, async (tx) => {
          return bulkInsertArticles(tx, {
            chatId: ctx.chatId,
            userId: ctx.userId,
            articles: rows,
          });
        });
        articlesInserted += insertResult.inserted;

        await publishChatEvent(ctx.chatId, 'search:progress', {
          chatId: ctx.chatId,
          totalSoFar: articlesInserted,
          pagesScanned,
          lastPage: batch.progress.isLastPage,
        });

        if (batch.progress.isLastPage) break;
      }

      // Edge: adapter yielded zero batches at all. Emit start + a
      // last-page progress so the frontend resolves its skeleton.
      if (!startEventSent) {
        const meta0 = adapter.meta();
        const indices0 = meta0.indicesQueried ?? [];
        await publishChatEvent(ctx.chatId, 'search:start', {
          chatId: ctx.chatId,
          totalIndicesQueried: indices0.length,
          indicesPreview: indices0.slice(0, 5),
        });
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

    // Probe gate: only run the reach probe for the (standard enrichment
    // + low coverage) combo. In the other branches (reach enrichment,
    // OR presence ≥ threshold) the enrichment path knows what to do.
    //
    // M9.5.5: the probe lives in `reach-probe.service` — it emits
    // `reach:absent` AND pins `chat.context.state` to
    // `awaiting_reach_upgrade_consent` so a reconnect resumes the same
    // probe. The service is agent-class-agnostic so the M9.6a adapter
    // refactor leaves this dispatch untouched.
    if (
      ctx.enrichmentType === 'standard' &&
      presence.coverage.reach < PRESENCE_THRESHOLD
    ) {
      await enterReachProbe({
        chatId: ctx.chatId,
        coverageReach: presence.coverage.reach,
        sampleSize: presence.sampleSize,
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
