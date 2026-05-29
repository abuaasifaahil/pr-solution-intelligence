import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDefaultModelConfig, upsertDefaultModelConfig,
} from '../services/model-config.service.js';

const UpsertBody = z.object({
  provider: z.enum(['claude', 'gpt', 'ollama', 'perplexity']),
  modelName: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(2000).optional(),
  maxTokens: z.number().int().min(1).max(200000),
  temperature: z.number().min(0).max(2),
});

export async function modelConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/settings/model', { preHandler: app.auth }, async (req) => {
    const config = await getDefaultModelConfig(req.user!.userId);
    return { success: true, data: { config } };
  });

  app.post('/api/v1/settings/model', { preHandler: app.auth }, async (req, reply) => {
    const parsed = UpsertBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const out = await upsertDefaultModelConfig(req.user!.userId, parsed.data);
      return { success: true, data: { config: out } };
    } catch (err) {
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });
}
