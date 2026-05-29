import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listDataSources, createDataSource, updateDataSource,
  deleteDataSource, testDataSource,
  type DataSourceType,
} from '../services/data-source.service.js';

const SourceTypeSchema = z.enum(['meltwater', 'opoint', 'webz', 'twitter', 'infovision', 'custom']);

const CreateBody = z.object({
  sourceType: SourceTypeSchema,
  displayName: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(2000),
  endpointUrl: z.string().url().max(500).optional(),
  config: z.record(z.unknown()).optional(),
});

const UpdateBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  apiKey: z.string().min(1).max(2000).optional(),
  endpointUrl: z.string().url().max(500).optional(),
  config: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export async function dataSourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/data-sources', { preHandler: app.auth }, async (req) => {
    const rows = await listDataSources(req.user!.userId);
    return { success: true, data: { dataSources: rows } };
  });

  app.post('/api/v1/data-sources', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    const created = await createDataSource(req.user!.userId, {
      ...parsed.data,
      sourceType: parsed.data.sourceType as DataSourceType,
    });
    return { success: true, data: { dataSource: created } };
  });

  app.patch('/api/v1/data-sources/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body' };
    }
    try {
      const updated = await updateDataSource(req.user!.userId, id, parsed.data);
      return { success: true, data: { dataSource: updated } };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });

  app.delete('/api/v1/data-sources/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteDataSource(req.user!.userId, id);
      return { success: true, data: { message: 'Deleted' } };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });

  app.post('/api/v1/data-sources/:id/test', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await testDataSource(req.user!.userId, id);
      return { success: true, data: result };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });
}
