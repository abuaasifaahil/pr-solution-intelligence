/**
 * M9.7 — user-agent routes integration test.
 *
 * Uses an in-memory data store (mirroring chat-params.routes.test.ts) so
 * the suite runs without a live Postgres. RLS is simulated via the
 * userIdCtx variable the withUser mock toggles.
 *
 * @file backend/test/routes/user-agent.routes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

interface UserAgentRow {
  id: string;
  userId: string;
  name: string;
  baseAgentKind: string;
  customization: unknown;
  scope: string;
  createdAt: Date;
}

const store: UserAgentRow[] = [];
let userIdCtx = '';

const userAgentMock = {
  findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
    store.filter((r) => r.userId === where.userId && r.userId === userIdCtx),
  ),
  findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
    store.find(
      (r) =>
        r.id === where.id && r.userId === where.userId && r.userId === userIdCtx,
    ) ?? null,
  ),
  create: vi.fn(async ({ data }: { data: Partial<UserAgentRow> }) => {
    // Unique (userId, name) — emulate Prisma P2002 violation.
    const dup = store.find(
      (r) => r.userId === data.userId && r.name === data.name,
    );
    if (dup) {
      const err = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      throw err;
    }
    const row: UserAgentRow = {
      id: randomUUID(),
      userId: data.userId!,
      name: data.name!,
      baseAgentKind: data.baseAgentKind!,
      customization: data.customization,
      scope: data.scope ?? 'user_private',
      createdAt: new Date(),
    };
    store.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserAgentRow> }) => {
    const r = store.find((x) => x.id === where.id && x.userId === userIdCtx);
    if (!r) {
      const err = Object.assign(new Error('Record not found'), { code: 'P2025' });
      throw err;
    }
    Object.assign(r, data);
    return { ...r };
  }),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const i = store.findIndex((x) => x.id === where.id && x.userId === userIdCtx);
    if (i < 0) {
      const err = Object.assign(new Error('Record not found'), { code: 'P2025' });
      throw err;
    }
    const [removed] = store.splice(i, 1);
    return removed!;
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    userAgent: userAgentMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ userAgent: userAgentMock });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

vi.mock('../../src/lib/storage.js', () => ({
  getStorage: () => ({
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    ping: vi.fn(),
  }),
  resetStorageForTests: vi.fn(),
}));

vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => ({ add: vi.fn() }),
  startInlineWorker: vi.fn(),
  closeQueue: vi.fn(),
  QUEUE_NAME_PHASE2: 'phase2-jobs',
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const userA = '00000000-0000-0000-0000-00000000aaaa';
const userB = '00000000-0000-0000-0000-00000000bbbb';
const tokenA = signAccess({ userId: userA, email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: userB, email: 'b@test.local', role: 'analyst', sessionId: 's' });

describe('User-agent routes (M9.7)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.length = 0;
  });

  // ─── GET /me/agents ────────────────────────────────────────────────
  it('GET /me/agents — 200 with the caller\'s agents only', async () => {
    // Seed an agent for Alice and one for Bob.
    store.push({
      id: randomUUID(),
      userId: userA,
      name: 'alice-1',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    store.push({
      id: randomUUID(),
      userId: userB,
      name: 'bob-1',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/agents',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('alice-1');
  });

  it('GET /me/agents — 401 unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/agents' });
    expect(res.statusCode).toBe(401);
  });

  // ─── POST /me/agents ───────────────────────────────────────────────
  it('POST /me/agents — 201 with created agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'My PR Impact',
        baseAgentKind: 'pr_impact',
        customization: { prompt: 'override' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('My PR Impact');
    expect(body.data.baseAgentKind).toBe('pr_impact');
    expect(body.data.scope).toBe('user_private');
    expect(body.data.userId).toBe(userA);
  });

  it('POST /me/agents — 400 with invalid baseAgentKind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'Bad',
        baseAgentKind: 'not_a_kind',
        customization: {},
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.meta).toBeDefined(); // field-path info from Zod
  });

  it('POST /me/agents — 409 on duplicate name within user', async () => {
    const payload = {
      name: 'dup',
      baseAgentKind: 'pr_impact',
      customization: {},
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/me/agents',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  // ─── PATCH /me/agents/:id ─────────────────────────────────────────
  it('PATCH /me/agents/:id — 200 when own agent', async () => {
    const id = randomUUID();
    store.push({
      id,
      userId: userA,
      name: 'orig',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${id}`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { name: 'updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('updated');
  });

  it('PATCH /me/agents/:id — 404 when foreign (P2025)', async () => {
    const id = randomUUID();
    store.push({
      id,
      userId: userA,
      name: 'alice-priv',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    // Bob tries to patch Alice's agent. The mock's update gates by
    // userIdCtx == userB → row not found → P2025.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/me/agents/${id}`,
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      payload: { name: 'pwn3d' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── DELETE /me/agents/:id ────────────────────────────────────────
  it('DELETE /me/agents/:id — 204 on own agent', async () => {
    const id = randomUUID();
    store.push({
      id,
      userId: userA,
      name: 'to-delete',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(204);
    expect(store.find((r) => r.id === id)).toBeUndefined();
  });

  it('DELETE /me/agents/:id — 404 when foreign', async () => {
    const id = randomUUID();
    store.push({
      id,
      userId: userA,
      name: 'alice-priv',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /me/agents/:id — 401 unauthenticated', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/agents/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
