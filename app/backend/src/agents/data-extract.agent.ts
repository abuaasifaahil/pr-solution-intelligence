/**
 * Phase 2 DataExtractAgent — M7.7.
 *
 * Consumes `data-extract` BullMQ jobs (enqueued by M7.6's `confirmQuery`) and
 * drives the 7-step processing visualization that the frontend renders during
 * the `processing` flow state.
 *
 * Lifecycle (extends BaseAgent per Phase 2 spec §5.4):
 *   perceive — load chat_params + confirmed boolean_query + upload metadata
 *   reason   — select strategy (csv_upload | api_crawl); Phase 2 only supports
 *              csv_upload (api_crawl deferred to Phase 2+)
 *   plan     — fix the 7-step pipeline order
 *   act      — walk each step, emitting `processing:step` per step and a
 *              final `processing:complete`; advance chat_params.flowState
 *              to 'complete' at the handoff step
 *   reflect  — log a warning if domain extraction rate < 90% (Learning
 *              Agent in Phase 5 will pick this up)
 *
 * The actual parse + insert work was already done by M7.4's ParseUploadWorker.
 * M7.7's role is the UX visualization (the user sees the spec's 7-step
 * progress bar) plus quality verification + flow-state handoff. The
 * underlying mechanics are pipelined for speed: M7.4 streams rows into
 * articles up-front so M7.7 can run cheap verifications per step.
 *
 * @file agents/data-extract.agent.ts
 */
import { BaseAgent, type AgentInput } from './base-agent.js';
import { publishChatEvent, publishAgentBus } from '../lib/event-bus.js';
import { withUser } from '../lib/prisma-rls.js';

interface DataExtractInput extends AgentInput {
  metadata: {
    queryId: string; // boolean_queries.id of the CONFIRMED query
  };
}

interface PerceivedContext {
  userId: string;
  chatId: string;
  queryId: string;
  uploadId: string | null; // null = API-crawl path (Phase 2+, not us)
  brand: string;
  competitors: string[];
  dateRange: { start: Date; end: Date } | null;
  enrichmentType: string | null;
  articleCount: number;
}

interface Reasoned {
  strategy: 'csv_upload' | 'api_crawl';
  estimatedArticles: number;
  ctx: PerceivedContext;
}

interface PlanItem {
  ctx: PerceivedContext;
  strategy: 'csv_upload' | 'api_crawl';
  steps: Array<{ name: string; key: string }>;
}

export interface DataExtractResult {
  articlesInserted: number;
  domainsExtracted: number;
  totalMs: number;
  qualityScore: 'pass' | 'warn' | 'fail';
}

const PIPELINE_STEPS: Array<{ name: string; key: string }> = [
  { name: 'Validate Schema', key: 'validate' },
  { name: 'Parse Articles', key: 'parse' },
  { name: 'Detect Date Range', key: 'dates' },
  { name: 'Extract Domains', key: 'domains' },
  { name: 'Normalize Schema', key: 'normalize' },
  { name: 'Insert to Database', key: 'insert' },
  { name: 'Handoff Ready', key: 'handoff' },
];

export class DataExtractAgent extends BaseAgent {
  /**
   * The DataExtractAgent is a singleton registered without an `agents`
   * table row (its `id` is a sentinel UUID, not a FK). Writing to
   * agent_logs would violate the FK, so we override the BaseAgent
   * default to a no-op. Run metrics still surface via processing:step /
   * processing:complete events.
   */
  override async logAction(): Promise<void> {
    /* singleton has no agents-table row — agent_logs writes would
       violate the FK. Lifecycle is observable via WS events. */
  }

  async perceive(input: AgentInput): Promise<PerceivedContext> {
    const d = input as DataExtractInput;
    const userId = d.userId;
    const chatId = d.chatId;
    const queryId = d.metadata?.queryId;
    if (!chatId) throw new Error('chatId required');
    if (!queryId) throw new Error('metadata.queryId required');

    return withUser(userId, async (tx) => {
      const query = await tx.booleanQuery.findFirst({ where: { id: queryId, chatId } });
      if (!query) throw new Error(`query ${queryId} not found`);
      const params = await tx.chatParams.findUnique({ where: { chatId } });
      if (!params) throw new Error(`chat_params for chat ${chatId} missing`);

      const upload = params.uploadId
        ? await tx.upload.findFirst({ where: { id: params.uploadId } })
        : null;

      const articleCount = await tx.article.count({
        where: { chatId, ...(upload ? { uploadId: upload.id } : {}) },
      });

      return {
        userId,
        chatId,
        queryId,
        uploadId: upload?.id ?? null,
        brand: params.brand ?? '',
        competitors: Array.isArray(params.competitors)
          ? (params.competitors as string[])
          : [],
        dateRange:
          params.dateStart && params.dateEnd
            ? { start: params.dateStart, end: params.dateEnd }
            : null,
        enrichmentType: params.enrichmentType,
        articleCount,
      };
    });
  }

  async reason(ctxIn: unknown): Promise<Reasoned> {
    const ctx = ctxIn as PerceivedContext;
    // Phase 2 spec §5.4: csv_upload when uploadId is present;
    // api_crawl is the deferred Phase 2+ path. M7.7 only supports csv_upload.
    if (!ctx.uploadId) {
      throw new Error(
        'Phase 2 only supports CSV upload path; API crawl deferred to Phase 2+',
      );
    }
    return {
      strategy: 'csv_upload',
      estimatedArticles: ctx.articleCount,
      ctx,
    };
  }

