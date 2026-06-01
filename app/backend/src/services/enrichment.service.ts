/**
 * Phase 3 Enrichment service — M8.7.
 *
 * Read-side helpers + the dashboard JSON aggregator. The write-side is
 * still owned by the EnrichmentAgent (M8.4) + EnrichBatchWorker (M8.5) +
 * SimilarWebAgent (M8.6); this module just surfaces the resulting data
 * through the REST endpoints and computes the aggregate JSON that
 * Phase 4 consumes directly.
 *
 *   getLatestJobStatus    — job row + batches + progress + reach coverage
 *   listEnrichedArticles  — paginated article + enrichment join
 *   buildDashboardJson    — full dashboard-ready aggregated JSON
 *   buildSummary          — lightweight aggregations
 *   retryFailedBatches    — re-enqueue all 'failed' batches for the latest job
 *   enqueueManualEnrich   — publish to agent:enrichment:incoming
 *
 * All DB access is RLS-scoped via `withUser`. reach_cache reads do NOT
 * pass through withUser (global table per M8.6).
 *
 * @file services/enrichment.service.ts
 */
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { publishAgentBus } from '../lib/event-bus.js';
import { getQueue } from '../lib/queue.js';

// ───────────────────────────────────────────────────────────────────────
// Shape types — exposed as Phase 4 contracts. Intentionally use simple
// JSON-serializable structures (no Prisma Decimal / BigInt leak).
// ───────────────────────────────────────────────────────────────────────

export interface SocialEngagement {
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  engagement_rate?: number;
  saves?: number;
  reach?: number;
}

export interface DashboardArticle {
  id: string;
  title: string;
  content: string | null;
  description: string | null;
  url: string | null;
  publisherDomain: string | null;
  source: string | null;
  author: string | null;
  publishedDate: string | null;
  language: string;
  mediaType: unknown;
  location: unknown;
  thumbnailUrl: unknown;
  socialEngagement: SocialEngagement | null;
  enrichment: {
    sentiment: unknown;
    themes: unknown;
    emotion: unknown;
    entities: unknown;
    signals: unknown;
    reach: unknown;
  } | null;
}

export interface DashboardJson {
  chatId: string;
  jobId: string;
  generatedAt: string;
  analysisContext: {
    brand: string | null;
    competitors: unknown;
    dateRange: { start: string; end: string } | null;
    enrichmentType: string;
    modelUsed: string;
  };
  articles: DashboardArticle[];
  stats: {
    totalArticles: number;
    enrichedCount: number;
    sentimentDistribution: { positive: number; neutral: number; negative: number };
  };
}

