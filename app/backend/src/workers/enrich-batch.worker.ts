/**
 * BullMQ processor for `enrich-batch` jobs — M8.5.
 *
 * One job = one batch. Consumes the jobs M8.4's EnrichmentAgent enqueues on
 * `act()`. The processor owns:
 *
 *   1. UPDATE enrichment_batches SET status='processing'
 *      + publish enrichment:batch-start
 *   2. SELECT articles for the batch
 *   3. buildEnrichmentMessages(articles)            — M8.3
 *   4. provider.complete(messages, jsonMode=true)   — M8.2
 *   5. validateJSON(text, EnrichmentBatchResponseSchema) — M8.2 + M8.3
 *   6. Upsert enrichments rows (one per articleId in the batch)
 *   7. UPDATE enrichment_batches SET status='completed', actual tokens,
 *      processing_ms
 *      + publish enrichment:batch-complete
 *   8. UPDATE parent enrichment_jobs counters (processed_count,
 *      batches_completed, total_tokens_*); publish enrichment:progress
 *   9. When this is the LAST batch (batches_completed >= batch_count),
 *      finalize the job: status='completed' | 'partial' | 'failed' based on
 *      per-batch outcomes; publish enrichment:complete.
 *
 * Retry policy — MAX_RETRIES=2 (so up to three attempts per batch):
 *   - failure increments enrichment_batches.retry_count, sets error, and
 *     publishes enrichment:batch-error with retrying=true while count ≤ 2
 *   - on retry path the worker re-enqueues the same `enrich-batch` job; we
 *     deliberately do NOT re-throw, so the BullMQ queue does not also try
 *     to retry the SAME attempt (which would double-fire). One retry path,
 *     in-band, controlled here.
 *   - on the third+ failure we mark status='failed', publish batch-error
 *     with retrying=false, and still advance the parent job's
 *     batches_completed so the finalizer fires (jobs go 'partial' instead
 *     of hanging forever in 'processing').
 *
 * Article load is RLS-scoped via withUser, but the per-batch job carries
 * its own userId in the BullMQ payload because the worker has no auth
 * context of its own.
 *
 * @file backend/src/workers/enrich-batch.worker.ts
 */
import type { Processor } from 'bullmq';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { getModel, validateJSON } from '../lib/llm-gateway.js';
import {
  buildEnrichmentMessages,
  type PromptArticle,
} from '../lib/enrichment-prompt.js';
import {
  EnrichmentBatchResponseSchema,
  type ArticleEnrichment,
} from '../lib/enrichment-schemas.js';
import { publishChatEvent } from '../lib/event-bus.js';
import { getQueue } from '../lib/queue.js';

/** Coerce arbitrary JS into Prisma's JSON input shape. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export interface EnrichBatchJobData {
  jobId: string;
  batchId: string;
  batchNumber: number;
  chatId: string;
  userId: string;
  articleIds: string[];
  enrichmentType: 'standard' | 'reach';
  modelName: string;
}

/**
 * Max retries per batch. retry_count starts at 0; we increment BEFORE the
 * compare, so retry_count==1 is the first retry, retry_count==2 the second,
 * and retry_count==3 is the give-up boundary (>MAX_RETRIES).
 */
const MAX_RETRIES = 2;

