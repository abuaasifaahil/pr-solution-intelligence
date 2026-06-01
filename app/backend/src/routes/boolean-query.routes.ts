/**
 * Phase 2 BooleanQuery REST endpoints — M7.6.
 *
 *   POST  /api/v1/chats/:id/query/generate  — engine-driven from chat_params
 *   PATCH /api/v1/chats/:id/query           — user manual edit (version bump)
 *   POST  /api/v1/chats/:id/query/confirm   — flip is_confirmed + enqueue
 *                                             data-extract + advance flow
 *   GET   /api/v1/chats/:id/query           — fetch latest (helper for FE)
 *
 * All endpoints are guarded by `app.auth`. Ownership is enforced via RLS
 * inside the service layer.
 *
 * @file routes/boolean-query.routes.ts
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  generateQueryForChat,
  patchQueryText,
  confirmQuery,
  getLatestQuery,
} from '../services/boolean-query.service.js';

const PatchBody = z.object({ queryText: z.string().min(1).max(10_000) });

export async function booleanQueryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/chats/:id/query/generate',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const q = await generateQueryForChat(req.user!.userId, id);
        return {
          success: true,
          data: {
            query: {
              id: q.id,
              text: q.queryText,
              structured: q.queryStructured,
              version: q.version,
              isConfirmed: q.isConfirmed,
            },
          },
        };
      } catch (err) {
        const m = (err as Error).message;
        const code =
          m === 'Chat params not found'
            ? 404
            : m.startsWith('brand')
              ? 400
              : 500;
        reply.code(code);
        return { success: false, error: m };
      }
    },
  );

  app.patch(
    '/api/v1/chats/:id/query',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = PatchBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
      }
      try {
        const q = await patchQueryText(req.user!.userId, id, parsed.data.queryText);
        return { success: true, data: { query: q } };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(m.includes('draft') ? 404 : 500);
        return { success: false, error: m };
      }
    },
  );

  app.post(
    '/api/v1/chats/:id/query/confirm',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const q = await confirmQuery(req.user!.userId, id);
        return {
          success: true,
          data: { query: q, processingJobId: q.id },
        };
      } catch (err) {
        const m = (err as Error).message;
        reply.code(m.includes('draft') ? 404 : 500);
        return { success: false, error: m };
      }
    },
  );

  app.get(
    '/api/v1/chats/:id/query',
    { preHandler: app.auth },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = await getLatestQuery(req.user!.userId, id);
      return { success: true, data: { query: q } };
    },
  );
}