export interface EnrichmentSummary {
  totalArticles: number;
  sentimentDistribution: { positive: number; neutral: number; negative: number };
  topThemes: Array<{ name: string; count: number; level: 'main' | 'secondary' | 'tertiary' }>;
  topEntities: Array<{ name: string; type: string; count: number }>;
  topSignals: Array<{ type: string; count: number }>;
  reachStats?: {
    totalDomains: number;
    resolved: number;
    avgScore: number;
    topDomains: Array<{ domain: string; monthly_visitors: number | null; score: number | null }>;
  };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers — defensive raw_data extraction.
// ───────────────────────────────────────────────────────────────────────

function getRaw<T>(rawData: unknown, key: string, fallback: T): T | unknown {
  if (rawData && typeof rawData === 'object' && key in rawData) {
    return (rawData as Record<string, unknown>)[key];
  }
  return fallback;
}

/**
 * Extract a SocialEngagement object from an article's raw_data column.
 * Only included when at least one numeric engagement field is present;
 * otherwise we surface the persisted enrichments.socialEngagement (which
 * may have been parsed off article content by the LLM).
 */
function extractSocialEngagement(rawData: unknown): SocialEngagement | null {
  if (!rawData || typeof rawData !== 'object') return null;
  const r = rawData as Record<string, unknown>;
  const numericKeys = [
    'likes',
    'comments',
    'shares',
    'impressions',
    'engagement_rate',
    'saves',
    'reach',
  ];
  const hasAny = numericKeys.some((k) => typeof r[k] === 'number');
  if (!hasAny) return null;
  const out: SocialEngagement = {};
  if (typeof r.likes === 'number') out.likes = r.likes;
  if (typeof r.comments === 'number') out.comments = r.comments;
  if (typeof r.shares === 'number') out.shares = r.shares;
  if (typeof r.impressions === 'number') out.impressions = r.impressions;
  if (typeof r.engagement_rate === 'number') out.engagement_rate = r.engagement_rate;
  if (typeof r.saves === 'number') out.saves = r.saves;
  if (typeof r.reach === 'number') out.reach = r.reach;
  return out;
}

function toInputJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

// ───────────────────────────────────────────────────────────────────────
// Manual trigger — publish to the cross-agent bus.
// ───────────────────────────────────────────────────────────────────────

/**
 * Verify the chat is owned, articles are present + flow has reached
 * `complete` (DataExtractAgent finished), then publish to the
 * `agent:enrichment:incoming` channel. The subscriber (M8.4) picks this
 * up and the EnrichmentAgent writes the job row.
 *
 * Throws:
 *   'Chat not found'                          — RLS miss
 *   'Articles not yet extracted'              — flowState !== 'complete'
 */
export async function enqueueManualEnrich(
  userId: string,
  chatId: string,
  enrichmentType?: 'standard' | 'reach',
): Promise<{ message: 'enqueued'; enrichmentType: 'standard' | 'reach' }> {
  const resolvedType = await withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');
    const params = await tx.chatParams.findUnique({ where: { chatId } });
    if (!params || params.flowState !== 'complete') {
      throw new Error('Articles not yet extracted');
    }
    return (
      enrichmentType ??
      (params.enrichmentType === 'reach' ? 'reach' : 'standard')
    );
  });

  await publishAgentBus('agent:enrichment:incoming', {
    chatId,
    userId,
    articleIds: [],
    enrichmentType: resolvedType,
  });

  return { message: 'enqueued', enrichmentType: resolvedType };
}

// ───────────────────────────────────────────────────────────────────────
// Status — latest job + batches + progress.
// ───────────────────────────────────────────────────────────────────────

export interface JobStatusResult {
  job: unknown | null;
  batches: Array<{
    batchNumber: number;
    status: string;
    retryCount: number;
    estimatedTokens: number;
    actualTokensIn: number | null;
    actualTokensOut: number | null;
    processingMs: number | null;
    error: string | null;
  }>;
  progress: { processed: number; total: number; percent: number };
  reachCoverage?: { resolved: number; total: number; percent: number };
}

export async function getLatestJobStatus(
  userId: string,
  chatId: string,
): Promise<JobStatusResult> {
  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');

    const job = await tx.enrichmentJob.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) {
      return {
        job: null,
        batches: [],
        progress: { processed: 0, total: 0, percent: 0 },
      };
    }

    const batches = await tx.enrichmentBatch.findMany({
      where: { jobId: job.id },
      orderBy: { batchNumber: 'asc' },
    });

    const percent =
      job.totalArticles > 0
        ? Math.floor((job.processedCount / job.totalArticles) * 100)
        : 0;

    const result: JobStatusResult = {
      job,
      batches: batches.map((b) => ({
        batchNumber: b.batchNumber,
        status: b.status,
        retryCount: b.retryCount,
        estimatedTokens: b.estimatedTokens,
        actualTokensIn: b.actualTokensIn,
        actualTokensOut: b.actualTokensOut,
        processingMs: b.processingMs,
        error: b.error,
      })),
      progress: {
        processed: job.processedCount,
        total: job.totalArticles,
        percent,
      },
    };

    if (job.enrichmentType === 'reach') {
      const enrichments = await tx.enrichment.findMany({
        where: { chatId },
        select: { reach: true },
      });
      const resolved = enrichments.filter((e) => e.reach != null).length;
      const total = enrichments.length;
      result.reachCoverage = {
        resolved,
        total,
        percent: total > 0 ? Math.round((resolved / total) * 100) : 0,
      };
    }

    return result;
  });
}

// ───────────────────────────────────────────────────────────────────────
// Paginated result.
// ───────────────────────────────────────────────────────────────────────

