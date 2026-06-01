/**
 * Phase 3 Enrichment REST endpoints — M8.7.
 *
 * Nine routes that expose the enrichment pipeline data to the frontend
 * and Phase 4 dashboard. All routes are auth-guarded with `app.auth`;
 * ownership is enforced via RLS in the service layer.
 *
 *   POST   /api/v1/chats/:id/enrich              manual trigger
 *   GET    /api/v1/chats/:id/enrich/status       job + batches + progress
 *   GET    /api/v1/chats/:id/enrich/result       paginated articles
 *   GET    /api/v1/chats/:id/enrich/json         full dashboard JSON
 *   GET    /api/v1/chats/:id/enrich/summary      aggregations
 *   GET    /api/v1/enrichments/:articleId        single article detail
 *   POST   /api/v1/chats/:id/reach/fetch         re-trigger reach
 *   GET    /api/v1/reach/cache/:domain           global reach lookup
 *   POST   /api/v1/chats/:id/enrich/retry        retry failed batches
 *
 * @file routes/enrichment.routes.ts
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  enqueueManualEnrich,
  getLatestJobStatus,
  listEnrichedArticles,
  buildDashboardJson,
  persistDashboardJson,
  buildSummary,
  getArticleEnrichment,
  retryFailedBatches,
  type DashboardJson,
} from '../services/enrichment.service.js';
import {
  enqueueReachFetchForChat,
  getReachByDomain,
} from '../services/reach.service.js';
import { publishChatEvent } from '../lib/event-bus.js';

const EnrichTriggerBody = z
  .object({
    enrichmentType: z.enum(['standard', 'reach']).optional(),
  })
  .optional()
  .nullable();

const ResultQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Map service-thrown error strings to HTTP status codes.
 * 'Chat not found' / 'No enrichment job for this chat' → 404.
 * 'Articles not yet extracted' → 400.
 * Anything else → 500.
 */
function statusForError(message: string): number {
  if (message === 'Chat not found') return 404;
  if (message === 'No enrichment job for this chat') return 404;
  if (message === 'Articles not yet extracted') return 400;
  return 500;
}

export async function enrichmentRoutes(app: FastifyInstance): Promise<void> {
  // ─── 1) POST /chats/:id/enrich ────────────────────────────────────────
  app.post(
    '/api/v1/chats/:id/enrich',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = EnrichTriggerBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
      }
      try {
        const result = await enqueueManualEnrich(
          req.user!.userId,
          id,
          parsed.data?.enrichmentType,
        );
        return {
          success: true,
          data: { jobId: null, message: result.message, enrichmentType: result.enrichmentType },
        };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 2) GET /chats/:id/enrich/status ──────────────────────────────────
  app.get(
    '/api/v1/chats/:id/enrich/status',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const status = await getLatestJobStatus(req.user!.userId, id);
        return { success: true, data: status };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 3) GET /chats/:id/enrich/result ──────────────────────────────────
  app.get(
    '/api/v1/chats/:id/enrich/result',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsedQ = ResultQuery.safeParse(req.query);
      if (!parsedQ.success) {
        reply.code(400);
        return { success: false, error: 'Invalid query', meta: parsedQ.error.flatten() };
      }
      try {
        const result = await listEnrichedArticles(
          req.user!.userId,
          id,
          parsedQ.data.page,
          parsedQ.data.pageSize,
        );
        return { success: true, data: result };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 4) GET /chats/:id/enrich/json ────────────────────────────────────
  // Cached-on-first-read: if enrichment_jobs.dashboardJson is already
  // populated, return it as-is. Otherwise compute, persist, emit the
  // enrichment:json-ready event, and return.
  app.get(
    '/api/v1/chats/:id/enrich/json',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        // First peek at the latest job. If dashboardJson is already there,
        // return it without recomputing. We piggy-back on getLatestJobStatus
        // to avoid a separate query — it already pulls the latest job.
        const status = await getLatestJobStatus(req.user!.userId, id);
        if (!status.job) {
          reply.code(404);
          return { success: false, error: 'No enrichment job for this chat' };
        }
        const jobAny = status.job as { id: string; dashboardJson?: unknown };
        if (jobAny.dashboardJson) {
          return { success: true, data: { dashboard: jobAny.dashboardJson, cached: true } };
        }

        const json: DashboardJson = await buildDashboardJson(req.user!.userId, id);
        await persistDashboardJson(req.user!.userId, json.jobId, json);

        // Fire-and-forget WS announcement. Phase 4 listens for this to flip
        // its ChipUp artifact into 'ready'. We do NOT await beyond the
        // publish call — publishChatEvent already swallows pub/sub errors.
        await publishChatEvent(id, 'enrichment:json-ready', {
          chatId: id,
          artifactId: json.jobId,
          articleCount: json.articles.length,
        });

        return { success: true, data: { dashboard: json, cached: false } };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 5) GET /chats/:id/enrich/summary ─────────────────────────────────
  app.get(
    '/api/v1/chats/:id/enrich/summary',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const summary = await buildSummary(req.user!.userId, id);
        return { success: true, data: summary };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 6) GET /enrichments/:articleId ───────────────────────────────────
  app.get(
    '/api/v1/enrichments/:articleId',
    { preHandler: app.auth },
    async (req, reply) => {
      const { articleId } = req.params as { articleId: string };
      const article = await getArticleEnrichment(req.user!.userId, articleId);
      if (!article) {
        reply.code(404);
        return { success: false, error: 'Article not found' };
      }
      return {
        success: true,
        data: {
          article: {
            id: article.id,
            title: article.title,
            url: article.url,
            publisherDomain: article.publisherDomain,
            source: article.source,
            author: article.author,
            publishedDate: article.publishedDate?.toISOString() ?? null,
            language: article.language,
          },
          enrichment: article.enrichment ?? null,
        },
      };
    },
  );

  // ─── 7) POST /chats/:id/reach/fetch ───────────────────────────────────
  app.post(
    '/api/v1/chats/:id/reach/fetch',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await enqueueReachFetchForChat(req.user!.userId, id);
        return { success: true, data: result };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );

  // ─── 8) GET /reach/cache/:domain ──────────────────────────────────────
  // Global / cross-user — no RLS, the SimilarWebAgent's reach_cache is
  // shared across users by design.
  app.get(
    '/api/v1/reach/cache/:domain',
    { preHandler: app.auth },
    async (req, reply) => {
      const { domain } = req.params as { domain: string };
      const row = await getReachByDomain(domain);
      if (!row) {
        reply.code(404);
        return { success: false, error: 'No reach data for domain' };
      }
      return { success: true, data: row };
    },
  );

  // ─── 9) POST /chats/:id/enrich/retry ──────────────────────────────────
  app.post(
    '/api/v1/chats/:id/enrich/retry',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await retryFailedBatches(req.user!.userId, id);
        return { success: true, data: result };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(statusForError(m));
        return { success: false, error: m };
      }
    },
  );
}