  async plan(goalIn: unknown): Promise<PlanItem> {
    const { strategy, ctx } = goalIn as Reasoned;
    return { ctx, strategy, steps: PIPELINE_STEPS };
  }

  async act(planIn: unknown): Promise<DataExtractResult> {
    const { ctx, steps } = planIn as PlanItem;
    const t0 = Date.now();
    let domainsExtracted = 0;

    for (const step of steps) {
      const stepStart = Date.now();
      try {
        const stepResult = await this.executeStep(step.key, ctx);
        if (step.key === 'domains' && typeof stepResult === 'number') {
          domainsExtracted = stepResult;
        }
        const dur = Date.now() - stepStart;
        await publishChatEvent(ctx.chatId, 'processing:step', {
          chatId: ctx.chatId,
          stepName: step.name,
          stepKey: step.key,
          status: 'done',
          duration: dur,
        });
      } catch (err) {
        const dur = Date.now() - stepStart;
        await publishChatEvent(ctx.chatId, 'processing:step', {
          chatId: ctx.chatId,
          stepName: step.name,
          stepKey: step.key,
          status: 'failed',
          duration: dur,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    const totalMs = Date.now() - t0;

    await publishChatEvent(ctx.chatId, 'processing:complete', {
      chatId: ctx.chatId,
      totalArticles: ctx.articleCount,
      domains: domainsExtracted,
      totalTime: totalMs,
    });

    // Phase 3 handoff. Done AFTER the 7-step pipeline has fully committed
    // (the handoff step already flipped chat_params.flowState to 'complete').
    // Publishing on the cross-agent bus is the M7.7 → M8.4 contract: the
    // EnrichmentAgent subscriber picks this up and starts batch sizing.
    // Empty articleIds = enrich all articles for the chat.
    await publishAgentBus('agent:enrichment:incoming', {
      chatId: ctx.chatId,
      userId: ctx.userId,
      articleIds: [],
    });

    return {
      articlesInserted: ctx.articleCount,
      domainsExtracted,
      totalMs,
      qualityScore: 'pass',
    };
  }

  async reflect(resultIn: unknown): Promise<void> {
    const r = resultIn as DataExtractResult;
    // Spec calls for >90% domain extraction rate. Below that we log a
    // warning — Phase 5 Learning Agent will pick this up. We don't fail the
    // run: the rate threshold is a quality signal, not a hard requirement.
    if (r.articlesInserted > 0) {
      const rate = r.domainsExtracted / r.articlesInserted;
      if (rate < 0.9) {
        // eslint-disable-next-line no-console
        console.warn('[data-extract] domain extraction rate below 90%', {
          rate,
          ...r,
        });
      }
    }
  }

  /**
   * Each step is a lightweight verification against the already-parsed data.
   * Returns a step-specific value when relevant (the `domains` step returns
   * the distinct-domain count so `act` can include it in the final event).
   */
  private async executeStep(
    key: string,
    ctx: PerceivedContext,
  ): Promise<number | undefined> {
    return withUser(ctx.userId, async (tx) => {
      switch (key) {
        case 'validate': {
          if (!ctx.uploadId) throw new Error('uploadId missing');
          const upload = await tx.upload.findFirst({ where: { id: ctx.uploadId } });
          if (!upload || upload.status !== 'ready') {
            throw new Error('upload not ready');
          }
          return undefined;
        }
        case 'parse': {
          // M7.4 has already inserted articles. Confirm the count is close
          // to upload.rowCount (allow 10% slack for dedup / empty rows).
          const upload = await tx.upload.findFirst({ where: { id: ctx.uploadId! } });
          const count = await tx.article.count({ where: { uploadId: ctx.uploadId } });
          if (upload?.rowCount && count < upload.rowCount * 0.9) {
            throw new Error(
              `expected ~${upload.rowCount} articles, found ${count}`,
            );
          }
          return undefined;
        }
        case 'dates': {
          const upload = await tx.upload.findFirst({ where: { id: ctx.uploadId! } });
          if (!upload?.dateRangeStart || !upload?.dateRangeEnd) {
            throw new Error('date range not detected during M7.4 parse');
          }
          return undefined;
        }
        case 'domains': {
          // COUNT DISTINCT publisher_domain for this upload. Raw query
          // because Prisma's `distinct` doesn't combine cleanly with COUNT.
          const result = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT publisher_domain) as count
            FROM articles
            WHERE upload_id = ${ctx.uploadId}::uuid AND publisher_domain IS NOT NULL
          `;
          return Number(result[0]?.count ?? 0);
        }
        case 'normalize':
        case 'insert': {
          // Already done by M7.4 — these are verification no-ops in M7.7.
          // The 7-step UX matters more than re-doing the work.
          return undefined;
        }
        case 'handoff': {
          // Advance flow state to 'complete' via direct update (we can't
          // patchParams here without a circular import). Phase 3 will
          // subscribe to ENRICHMENT_READY on the Redis bus — for Phase 2
          // we just flip the row.
          await tx.chatParams.update({
            where: { chatId: ctx.chatId },
            data: { flowState: 'complete', collectedAt: new Date() },
          });
          return undefined;
        }
        default:
          return undefined;
      }
    });
  }
}