export const enrichBatchProcessor: Processor<EnrichBatchJobData> = async (job) => {
  const { jobId, batchId, batchNumber, chatId, userId, articleIds } = job.data;
  const tStart = Date.now();

  try {
    // ─── 1) Mark batch processing ───────────────────────────────────────
    await withUser(userId, async (tx) => {
      await tx.enrichmentBatch.update({
        where: { id: batchId },
        data: { status: 'processing' },
      });
    });

    await publishChatEvent(chatId, 'enrichment:batch-start', {
      jobId,
      batchNumber,
      articleCount: articleIds.length,
      // estimated_tokens is already stored on the batch row by M8.4; we
      // intentionally don't re-read it here just to echo it back.
      estimatedTokens: 0,
    });

    // ─── 2) Load articles ───────────────────────────────────────────────
    // On retries the original payload's articleIds may be empty (see
    // re-enqueue path in handleBatchFailure). In that case fall back to
    // the batch row's persisted article_ids.
    let effectiveIds = articleIds;
    if (effectiveIds.length === 0) {
      const batchRow = await withUser(userId, async (tx) =>
        tx.enrichmentBatch.findUnique({
          where: { id: batchId },
          select: { articleIds: true },
        }),
      );
      effectiveIds = batchRow?.articleIds ?? [];
    }

    const articles = await withUser(userId, async (tx) =>
      tx.article.findMany({
        where: { id: { in: effectiveIds }, chatId },
        select: {
          id: true,
          title: true,
          content: true,
          description: true,
          source: true,
          author: true,
          url: true,
          publisherDomain: true,
          publishedDate: true,
          language: true,
        },
      }),
    );

    if (articles.length === 0) {
      throw new Error(
        `batch ${batchId}: no articles loaded (deleted or RLS mismatch)`,
      );
    }

    const promptArticles: PromptArticle[] = articles.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      description: a.description,
      source: a.source,
      author: a.author,
      url: a.url,
      publisherDomain: a.publisherDomain,
      publishedDate: a.publishedDate,
      language: a.language,
    }));

    // ─── 3-5) Build prompt → complete → validate ───────────────────────
    const messages = buildEnrichmentMessages(promptArticles);
    const provider = await getModel(userId);
    const completion = await provider.complete({
      messages,
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 8_000,
    });

    const validation = validateJSON(completion.text, EnrichmentBatchResponseSchema);
    if (!validation.valid) {
      throw new Error(
        `schema validation failed: ${validation.errors.join('; ')}`,
      );
    }
    const enrichments: ArticleEnrichment[] = validation.data.articles;

    // ─── 6) Upsert enrichments rows ─────────────────────────────────────
    const tokensInPerArticle = Math.floor(
      completion.tokensInput / Math.max(enrichments.length, 1),
    );
    const tokensOutPerArticle = Math.floor(
      completion.tokensOutput / Math.max(enrichments.length, 1),
    );

    await withUser(userId, async (tx) => {
      for (const e of enrichments) {
        await tx.enrichment.upsert({
          where: { articleId: e.articleId },
          create: {
            articleId: e.articleId,
            chatId,
            userId,
            batchId,
            sentiment: toJson(e.sentiment),
            themes: toJson(e.themes),
            emotion: toJson(e.emotion),
            entities: toJson(e.entities),
            signals: toJson(e.signals),
            socialEngagement: e.social_engagement
              ? toJson(e.social_engagement)
              : undefined,
            modelUsed: completion.model,
            tokensInput: tokensInPerArticle,
            tokensOutput: tokensOutPerArticle,
            processingMs: completion.durationMs,
            isValid: true,
          },
          update: {
            batchId,
            sentiment: toJson(e.sentiment),
            themes: toJson(e.themes),
            emotion: toJson(e.emotion),
            entities: toJson(e.entities),
            signals: toJson(e.signals),
            socialEngagement: e.social_engagement
              ? toJson(e.social_engagement)
              : undefined,
            modelUsed: completion.model,
            tokensInput: tokensInPerArticle,
            tokensOutput: tokensOutPerArticle,
            processingMs: completion.durationMs,
            isValid: true,
          },
        });
      }
    });

    // ─── 7) Mark batch complete ─────────────────────────────────────────
    const tElapsed = Date.now() - tStart;
    await withUser(userId, async (tx) => {
      await tx.enrichmentBatch.update({
        where: { id: batchId },
        data: {
          status: 'completed',
          actualTokensIn: completion.tokensInput,
          actualTokensOut: completion.tokensOutput,
          processingMs: tElapsed,
        },
      });
    });

    await publishChatEvent(chatId, 'enrichment:batch-complete', {
      jobId,
      batchNumber,
      processedCount: enrichments.length,
      tokensUsed: completion.tokensInput + completion.tokensOutput,
      duration: tElapsed,
    });

    // ─── 8 + 9) Update parent job counters; finalize on last batch ─────
    await finalizeJobProgress({
      jobId,
      userId,
      chatId,
      processedDelta: enrichments.length,
      tokensInDelta: completion.tokensInput,
      tokensOutDelta: completion.tokensOutput,
    });

    return { batchId, processedCount: enrichments.length };
  } catch (err) {
    const tElapsed = Date.now() - tStart;
    const errMsg = (err as Error).message.slice(0, 1000);
    await handleBatchFailure({
      jobId,
      batchId,
      batchNumber,
      chatId,
      userId,
      errMsg,
      tElapsed,
    });
    // We do NOT re-throw — failed batches are handled in-band so BullMQ
    // does not also try to retry this attempt (which would double-fire).
    // handleBatchFailure either re-enqueues (retry) or marks failed and
    // advances the parent finalizer.
    return { batchId, failed: true };
  }
};

interface ProgressDelta {
  jobId: string;
  userId: string;
  chatId: string;
  processedDelta: number;
  tokensInDelta: number;
  tokensOutDelta: number;
}

/**
 * Increment the parent enrichment_jobs counters atomically and emit a
 * progress event. If this was the LAST batch in the job
 * (batches_completed >= batch_count), call finalizeJob to write the final
 * status and emit enrichment:complete.
 */
