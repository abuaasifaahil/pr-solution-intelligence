/**
 * Phase 3 EnrichmentAgent — M8.4.
 *
 * Singleton BaseAgent subclass that owns the per-chat enrichment lifecycle:
 * loads the chat's articles, sizes batches against the active LLM provider's
 * input window, writes the `enrichment_job` + N `enrichment_batches` rows,
 * then fans out one `enrich-batch` BullMQ job per batch. The per-batch
 * worker (M8.5) actually calls the LLM and upserts enrichments — M8.4 stops
 * at "job + batches written, jobs enqueued."
 *
 * Lifecycle:
 *   perceive — load articles (by explicit ids or all-for-chat), pick the
 *              enrichmentType (caller > chat_params > default 'standard'),
 *              resolve the LLM provider via getModel()
 *   reason   — call planBatching() from M8.2; add few-shot overhead per
 *              batch; reject if total estimate > MAX_TOKENS_PER_JOB
 *   plan     — create enrichment_job + N enrichment_batches rows; return
 *              the batch ids so act() can attach them to queue jobs
 *   act      — publish `enrichment:start` on the chat channel; enqueue one
 *              `enrich-batch` per batch (with batch id + chat / user ids);
 *              if enrichmentType=='reach', enqueue a single `reach-fetch`
 *              for the SimilarWebAgent (M8.6 wires the processor)
 *   reflect  — no-op until M8.5 (per-batch finalization)
 *
 * The singleton is registered without a corresponding `agents` table row,
 * so `logAction` is overridden to no-op — mirrors the M7.7 DataExtractAgent
 * pattern. Run observability flows through the WS events (`enrichment:*`).
 *
 * @file backend/src/agents/enrichment.agent.ts
 */
import { BaseAgent, type AgentInput } from './base-agent.js';
import { withUser } from '../lib/prisma-rls.js';
import { getModel, planBatching, type LLMProvider } from '../lib/llm-gateway.js';
import { FEW_SHOT_OVERHEAD_TOKENS } from '../lib/enrichment-prompt.js';
import { publishChatEvent } from '../lib/event-bus.js';
import { getQueue } from '../lib/queue.js';

interface EnrichmentInput extends AgentInput {
  metadata: {
    /** Explicit subset of article ids to enrich. Empty = all for the chat. */
    articleIds: string[];
    /** Optional override; otherwise read from chat_params or default 'standard'. */
    enrichmentType?: 'standard' | 'reach';
  };
}

interface PerceivedContext {
  userId: string;
  chatId: string;
  articleIds: string[];
  articles: Array<{ id: string; content: string }>;
  enrichmentType: 'standard' | 'reach';
  provider: LLMProvider;
}

interface Reasoned {
  ctx: PerceivedContext;
  batches: Array<{ articleIds: string[]; estimatedTokens: number }>;
  totalEstimatedTokens: number;
}

interface PlanItem {
  ctx: PerceivedContext;
  jobId: string;
  batches: Array<{
    id: string;
    batchNumber: number;
    articleIds: string[];
    estimatedTokens: number;
  }>;
}

export interface EnrichmentActResult {
  jobId: string;
  batchCount: number;
  totalArticles: number;
  estimatedTokens: number;
}

/**
 * Hard cap on per-job token estimates to keep runaway corpora from melting
 * the cost budget. Default per spec § "Open items" is 300_000; override via
 * MAX_TOKENS_PER_JOB env. Enforced in `reason` before any DB / queue writes.
 */
const MAX_TOKENS_PER_JOB = Number(process.env.MAX_TOKENS_PER_JOB ?? 300_000);

export class EnrichmentAgent extends BaseAgent {
  async perceive(input: AgentInput): Promise<PerceivedContext> {
    const d = input as EnrichmentInput;
    const userId = d.userId;
    const chatId = d.chatId;
    if (!chatId) throw new Error('chatId required');
    const requestedType = d.metadata?.enrichmentType;
    const explicitIds = d.metadata?.articleIds ?? [];

    // Load articles + chat_params inside withUser so RLS scopes the reads.
    // getModel() runs its own withUser to fetch llm_configs.
    const { articles, enrichmentType } = await withUser(userId, async (tx) => {
      const params = await tx.chatParams.findUnique({ where: { chatId } });
      const resolvedType: 'standard' | 'reach' =
        requestedType ??
        (params?.enrichmentType === 'reach' ? 'reach' : 'standard');

      const rows =
        explicitIds.length > 0
          ? await tx.article.findMany({
              where: { id: { in: explicitIds }, chatId },
              select: { id: true, content: true, description: true },
            })
          : await tx.article.findMany({
              where: { chatId },
              select: { id: true, content: true, description: true },
            });

      if (rows.length === 0) {
        throw new Error(
          `enrichment requested but no articles found for chat ${chatId}`,
        );
      }

      return {
        articles: rows.map((a) => ({
          id: a.id,
          content: a.content ?? a.description ?? '(no content)',
        })),
        enrichmentType: resolvedType,
      };
    });

    const provider = await getModel(userId);

    return {
      userId,
      chatId,
      articleIds: articles.map((a) => a.id),
      articles,
      enrichmentType,
      provider,
    };
  }

