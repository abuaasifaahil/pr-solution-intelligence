import type { FastifyInstance } from 'fastify';

export async function healthzRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, service: 'api' as const }));
}
