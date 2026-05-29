import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listMCPConnections, createMCPConnection, updateMCPConnection,
  deleteMCPConnection, verifyMCPConnection,
} from '../services/mcp.service.js';

const CreateBody = z.object({
  sourceName: z.string().min(1).max(100),
  serverUrl: z.string().url().max(500),
  token: z.string().min(1).max(2000),
});
const UpdateBody = z.object({
  sourceName: z.string().min(1).max(100).optional(),
  serverUrl: z.string().url().max(500).optional(),
  token: z.string().min(1).max(2000).optional(),
});

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/mcp', { preHandler: app.auth }, async (req) => {
    const rows = await listMCPConnections(req.user!.userId);
    return { success: true, data: { connections: rows } };
  });

  app.post('/api/v1/mcp', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { success: false, error: 'Invalid body' }; }
    const created = await createMCPConnection(req.user!.userId, parsed.data);
    return { success: true, data: { connection: created } };
  });

  app.patch('/api/v1/mcp/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { success: false, error: 'Invalid body' }; }
    try {
      const updated = await updateMCPConnection(req.user!.userId, id, parsed.data);
      return { success: true, data: { connection: updated } };
    } catch (err) {
      reply.code(404); return { success: false, error: (err as Error).message };
    }
  });

  app.delete('/api/v1/mcp/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteMCPConnection(req.user!.userId, id);
      return { success: true, data: { message: 'Deleted' } };
    } catch (err) {
      reply.code(404); return { success: false, error: (err as Error).message };
    }
  });

  app.post('/api/v1/mcp/:id/verify', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const out = await verifyMCPConnection(req.user!.userId, id);
      return { success: true, data: out };
    } catch (err) {
      reply.code(404); return { success: false, error: (err as Error).message };
    }
  });
}
