/**
 * Phase 3 Reach service — M8.7.
 *
 *   getReachByDomain — global reach_cache lookup (no RLS — domain reach
 *                       is public data, shared across users by design)
 *   enqueueReachFetchForChat — manually re-trigger the SimilarWebAgent
 *                       pipeline for an existing enrichment_job
 *
 * reach_cache is intentionally NOT routed through `withUser` — it's the
 * one Phase 3 table that bypasses RLS. Documented divergence per spec.
 *
 * @file services/reach.service.ts
 */
import { prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { getQueue } from '../lib/queue.js';

/**
 * Look up the global reach_cache row for a domain. Returns null when no
 * row exists. Does NOT do freshness checks — the SimilarWebAgent owns
 * cache invalidation; this read is a passthrough for the dashboard.
 */
export async function getReachByDomain(domain: string) {
  const row = await prisma.reachCache.findUnique({ where: { domain } });
  if (!row) return null;
  return {
    domain: row.domain,
    monthlyVisitors: row.monthlyVisitors != null ? Number(row.monthlyVisitors) : null,
    globalRank: row.globalRank,
    category: row.category,
    score: row.score,
    rawResponse: row.rawResponse,
    fetchedAt: row.fetchedAt.toISOString(),
    ttlHours: row.ttlHours,
    isValid: row.isValid,
  };
}

export interface ReachFetchResult {
  jobId: string;
  domains: number;
}

/**
 * Manually re-trigger the SimilarWeb pipeline for the chat's most-recent
 * enrichment_job. The actual fetch + merge happens inside the reach-fetch
 * BullMQ processor → SimilarWebAgent. We just count DISTINCT domains
 * here for the response, then enqueue.
 *
 * Throws:
 *   'Chat not found'                  — RLS miss
 *   'No enrichment job for this chat' — must run enrichment first
 */
export async function enqueueReachFetchForChat(
  userId: string,
  chatId: string,
): Promise<ReachFetchResult> {
  const { job, domainCount } = await withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');
    const j = await tx.enrichmentJob.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });
    if (!j) throw new Error('No enrichment job for this chat');
    const rows = await tx.article.findMany({
      where: { chatId, publisherDomain: { not: null } },
      select: { publisherDomain: true },
      distinct: ['publisherDomain'],
    });
    return { job: j, domainCount: rows.length };
  });

  await getQueue().add('reach-fetch', {
    jobId: job.id,
    chatId,
    userId,
  });

  return { jobId: job.id, domains: domainCount };
}
