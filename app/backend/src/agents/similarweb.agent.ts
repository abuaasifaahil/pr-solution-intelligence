/**
 * Phase 3 SimilarWebAgent — M8.6.
 *
 * Singleton BaseAgent that owns the parallel reach-enrichment pipeline.
 * Triggered by M8.4's EnrichmentAgent when `enrichmentType='reach'` — a
 * single `reach-fetch` BullMQ job lands alongside the per-batch
 * `enrich-batch` jobs. The two pipelines run independently:
 *
 *   `enrichment:complete`       — LLM enrichment done   (M8.5)
 *   `enrichment:reach-start`    — reach fan-out begins  (HERE)
 *   `enrichment:reach-complete` — reach merge done      (HERE)
 *
 * Lifecycle:
 *   perceive — SELECT DISTINCT publisher_domain FROM articles WHERE chat_id;
 *              resolve the user's SimilarWeb API key (M5 data_sources →
 *              env fallback → null = skip uncached fetch)
 *   reason   — partition domains into cached / uncached against the GLOBAL
 *              reach_cache. A row is "cached" iff is_valid AND
 *              fetched_at > now - ttl_hours.
 *   plan     — pass-through; reach_cache writes happen in act() so we can
 *              upsert each fetch result immediately rather than batching
 *              one big transaction (long external fetches don't belong in
 *              a Postgres transaction)
 *   act      — emit reach-start, fetch uncached via fetchSimilarWebBatch,
 *              upsert reach_cache, then merge cache rows into the
 *              chat's enrichments.reach JSONB, emit reach-complete with
 *              coverage stats (resolved / total).
 *   reflect  — log a warning when coverage < 95% on a non-empty job
 *              (the spec § "Goals" target). Doesn't fail the job.
 *
 * reach_cache is the FIRST Phase 3 table that intentionally bypasses RLS
 * — domain reach metrics are public and shared across all users to
 * maximize cache hit rate. We read/write it through the bare `prisma`
 * client (NOT withUser); the enrichments table is still per-user
 * RLS-scoped, so the merge step uses withUser.
 *
 * Singleton override mirrors M7.7 DataExtractAgent + M8.4 EnrichmentAgent:
 * no agents-table row, `logAction` overridden to no-op. Lifecycle
 * observability flows through the `enrichment:reach-*` WS events.
 *
 * @file backend/src/agents/similarweb.agent.ts
 */
