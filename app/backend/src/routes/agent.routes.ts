import type { FastifyInstance } from 'fastify';
import { prisma } from '@prsi/shared/db';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/agents', { preHandler: app.auth }, async () => {
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return { success: true, data: { agents } };
  });

  app.get('/api/v1/agents/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }
    return { success: true, data: { agent } };
  });

  app.get('/api/v1/agents/:id/health', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }
    return {
      success: true,
      data: { health: { status: 'ok', uptimeMs: process.uptime() * 1000, lastActionAt: null, messageCount: 0 } },
    };
  });
}
