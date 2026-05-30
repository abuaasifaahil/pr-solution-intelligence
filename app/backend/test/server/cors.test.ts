import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const ALLOWED = 'https://prsi.vercel.app';
process.env.CORS_ALLOWED_ORIGIN = ALLOWED;

const { buildServer } = await import('../../src/server.js');

describe('CORS allowlist', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests from the configured origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does NOT echo Access-Control-Allow-Origin for a disallowed origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