  async reason(ctxIn: unknown): Promise<Reasoned> {
    const ctx = ctxIn as PerceivedContext;
    const planned = planBatching(ctx.articles, ctx.provider);

    // planBatching already targets 80% of the provider's max input window,
    // so the system + few-shot prefix fits in the remaining headroom. We
    // still surface the few-shot overhead in the per-job total so the
    // MAX_TOKENS_PER_JOB guardrail catches realistic costs.
    const total =
      planned.totalEstimatedTokens +
      planned.batches.length * FEW_SHOT_OVERHEAD_TOKENS;
    if (total > MAX_TOKENS_PER_JOB) {
      throw new Error(
        `enrichment estimate (${total} tokens) exceeds MAX_TOKENS_PER_JOB (${MAX_TOKENS_PER_JOB}). ` +
          `Reduce article count or raise the cap.`,
      );
    }

    return { ctx, batches: planned.batches, totalEstimatedTokens: total };
  }

  async plan(goalIn: unknown): Promise<PlanItem> {
    const { ctx, batches } = goalIn as Reasoned;

    return withUser(ctx.userId, async (tx) => {
      const job = await tx.enrichmentJob.create({
        data: {
          chatId: ctx.chatId,
          userId: ctx.userId,
          totalArticles: ctx.articles.length,
          batchCount: batches.length,
          modelUsed: ctx.provider.config.modelName,
          enrichmentType: ctx.enrichmentType,
          status: 'processing',
          startedAt: new Date(),
        },
      });

      const batchRows: PlanItem['batches'] = [];
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i]!;
        const row = await tx.enrichmentBatch.create({
          data: {
            jobId: job.id,
            batchNumber: i + 1,
            articleIds: b.articleIds,
            estimatedTokens: b.estimatedTokens,
            status: 'pending',
          },
        });
        batchRows.push({
          id: row.id,
          batchNumber: row.batchNumber,
          articleIds: b.articleIds,
          estimatedTokens: b.estimatedTokens,
        });
      }

      return { ctx, jobId: job.id, batches: batchRows };
    });
  }

  async act(planIn: unknown): Promise<EnrichmentActResult> {
    const { ctx, jobId, batches } = planIn as PlanItem;

    await publishChatEvent(ctx.chatId, 'enrichment:start', {
      jobId,
      totalArticles: ctx.articles.length,
      batchCount: batches.length,
      model: ctx.provider.config.modelName,
    });

    // Fan out one BullMQ job per batch. The M8.5 worker subscribes to
    // `enrich-batch`; it builds the prompt, calls the LLM, validates, and
    // upserts enrichments + emits batch-complete. M8.4 stops here.
    const queue = getQueue();
    for (const batch of batches) {
      await queue.add('enrich-batch', {
        jobId,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        chatId: ctx.chatId,
        userId: ctx.userId,
        articleIds: batch.articleIds,
        enrichmentType: ctx.enrichmentType,
        modelName: ctx.provider.config.modelName,
      });
    }

    // Reach mode also fans out the SimilarWeb fetch in parallel. M8.6 will
    // wire the SimilarWebAgent processor; M8.4 only enqueues the trigger.
    if (ctx.enrichmentType === 'reach') {
      await queue.add('reach-fetch', {
        jobId,
        chatId: ctx.chatId,
        userId: ctx.userId,
      });
    }

    return {
      jobId,
      batchCount: batches.length,
      totalArticles: ctx.articles.length,
      // The job row carries authoritative token totals; we don't surface
      // estimatedTokens through the act result to avoid double-counting.
      estimatedTokens: 0,
    };
  }

  async reflect(_resultIn: unknown): Promise<void> {
    // No-op in M8.4. Per-batch finalization (mark partial/completed once
    // the last batch acks) lives in M8.5 — the worker has the visibility
    // into batch outcomes that this method cannot reach until then.
  }

  /**
   * Singleton override — EnrichmentAgent has no row in the `agents` table,
   * so the BaseAgent default would violate the agent_logs.agent_id FK.
   * Mirror the M7.7 DataExtractAgent pattern. Lifecycle observability
   * flows through the `enrichment:*` WS events instead.
   */
  override async logAction(): Promise<void> {
    /* no-op — singleton has no agents-table row */
  }
}
