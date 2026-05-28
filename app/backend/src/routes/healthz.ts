import type { FastifyInstance } from 'fastify';
import { prisma } from '@prsi/shared/db';
import { getRedis } from '../lib/redis.js';

type HealthStatus = 'ok' | 'error';

interface HealthzResponse {
  ok: boolean;
  service: 'api';
  db: HealthStatus;
  redis: HealthStatus;
}

export async function healthzRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply): Promise<HealthzResponse> => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const ok = db === 'ok' && redis === 'ok';
    reply.code(ok ? 200 : 503);
    return { ok, service: 'api', db, redis };
  });
}

async function pingDb(): Promise<HealthStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'ok';
  } catch {
    return 'error';
  }
}

async function pingRedis(): Promise<HealthStatus> {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}
