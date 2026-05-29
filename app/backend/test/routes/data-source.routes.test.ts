import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// In-memory data store keyed by (userId, id).
type Row = { id: string; userId: string; sourceType: string; displayName: string;
  apiKeyEncrypted: string; endpointUrl: string | null; config: object;
  isActive: boolean; lastTestedAt: Date | null; createdAt: Date };
const store: Row[] = [];
let userIdCtx = '';

const dataSourceMock = {
  findMany: vi.fn(async () =>
    store.filter((r) => r.userId === userIdCtx).map((r) => ({ ...r })),
  ),
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    store.find((r) => r.id === where.id && r.userId === userIdCtx) ?? null,
  ),
  create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'isActive' | 'lastTestedAt'> }) => {
    const row: Row = {
      id: `ds-${store.length + 1}`,
      isActive: true,
      lastTestedAt: null,
      createdAt: new Date(),
      ...data,
    } as Row;
    store.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const r = store.find((x) => x.id === where.id);
    if (!r) throw new Error('not found');
    Object.assign(r, data);
    return { ...r };
  }),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const i = store.findIndex((x) => x.id === where.id);
    if (i >= 0) store.splice(i, 1);
    return {};
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    dataSource: dataSourceMock,
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try { return await fn({ dataSource: dataSourceMock }); }
    finally { userIdCtx = ''; }
  }),
  asAdmin: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const tokenA = signAccess({ userId: 'user-a', email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: 'user-b', email: 'b@test.local', role: 'analyst', sessionId: 's' });

describe('Data sources routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { store.length = 0; });

  it('POST creates a row and masks the api key in the response', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        sourceType: 'meltwater', displayName: 'M1',
        apiKey: 'sk-test', endpointUrl: 'https://api.meltwater.com',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.dataSource.apiKeyEncrypted).toBe('***encrypted***');
    // Underlying row carries a real ciphertext, not the masked string.
    expect(store[0]!.apiKeyEncrypted).not.toBe('***encrypted***');
    expect(store[0]!.apiKeyEncrypted.split(':')).toHaveLength(3);
  });

  it('GET lists only the requesting user rows (RLS isolation)', async () => {
    // Seed two rows owned by A.
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceType: 'meltwater', displayName: 'A1', apiKey: 'k' },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { sourceType: 'opoint', displayName: 'B1', apiKey: 'k' },
    });

    const aRes = await app.inject({
      method: 'GET', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRes.json().data.dataSources).toHaveLength(1);
    expect(aRes.json().data.dataSources[0].displayName).toBe('A1');
  });

  it('PATCH cross-user returns 404', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceType: 'meltwater', displayName: 'A1', apiKey: 'k' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/data-sources/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { displayName: 'hijack' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:id/test for custom type returns ok=false', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceType: 'custom', displayName: 'C', apiKey: 'k' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/data-sources/${id}/test`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.message).toMatch(/not supported/i);
  });

  it('POST /:id/test for meltwater calls fetch and returns probe status', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceType: 'meltwater', displayName: 'M', apiKey: 'sk-real' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/data-sources/${id}/test`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.status).toBe(200);
    // The key must never appear in the response body.
    expect(JSON.stringify(res.json())).not.toContain('sk-real');
    fetchSpy.mockRestore();
  });

  it('DELETE removes the row', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/data-sources',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceType: 'meltwater', displayName: 'A1', apiKey: 'k' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/data-sources/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(store).toHaveLength(0);
  });
});
