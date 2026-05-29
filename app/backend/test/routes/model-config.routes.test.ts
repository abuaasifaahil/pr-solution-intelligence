import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// In-memory data store keyed by (userId, id).
type Row = {
  id: string; userId: string; provider: string; modelName: string;
  apiKeyEncrypted: string | null; maxTokens: number; temperature: number;
  isDefault: boolean; createdAt: Date;
};
const store: Row[] = [];
let userIdCtx = '';

const llmMock = {
  findFirst: vi.fn(async ({ where }: { where: { isDefault?: boolean; id?: string } }) => {
    return (
      store.find((r) =>
        r.userId === userIdCtx &&
        (where.isDefault === undefined || r.isDefault === where.isDefault) &&
        (where.id === undefined || r.id === where.id),
      ) ?? null
    );
  }),
  create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
    const row: Row = {
      id: `mc-${store.length + 1}`,
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
  updateMany: vi.fn(async ({ where, data }: { where: { isDefault: boolean }; data: Partial<Row> }) => {
    let count = 0;
    for (const r of store) {
      if (r.userId === userIdCtx && r.isDefault === where.isDefault) {
        Object.assign(r, data);
        count++;
      }
    }
    return { count };
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    lLMConfig: llmMock,
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try { return await fn({ lLMConfig: llmMock }); }
    finally { userIdCtx = ''; }
  }),
  asAdmin: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const tokenA = signAccess({ userId: 'user-a', email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: 'user-b', email: 'b@test.local', role: 'analyst', sessionId: 's' });

describe('Model config routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { store.length = 0; });

  it('GET returns null when no row exists', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.config).toBeNull();
  });

  it('POST creates a row and clears is_default on a pre-existing one', async () => {
    // Seed a pre-existing non-default row for user-a (e.g. a stale secondary).
    store.push({
      id: 'mc-old', userId: 'user-a', provider: 'gpt', modelName: 'gpt-4',
      apiKeyEncrypted: 'iv:tag:ct', maxTokens: 4096, temperature: 0.3,
      isDefault: false, createdAt: new Date(),
    });
    // And another pre-existing default row that must be flipped to non-default.
    store.push({
      id: 'mc-stale-default', userId: 'user-a', provider: 'ollama', modelName: 'llama3',
      apiKeyEncrypted: null, maxTokens: 4096, temperature: 0.3,
      isDefault: true, createdAt: new Date(),
    });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        provider: 'claude', modelName: 'claude-3-5-sonnet',
        apiKey: 'sk-ant', maxTokens: 8000, temperature: 0.5,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.config.apiKeyEncrypted).toBe('***encrypted***');
    // Exactly one row remains as default for user-a, carrying the new payload.
    const defaults = store.filter((r) => r.userId === 'user-a' && r.isDefault === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.provider).toBe('claude');
    expect(defaults[0]!.modelName).toBe('claude-3-5-sonnet');
    // Underlying ciphertext is real, not the masked string.
    expect(defaults[0]!.apiKeyEncrypted).not.toBe('***encrypted***');
    expect(defaults[0]!.apiKeyEncrypted!.split(':')).toHaveLength(3);
    // The originally-non-default secondary stays non-default.
    expect(store.find((r) => r.id === 'mc-old')!.isDefault).toBe(false);
  });

  it('GET after POST returns the row with apiKeyEncrypted masked', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        provider: 'gpt', modelName: 'gpt-4.1',
        apiKey: 'sk-test', maxTokens: 4096, temperature: 0.3,
      },
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const cfg = res.json().data.config;
    expect(cfg).not.toBeNull();
    expect(cfg.apiKeyEncrypted).toBe('***encrypted***');
    expect(cfg.provider).toBe('gpt');
    expect(cfg.modelName).toBe('gpt-4.1');
  });

  it('POST with temperature: 5 returns 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        provider: 'gpt', modelName: 'gpt-4.1',
        apiKey: 'sk-test', maxTokens: 4096, temperature: 5,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('Cross-user GET returns the other user\'s null (RLS isolation)', async () => {
    // user-a creates a default config.
    await app.inject({
      method: 'POST', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        provider: 'gpt', modelName: 'gpt-4.1',
        apiKey: 'sk-a', maxTokens: 4096, temperature: 0.3,
      },
    });
    // user-b sees null — RLS prevents cross-user access.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/settings/model',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.config).toBeNull();
  });
});
