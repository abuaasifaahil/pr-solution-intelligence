import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { prisma } from '@prsi/shared/db';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';

const TEST_EMAIL = 'login-test@test.local';

describe('POST /api/v1/auth/login (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    // Clean slate per test.
    await prisma.session.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('hunter2'),
        displayName: 'Login Tester',
        role: 'analyst',
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await app.close();
    await closeRedis();
    await prisma.$disconnect();
  });

  it('returns 200 + tokens on correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.accessToken).toBeTypeOf('string');
    expect(body.data.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.user.email).toBe(TEST_EMAIL);
  });

  it('returns 401 on wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'WRONG' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL },
    });
    expect(res.statusCode).toBe(400);
  });
});