async function finalizeJobProgress(d: ProgressDelta): Promise<void> {
  const updated = await withUser(d.userId, async (tx) => {
    return tx.enrichmentJob.update({
      where: { id: d.jobId },
      data: {
        processedCount: { increment: d.processedDelta },
        batchesCompleted: { increment: 1 },
        totalTokensInput: { increment: BigInt(d.tokensInDelta) },
        totalTokensOutput: { increment: BigInt(d.tokensOutDelta) },
      },
    });
  });

  const percent =
    updated.totalArticles > 0
      ? Math.floor((updated.processedCount / updated.totalArticles) * 100)
      : 0;

  await publishChatEvent(d.chatId, 'enrichment:progress', {
    jobId: d.jobId,
    processed: updated.processedCount,
    total: updated.totalArticles,
    percent,
    tokensTotal:
      Number(updated.totalTokensInput) + Number(updated.totalTokensOutput),
    elapsed: updated.startedAt ? Date.now() - updated.startedAt.getTime() : 0,
  });

  if (updated.batchesCompleted >= updated.batchCount) {
    await finalizeJob(d);
  }
}

/**
 * Read all batches for the job, derive final status from their per-batch
 * outcomes, write the enrichment_jobs row, and emit enrichment:complete.
 *
 *   completed — every batch is 'completed'
 *   failed    — every batch is 'failed'
 *   partial   — some completed, some failed (any other mix)
 */
async function finalizeJob(d: ProgressDelta): Promise<void> {
  const finalRow = await withUser(d.userId, async (tx) => {
    const batches = await tx.enrichmentBatch.findMany({
      where: { jobId: d.jobId },
      select: { status: true },
    });
    const failed = batches.filter((b) => b.status === 'failed').length;
    const status: 'completed' | 'partial' | 'failed' =
      failed === 0
        ? 'completed'
        : failed === batches.length
          ? 'failed'
          : 'partial';

    return tx.enrichmentJob.update({
      where: { id: d.jobId },
      data: { status, completedAt: new Date() },
    });
  });

  await publishChatEvent(d.chatId, 'enrichment:complete', {
    jobId: d.jobId,
    totalArticles: finalRow.totalArticles,
    totalTokens:
      Number(finalRow.totalTokensInput) + Number(finalRow.totalTokensOutput),
    duration:
      finalRow.completedAt && finalRow.startedAt
        ? finalRow.completedAt.getTime() - finalRow.startedAt.getTime()
        : 0,
    // 6 dimensions: sentiment, themes, emotion, entities, signals, +
    // social_engagement (where present).
    dimensions: 6,
    status: finalRow.status,
  });
}

interface FailureCtx {
  jobId: string;
  batchId: string;
  batchNumber: number;
  chatId: string;
  userId: string;
  errMsg: string;
  tElapsed: number;
}

/**
 * Failure path. Increments retry_count; if still ≤ MAX_RETRIES, re-enqueues
 * the same batch and marks status='retrying'. If exceeded, marks 'failed'
 * and STILL advances the parent job's batches_completed so the finalizer
 * fires (otherwise the job hangs in 'processing' forever).
 */
async function handleBatchFailure(c: FailureCtx): Promise<void> {
  const batch = await withUser(c.userId, async (tx) => {
    return tx.enrichmentBatch.update({
      where: { id: c.batchId },
      data: {
        retryCount: { increment: 1 },
        processingMs: c.tElapsed,
        error: c.errMsg,
      },
    });
  });

  const retrying = batch.retryCount <= MAX_RETRIES;

  await publishChatEvent(c.chatId, 'enrichment:batch-error', {
    jobId: c.jobId,
    batchNumber: c.batchNumber,
    error: c.errMsg,
    retrying,
    retryCount: batch.retryCount,
  });

  if (retrying) {
    await withUser(c.userId, async (tx) => {
      await tx.enrichmentBatch.update({
        where: { id: c.batchId },
        data: { status: 'retrying' },
      });
    });
    // Re-enqueue the SAME batch. We pass an empty articleIds list — the
    // worker falls back to reading them off the persisted batch row, so
    // we don't risk a stale snapshot diverging from the DB.
    await getQueue().add('enrich-batch', {
      jobId: c.jobId,
      batchId: c.batchId,
      batchNumber: c.batchNumber,
      chatId: c.chatId,
      userId: c.userId,
      articleIds: [],
      enrichmentType: 'standard',
      modelName: 'gpt-4.1',
    });
    return;
  }

  // Final failure — mark batch failed and advance the parent finalizer.
  await withUser(c.userId, async (tx) => {
    await tx.enrichmentBatch.update({
      where: { id: c.batchId },
      data: { status: 'failed' },
    });
  });
  await finalizeJobProgress({
    jobId: c.jobId,
    userId: c.userId,
    chatId: c.chatId,
    processedDelta: 0,
    tokensInDelta: 0,
    tokensOutDelta: 0,
  });
}