export interface ListEnrichedArticlesResult {
  articles: Array<{
    id: string;
    title: string;
    content: string | null;
    description: string | null;
    source: string | null;
    author: string | null;
    publishedDate: string | null;
    url: string | null;
    publisherDomain: string | null;
    language: string;
    socialEngagement: SocialEngagement | null;
    enrichment: {
      sentiment: unknown;
      themes: unknown;
      emotion: unknown;
      entities: unknown;
      signals: unknown;
      reach: unknown;
      modelUsed: string;
      tokensInput: number;
      tokensOutput: number;
      processingMs: number;
    } | null;
  }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listEnrichedArticles(
  userId: string,
  chatId: string,
  page: number,
  pageSize: number,
): Promise<ListEnrichedArticlesResult> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.min(200, Math.max(1, Math.floor(pageSize) || 50));

  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');

    const total = await tx.article.count({ where: { chatId } });
    const articles = await tx.article.findMany({
      where: { chatId },
      include: { enrichment: true },
      orderBy: [{ publishedDate: 'desc' }, { id: 'asc' }],
      skip: (safePage - 1) * safeSize,
      take: safeSize,
    });

    return {
      articles: articles.map((a) => {
        const e = a.enrichment;
        const validEnrichment = e && e.isValid;
        const socialFromRaw = extractSocialEngagement(a.rawData);
        // Prefer raw_data social engagement when present, fall back to
        // whatever the LLM parsed into enrichments.socialEngagement.
        const socialEngagement: SocialEngagement | null =
          socialFromRaw ?? (e?.socialEngagement as SocialEngagement | null) ?? null;

        return {
          id: a.id,
          title: a.title,
          content: a.content,
          description: a.description,
          source: a.source,
          author: a.author,
          publishedDate: a.publishedDate?.toISOString() ?? null,
          url: a.url,
          publisherDomain: a.publisherDomain,
          language: a.language,
          socialEngagement,
          enrichment: validEnrichment
            ? {
                sentiment: e!.sentiment,
                themes: e!.themes,
                emotion: e!.emotion,
                entities: e!.entities,
                signals: e!.signals,
                reach: e!.reach,
                modelUsed: e!.modelUsed,
                tokensInput: e!.tokensInput,
                tokensOutput: e!.tokensOutput,
                processingMs: e!.processingMs,
              }
            : null,
        };
      }),
      pagination: {
        page: safePage,
        pageSize: safeSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeSize)),
      },
    };
  });
}

// ───────────────────────────────────────────────────────────────────────
// Dashboard JSON aggregator — Phase 4 contract.
// ───────────────────────────────────────────────────────────────────────

/**
 * Compute the full dashboard JSON for a chat by joining articles +
 * enrichments + chat_params. Result is JSON-serializable (no Date / BigInt).
 * Callers (the /enrich/json route) persist it to enrichment_jobs.dashboardJson
 * to avoid re-computing on every read.
 *
 * Throws 'Chat not found' / 'No enrichment job for this chat'.
 */
export async function buildDashboardJson(
  userId: string,
  chatId: string,
): Promise<DashboardJson> {
  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');
    const params = await tx.chatParams.findUnique({ where: { chatId } });
    const job = await tx.enrichmentJob.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });
    if (!job) throw new Error('No enrichment job for this chat');

    const articles = await tx.article.findMany({
      where: { chatId },
      include: { enrichment: true },
      orderBy: [{ publishedDate: 'desc' }, { id: 'asc' }],
    });

    const dashboardArticles: DashboardArticle[] = articles.map((a) => {
      const e = a.enrichment;
      const validEnrichment = e && e.isValid;
      const socialFromRaw = extractSocialEngagement(a.rawData);
      const socialEngagement: SocialEngagement | null =
        socialFromRaw ?? (e?.socialEngagement as SocialEngagement | null) ?? null;

      return {
        id: a.id,
        title: a.title,
        content: a.content,
        description: a.description,
        url: a.url,
        publisherDomain: a.publisherDomain,
        source: a.source,
        author: a.author,
        publishedDate: a.publishedDate?.toISOString() ?? null,
        language: a.language,
        mediaType: getRaw(a.rawData, 'media_type', 'Online News'),
        location: getRaw(a.rawData, 'location', null),
        thumbnailUrl: getRaw(a.rawData, 'thumbnail_url', null),
        socialEngagement,
        enrichment: validEnrichment
          ? {
              sentiment: e!.sentiment,
              themes: e!.themes,
              emotion: e!.emotion,
              entities: e!.entities,
              signals: e!.signals,
              reach: e!.reach,
            }
          : null,
      };
    });

    const enrichedRows = dashboardArticles.filter((a) => a.enrichment != null);
    const sentimentDistribution = aggregateSentimentDistribution(enrichedRows);

    return {
      chatId,
      jobId: job.id,
      generatedAt: new Date().toISOString(),
      analysisContext: {
        brand: params?.brand ?? null,
        competitors: params?.competitors ?? [],
        dateRange:
          params?.dateStart && params?.dateEnd
            ? {
                start: params.dateStart.toISOString(),
                end: params.dateEnd.toISOString(),
              }
            : null,
        enrichmentType: job.enrichmentType,
        modelUsed: job.modelUsed,
      },
      articles: dashboardArticles,
      stats: {
        totalArticles: dashboardArticles.length,
        enrichedCount: enrichedRows.length,
        sentimentDistribution,
      },
    };
  });
}