import { BaseAgent, type AgentInput } from './base-agent.js';
import { prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { publishChatEvent } from '../lib/event-bus.js';
import {
  fetchSimilarWebBatch,
  getSimilarWebKey,
} from '../lib/similarweb-client.js';
import type { Prisma } from '@prsi/shared/db';

/** Coerce arbitrary JS into Prisma's JSON input shape. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

interface SimilarWebInput extends AgentInput {
  metadata: { jobId: string };
}

interface PerceivedContext {
  userId: string;
  chatId: string;
  jobId: string;
  domains: string[];
  apiKey: string | null;
}

interface Reasoned extends PerceivedContext {
  cached: string[];
  uncached: string[];
}

interface ActResult {
  jobId: string;
  total: number;
  resolved: number;
  coveragePercent: number;
  durationMs: number;
}

/** Per spec § DB foundation: reach rows live for 7 days. Schema default
 *  already encodes this; we only use it for the in-process cache freshness
 *  check (the column value wins on writes). */
const REACH_TTL_HOURS_DEFAULT = 168;

export class SimilarWebAgent extends BaseAgent {
  async perceive(input: AgentInput): Promise<PerceivedContext> {
    const d = input as SimilarWebInput;
    const userId = d.userId;
    const chatId = d.chatId;
    if (!chatId) throw new Error('chatId required');
    const jobId = d.metadata?.jobId;
    if (!jobId) throw new Error('metadata.jobId required');

    // Load DISTINCT publisher_domains for the chat under RLS. getSimilarWebKey
    // does its own withUser; calling it inside this txn would nest needlessly.
    const domains = await withUser(userId, async (tx) => {
      const rows = await tx.article.findMany({
        where: { chatId, publisherDomain: { not: null } },
        select: { publisherDomain: true },
        distinct: ['publisherDomain'],
      });
      return rows
        .map((r) => r.publisherDomain)
        .filter((dom): dom is string => !!dom && dom.trim().length > 0);
    });

    const apiKey = await getSimilarWebKey(userId);

    return { userId, chatId, jobId, domains, apiKey };
  }

  async reason(ctxIn: unknown): Promise<Reasoned> {
    const ctx = ctxIn as PerceivedContext;
    if (ctx.domains.length === 0) return { ...ctx, cached: [], uncached: [] };

    // reach_cache is GLOBAL — use bare prisma, NOT withUser.
    const cached = await prisma.reachCache.findMany({
      where: { domain: { in: ctx.domains }, isValid: true },
    });
    const now = Date.now();
    const validCached = cached
      .filter((row) => {
        const ageMs = now - row.fetchedAt.getTime();
        const ttlMs = row.ttlHours * 60 * 60 * 1000;
        return ageMs < ttlMs;
      })
      .map((r) => r.domain);

    const cachedSet = new Set(validCached);
    const uncached = ctx.domains.filter((dom) => !cachedSet.has(dom));

    return { ...ctx, cached: validCached, uncached };
  }

  async plan(goalIn: unknown): Promise<Reasoned> {
    // No DB writes in plan — reach_cache writes are interleaved with each
    // fetch in act() so a stalled SimilarWeb call doesn't sit inside a
    // Postgres transaction.
    return goalIn as Reasoned;
  }

  async act(planIn: unknown): Promise<ActResult> {
    const ctx = planIn as Reasoned;
    const t0 = Date.now();

    await publishChatEvent(ctx.chatId, 'enrichment:reach-start', {
      jobId: ctx.jobId,
      chatId: ctx.chatId,
      domains: ctx.domains.length,
    });

    // Fetch + upsert uncached domains. Skip silently if no API key — we
    // still merge whatever cached rows exist so partial coverage flows.
    if (ctx.uncached.length > 0 && ctx.apiKey) {
      const fetched = await fetchSimilarWebBatch(ctx.uncached, ctx.apiKey);

      for (const r of fetched) {
        const hasData = r.monthly_visitors != null || r.global_rank != null;
        await prisma.reachCache.upsert({
          where: { domain: r.domain },
          create: {
            domain: r.domain,
            monthlyVisitors: r.monthly_visitors,
            globalRank: r.global_rank,
            category: r.category,
            score: r.score,
            rawResponse: toJson(r.raw),
            ttlHours: REACH_TTL_HOURS_DEFAULT,
            isValid: hasData,
          },
          update: {
            monthlyVisitors: r.monthly_visitors,
            globalRank: r.global_rank,
            category: r.category,
            score: r.score,
            rawResponse: toJson(r.raw),
            fetchedAt: new Date(),
            isValid: hasData,
          },
        });
      }
    }

    // Re-read the cache for the union of cached + freshly-fetched rows.
    // Filtering by `isValid: true` excludes 404s and failed fetches; those
    // domains simply don't get merged into enrichments.reach.
    const cacheRows = await prisma.reachCache.findMany({
      where: { domain: { in: ctx.domains }, isValid: true },
    });
    const byDomain = new Map(cacheRows.map((r) => [r.domain, r]));

    // Merge reach into per-article enrichments.reach JSONB. Each article's
    // publisher_domain → cache row → { domain, monthly_visitors, score }.
    await withUser(ctx.userId, async (tx) => {
      const enrichments = await tx.enrichment.findMany({
        where: { chatId: ctx.chatId },
        include: { article: { select: { publisherDomain: true } } },
      });

      for (const e of enrichments) {
        const domain = e.article.publisherDomain;
        if (!domain) continue;
        const cache = byDomain.get(domain);
        if (!cache) continue;
        await tx.enrichment.update({
          where: { id: e.id },
          data: {
            reach: toJson({
              domain: cache.domain,
              monthly_visitors:
                cache.monthlyVisitors != null
                  ? Number(cache.monthlyVisitors)
                  : null,
              score: cache.score,
            }),
          },
        });
      }
    });

    const durationMs = Date.now() - t0;
    const coveragePercent =
      ctx.domains.length === 0
        ? 100
        : Math.round((cacheRows.length / ctx.domains.length) * 100);

    await publishChatEvent(ctx.chatId, 'enrichment:reach-complete', {
      jobId: ctx.jobId,
      resolved: cacheRows.length,
      total: ctx.domains.length,
      coverage: coveragePercent,
      duration: durationMs,
    });

    return {
      jobId: ctx.jobId,
      total: ctx.domains.length,
      resolved: cacheRows.length,
      coveragePercent,
      durationMs,
    };
  }

  async reflect(resultIn: unknown): Promise<void> {
    const r = resultIn as ActResult;
    if (r.total > 0 && r.coveragePercent < 95) {
      // Spec § Goals targets 95%+ domain coverage. Below that warrants a
      // warning but never a hard failure — partial coverage is still useful.
      // eslint-disable-next-line no-console
      console.warn('[similarweb-agent] coverage below 95%', r);
    }
  }

  /**
   * Singleton override — SimilarWebAgent has no row in the `agents` table,
   * so the BaseAgent default would violate the agent_logs.agent_id FK.
   * Mirrors M7.7 DataExtractAgent + M8.4 EnrichmentAgent. Observability
   * flows through the `enrichment:reach-*` WS events.
   */
  override async logAction(): Promise<void> {
    /* no-op — singleton has no agents-table row */
  }
}
