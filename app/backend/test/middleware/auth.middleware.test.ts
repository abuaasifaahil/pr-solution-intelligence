import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authMiddleware } from '../../src/middleware/auth.middleware.js';
import { signAccess } from '../../src/lib/jwt.js';

describe('authMiddleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate('auth', authMiddleware);
    app.get('/protected', { preHandler: app.auth }, async (req) => ({ user: req.user }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Bearer token is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 + attaches user when token is valid', async () => {
    const token = signAccess({
      userId: 'u1',
      email: 'kb@test.local',
      role: 'analyst',
      sessionId: 's-test',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.userId).toBe('u1');
    expect(body.user.email).toBe('kb@test.local');
  });
});