/**
 * Persist `dashboardJson` onto the latest enrichment_job for the chat.
 * Used by the /enrich/json route after a fresh compute, so subsequent
 * reads return the cached blob.
 */
export async function persistDashboardJson(
  userId: string,
  jobId: string,
  json: DashboardJson,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.enrichmentJob.update({
      where: { id: jobId },
      data: { dashboardJson: toInputJson(json) },
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Summary aggregator.
// ───────────────────────────────────────────────────────────────────────

interface ThemeShape {
  name?: unknown;
  level?: unknown;
}
interface EntityShape {
  name?: unknown;
  type?: unknown;
}
interface SignalShape {
  type?: unknown;
}
interface SentimentShape {
  overall?: unknown;
  score?: unknown;
}

function aggregateSentimentDistribution(
  rows: Array<{ enrichment: { sentiment: unknown } | null }>,
): { positive: number; neutral: number; negative: number } {
  const dist = { positive: 0, neutral: 0, negative: 0 };
  for (const r of rows) {
    const s = r.enrichment?.sentiment as SentimentShape | null | undefined;
    if (!s) continue;
    const overall = typeof s.overall === 'string' ? s.overall.toLowerCase() : '';
    if (overall === 'positive') dist.positive += 1;
    else if (overall === 'negative') dist.negative += 1;
    else dist.neutral += 1;
  }
  return dist;
}

export async function buildSummary(
  userId: string,
  chatId: string,
): Promise<EnrichmentSummary> {
  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');

    const enrichments = await tx.enrichment.findMany({
      where: { chatId, isValid: true },
      include: { article: { select: { publisherDomain: true } } },
    });

    const sentimentDistribution = aggregateSentimentDistribution(
      enrichments.map((e) => ({ enrichment: { sentiment: e.sentiment } })),
    );

    // Themes — themes JSONB shape: { main: ThemeEntry[], secondary: [], tertiary: [] }
    type Tally<K extends string> = Map<string, { count: number; extra: K }>;
    const themesTally: Tally<'main' | 'secondary' | 'tertiary'> = new Map();
    for (const e of enrichments) {
      const t = e.themes as Record<string, unknown> | null;
      if (!t) continue;
      for (const level of ['main', 'secondary', 'tertiary'] as const) {
        const arr = t[level];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          const name =
            typeof item === 'string'
              ? item
              : ((item as ThemeShape).name as string | undefined);
          if (!name || typeof name !== 'string') continue;
          const key = `${level}::${name}`;
          const existing = themesTally.get(key);
          if (existing) existing.count += 1;
          else themesTally.set(key, { count: 1, extra: level });
        }
      }
    }
    const topThemes = Array.from(themesTally.entries())
      .map(([key, val]) => {
        const name = key.slice(key.indexOf('::') + 2);
        return { name, count: val.count, level: val.extra };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Entities — entities JSONB shape: { person: [], organization: [], ... }
    const entitiesTally = new Map<string, { type: string; count: number }>();
    for (const e of enrichments) {
      const ent = e.entities as Record<string, unknown> | null;
      if (!ent) continue;
      for (const [type, arr] of Object.entries(ent)) {
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          const name =
            typeof item === 'string'
              ? item
              : ((item as EntityShape).name as string | undefined);
          if (!name || typeof name !== 'string') continue;
          const key = `${type}::${name}`;
          const existing = entitiesTally.get(key);
          if (existing) existing.count += 1;
          else entitiesTally.set(key, { type, count: 1 });
        }
      }
    }
    const topEntities = Array.from(entitiesTally.entries())
      .map(([key, val]) => ({
        name: key.slice(key.indexOf('::') + 2),
        type: val.type,
        count: val.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Signals — array of { type, description, reason }
    const signalsTally = new Map<string, number>();
    for (const e of enrichments) {
      const sigs = e.signals as unknown[];
      if (!Array.isArray(sigs)) continue;
      for (const sig of sigs) {
        const type = (sig as SignalShape | undefined)?.type;
        if (typeof type !== 'string') continue;
        signalsTally.set(type, (signalsTally.get(type) ?? 0) + 1);
      }
    }
    const topSignals = Array.from(signalsTally.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    const summary: EnrichmentSummary = {
      totalArticles: enrichments.length,
      sentimentDistribution,
      topThemes,
      topEntities,
      topSignals,
    };

    // Reach stats — only when any enrichment carries a non-null reach blob.
    const reachRows = enrichments.filter((e) => e.reach != null);
    if (reachRows.length > 0) {
      const domains = new Set<string>();
      let scoreSum = 0;
      let scoreCount = 0;
      const byDomain = new Map<
        string,
        { monthly_visitors: number | null; score: number | null }
      >();
      for (const r of reachRows) {
        const reach = r.reach as Record<string, unknown> | null;
        if (!reach) continue;
        const domain =
          typeof reach.domain === 'string'
            ? reach.domain
            : r.article.publisherDomain ?? null;
        if (!domain) continue;
        domains.add(domain);
        const mv =
          typeof reach.monthly_visitors === 'number'
            ? reach.monthly_visitors
            : null;
        const sc = typeof reach.score === 'number' ? reach.score : null;
        if (sc != null) {
          scoreSum += sc;
          scoreCount += 1;
        }
        if (!byDomain.has(domain)) {
          byDomain.set(domain, { monthly_visitors: mv, score: sc });
        }
      }
      const topDomains = Array.from(byDomain.entries())
        .map(([domain, val]) => ({
          domain,
          monthly_visitors: val.monthly_visitors,
          score: val.score,
        }))
        .sort((a, b) => (b.monthly_visitors ?? 0) - (a.monthly_visitors ?? 0))
        .slice(0, 10);

      summary.reachStats = {
        totalDomains: domains.size,
        resolved: reachRows.length,
        avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
        topDomains,
      };
    }

    return summary;
  });
}

// ───────────────────────────────────────────────────────────────────────
// Single article detail.
// ───────────────────────────────────────────────────────────────────────

export async function getArticleEnrichment(userId: string, articleId: string) {
  return withUser(userId, async (tx) => {
    const article = await tx.article.findFirst({
      where: { id: articleId },
      include: { enrichment: true },
    });
    if (!article) return null;
    return article;
  });
}

// ───────────────────────────────────────────────────────────────────────
// Retry failed batches for the latest job.
// ───────────────────────────────────────────────────────────────────────

export interface RetryResult {
  retriedBatches: number;
}

export async function retryFailedBatches(
  userId: string,
  chatId: string,
): Promise<RetryResult> {
  const job = await withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    if (!chat) throw new Error('Chat not found');
    return tx.enrichmentJob.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });
  });
  if (!job) throw new Error('No enrichment job for this chat');

  // Reset failed batches → pending, retryCount=0, error=null.
  const failedBatches = await withUser(userId, async (tx) => {
    const rows = await tx.enrichmentBatch.findMany({
      where: { jobId: job.id, status: 'failed' },
    });
    for (const b of rows) {
      await tx.enrichmentBatch.update({
        where: { id: b.id },
        data: { status: 'pending', retryCount: 0, error: null },
      });
    }
    return rows;
  });

  // Re-enqueue. Pass an empty articleIds list — the worker reads them
  // off the persisted batch row, matching the M8.5 retry path semantics.
  const queue = getQueue();
  for (const b of failedBatches) {
    await queue.add('enrich-batch', {
      jobId: job.id,
      batchId: b.id,
      batchNumber: b.batchNumber,
      chatId,
      userId,
      articleIds: [],
      enrichmentType: job.enrichmentType,
      modelName: job.modelUsed,
    });
  }

  return { retriedBatches: failedBatches.length };
}
