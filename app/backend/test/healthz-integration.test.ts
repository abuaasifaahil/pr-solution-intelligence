import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closeRedis } from '../src/lib/redis.js';
import { prisma } from '@prsi/shared/db';

describe('GET /healthz (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeRedis();
    await prisma.$disconnect();
  });

  it('returns ok with db + redis status', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('api');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });
});
