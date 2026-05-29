import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// In-memory data store keyed by (userId, id).
type Row = {
  id: string; userId: string; sourceName: string; serverUrl: string;
  tokenEncrypted: string; status: 'active' | 'inactive' | 'error';
  lastVerifiedAt: Date | null; availableTools: unknown[]; createdAt: Date;
};
const store: Row[] = [];
let userIdCtx = '';

const mcpMock = {
  findMany: vi.fn(async () =>
    store.filter((r) => r.userId === userIdCtx).map((r) => ({ ...r })),
  ),
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    store.find((r) => r.id === where.id && r.userId === userIdCtx) ?? null,
  ),
  create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'status' | 'lastVerifiedAt' | 'availableTools'> }) => {
    const row: Row = {
      id: `mcp-${store.length + 1}`,
      status: 'inactive',
      lastVerifiedAt: null,
      availableTools: [],
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
    mCPConnection: mcpMock,
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try { return await fn({ mCPConnection: mcpMock }); }
    finally { userIdCtx = ''; }
  }),
  asAdmin: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const tokenA = signAccess({ userId: 'user-a', email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: 'user-b', email: 'b@test.local', role: 'analyst', sessionId: 's' });

describe('MCP routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { store.length = 0; });

  it('POST creates a row and masks the token in the response', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        sourceName: 'JIRA',
        serverUrl: 'https://mcp.example.com',
        token: 'sk-test',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.connection.tokenEncrypted).toBe('***encrypted***');
    // Underlying row carries a real ciphertext, not the masked string.
    expect(store[0]!.tokenEncrypted).not.toBe('***encrypted***');
    expect(store[0]!.tokenEncrypted.split(':')).toHaveLength(3);
  });

  it('GET lists only the requesting user rows (RLS isolation)', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceName: 'JIRA-A', serverUrl: 'https://a.example.com', token: 'k' },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { sourceName: 'JIRA-B', serverUrl: 'https://b.example.com', token: 'k' },
    });

    const aRes = await app.inject({
      method: 'GET', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRes.json().data.connections).toHaveLength(1);
    expect(aRes.json().data.connections[0].sourceName).toBe('JIRA-A');
  });

  it('PATCH cross-user returns 404', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceName: 'JIRA-A', serverUrl: 'https://a.example.com', token: 'k' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/mcp/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { sourceName: 'hijack' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:id/verify calls fetch with Bearer token and persists status', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: 'createIssue' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceName: 'JIRA', serverUrl: 'https://mcp.example.com', token: 'sk-real' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/mcp/${id}/verify`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe('active');
    expect(body.data.availableTools).toEqual([{ name: 'createIssue' }]);
    // Fetch must have been called with a Bearer auth header carrying the decrypted token.
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-real');
    // The token must never appear in the response body.
    expect(JSON.stringify(body)).not.toContain('sk-real');
    // Persisted status reflects the probe outcome.
    expect(store[0]!.status).toBe('active');
    fetchSpy.mockRestore();
  });

  it('DELETE removes the row', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sourceName: 'JIRA', serverUrl: 'https://mcp.example.com', token: 'k' },
    });
    const id = store[0]!.id;
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/mcp/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(store).toHaveLength(0);
  });
});
