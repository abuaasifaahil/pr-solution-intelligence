import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]), $disconnect: vi.fn() },
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

describe('GET /healthz (unit, mocked deps)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with db + redis = ok when both alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'api', db: 'ok', redis: 'ok' });
  });
});
