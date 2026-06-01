/**
 * Phase 2 chat_params REST endpoints — M7.5.
 *
 *   GET   /api/v1/chats/:id/params                — lazy-create + read
 *   PATCH /api/v1/chats/:id/params                — partial update + auto-advance
 *   POST  /api/v1/chats/:id/params/brand-suggest  — LLM brand→competitors
 *
 * All endpoints are guarded by `app.auth`. Ownership is enforced via RLS in
 * the service layer (`withUser`).
 *
 * @file routes/chat-params.routes.ts
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  getOrCreateParams,
  patchParams,
  suggestCompetitors,
} from '../services/chat-params.service.js';

const PatchBody = z.object({
  dateRangeType: z.enum(['weekly', 'ten_days', 'twenty_days', 'custom', 'auto_detected']).optional(),
  dateStart: z.string().datetime().optional().nullable(),
  dateEnd: z.string().datetime().optional().nullable(),
  enrichmentType: z.enum(['standard', 'reach']).optional(),
  reachThreshold: z.number().int().positive().optional().nullable(),
  brand: z.string().min(1).max(255).optional().nullable(),
  competitors: z.array(z.string().min(1).max(255)).optional(),
  competitorSet: z.enum(['top5', 'top3', 'top2', 'custom']).optional(),
  intention: z.enum(['intention_based', 'comment_based']).optional(),
  hasUpload: z.boolean().optional(),
  uploadId: z.string().uuid().optional().nullable(),
});

const BrandSuggestBody = z.object({
  brand: z.string().min(1).max(255),
});

export async function chatParamsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/chats/:id/params', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const params = await getOrCreateParams(req.user!.userId, id);
      return { success: true, data: { params, flowState: params.flowState } };
    } catch (err) {
      const message = (err as Error).message;
      reply.code(message === 'Chat not found' ? 404 : 500);
      return { success: false, error: message };
    }
  });

  app.patch('/api/v1/chats/:id/params', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      // Coerce ISO date strings → Date.
      const body = parsed.data;
      const patch = {
        ...body,
        dateStart:
          body.dateStart === undefined
            ? undefined
            : body.dateStart === null
              ? null
              : new Date(body.dateStart),
        dateEnd:
          body.dateEnd === undefined
            ? undefined
            : body.dateEnd === null
              ? null
              : new Date(body.dateEnd),
      };
      const out = await patchParams(req.user!.userId, id, patch);
      return { success: true, data: { params: out.params, nextPrompt: out.nextPrompt } };
    } catch (err) {
      const message = (err as Error).message;
      reply.code(message === 'Chat not found' ? 404 : 500);
      return { success: false, error: message };
    }
  });

  app.post(
    '/api/v1/chats/:id/params/brand-suggest',
    { preHandler: app.auth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = BrandSuggestBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
      }
      try {
        // Ensure chat ownership (lazy-creates the params row if needed).
        await getOrCreateParams(req.user!.userId, id);
        const competitors = await suggestCompetitors(req.user!.userId, parsed.data.brand);
        return { success: true, data: { competitors } };
      } catch (err) {
        const message = (err as Error).message;
        reply.code(message === 'Chat not found' ? 404 : 500);
        return { success: false, error: message };
      }
    },
  );
}
