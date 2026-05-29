import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listSkillsForUser, createCustomSkill, toggleUserSkill,
} from '../services/skill.service.js';

const CreateBody = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/i, 'lowercase letters, digits and underscores only'),
  description: z.string().min(1),
  type: z.string().min(1).max(50),
  handlerConfig: z.record(z.unknown()).optional(),
});
const ToggleBody = z.object({
  isEnabled: z.boolean(),
});

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/settings/skills', { preHandler: app.auth }, async (req) => {
    const skills = await listSkillsForUser(req.user!.userId);
    return { success: true, data: { skills } };
  });

  app.post('/api/v1/settings/skills', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const out = await createCustomSkill(req.user!.userId, parsed.data);
      return { success: true, data: { skill: out } };
    } catch (err) {
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });

  app.patch('/api/v1/settings/skills/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ToggleBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body' };
    }
    try {
      const out = await toggleUserSkill(req.user!.userId, id, parsed.data.isEnabled);
      return { success: true, data: { skill: out } };
    } catch (err) {
      const message = (err as Error).message;
      reply.code(message === 'Skill not found' ? 404 : 400);
      return { success: false, error: message };
    }
  });
}
