/**
 * M7.5 — chat-params routes integration test.
 *
 * Uses an in-memory data store (mirroring upload.routes.test.ts) so the
 * suite runs without a live Postgres. The LLM (`chatComplete`) and the WS
 * event bus (`publishChatEvent`) are also mocked. The route surface
 * exercised: GET (lazy create), PATCH (state advance + WS event), POST
 * brand-suggest, plus cross-user ownership (RLS isolation).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ───────────────────────────────────────────────────────────────────────
// In-memory stores keyed by (id, userIdCtx). RLS isolation is simulated by
// gating reads/writes on the current userIdCtx, set by the withUser mock.
// ───────────────────────────────────────────────────────────────────────
interface ParamsRow {
  id: string;
  chatId: string;
  userId: string;
  flowState: string;
  dateRangeType: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  reachThreshold: number | null;
  brand: string | null;
  competitors: unknown;
  competitorSet: string | null;
  intention: string | null;
  hasUpload: boolean;
  uploadId: string | null;
  collectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const paramsStore: ParamsRow[] = [];
const chatStore: Array<{ id: string; userId: string }> = [];
let userIdCtx = '';

const chatParamsMock = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((r) => r.chatId === where.chatId && r.userId === userIdCtx) ?? null,
  ),
  create: vi.fn(async ({ data }: { data: Partial<ParamsRow> }) => {
    const row: ParamsRow = {
      id: randomUUID(),
      chatId: data.chatId!,
      userId: data.userId!,
      flowState: data.flowState ?? 'init',
      dateRangeType: null,
      dateStart: null,
      dateEnd: null,
      enrichmentType: null,
      reachThreshold: null,
      brand: null,
      competitors: [],
      competitorSet: null,
      intention: null,
      hasUpload: false,
      uploadId: null,
      collectedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    paramsStore.push(row);
    return row;
  }),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { chatId: string };
      data: Record<string, unknown> & {
        upload?: { connect?: { id: string }; disconnect?: boolean };
      };
    }) => {
      const r = paramsStore.find((x) => x.chatId === where.chatId);
      if (!r) throw new Error('not found');
      const { upload, ...rest } = data;
      Object.assign(r, rest);
      if (upload?.connect) r.uploadId = upload.connect.id;
      if (upload?.disconnect) r.uploadId = null;
      r.updatedAt = new Date();
      return { ...r };
    },
  ),
};

const chatMock = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    chatStore.find((c) => c.id === where.id && c.userId === userIdCtx) ?? null,
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    chatParams: chatParamsMock,
    chat: chatMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ chatParams: chatParamsMock, chat: chatMock });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  subscribeChatEvents: vi.fn(),
}));

const chatCompleteMock = vi.fn();
vi.mock('../../src/lib/llm.js', () => ({
  chatComplete: chatCompleteMock,
  parseChoice: vi.fn(),
  chatCompleteStream: vi.fn(),
}));

// Storage + queue mocks (server.ts wires them, even though chat-params doesn't
// touch them).
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

describe('Chat params routes (integration)', () => {
  let app: FastifyInstance;
  let chatId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    paramsStore.length = 0;
    chatStore.length = 0;
    chatId = randomUUID();
    chatStore.push({ id: chatId, userId: userA });
    publishChatEventMock.mockClear();
    chatCompleteMock.mockReset();
  });

  // ─── GET /chats/:id/params ─────────────────────────────────────────
  it('GET /chats/:id/params — lazily creates and returns the row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.params.chatId).toBe(chatId);
    expect(body.data.params.flowState).toBe('init');
    expect(body.data.flowState).toBe('init');
    expect(paramsStore).toHaveLength(1);
  });

  it('GET /chats/:id/params — 401 when no auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/params`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /chats/:id/params — 404 when chat not owned (RLS)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── PATCH /chats/:id/params ───────────────────────────────────────
  it('PATCH /chats/:id/params — partial update works', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { brand: 'Acme' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.params.brand).toBe('Acme');
  });

  it('PATCH /chats/:id/params — state advance verified end-to-end', async () => {
    // First PATCH: set brand. The engine sees no dates, so next state is
    // collect_dates and the state advances from init -> collect_dates.
    const r1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { brand: 'Acme' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.params.flowState).toBe('collect_dates');
    expect(publishChatEventMock).toHaveBeenCalledTimes(1);
    expect(publishChatEventMock.mock.calls[0]![1]).toBe('flow:state-change');

    // Second PATCH: set dates. Now dates+brand exist but enrichment is
    // missing → flowState advances to collect_enrichment.
    const r2 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        dateStart: '2025-01-01T00:00:00.000Z',
        dateEnd: '2025-01-31T00:00:00.000Z',
      },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.params.flowState).toBe('collect_enrichment');

    // GET after PATCH reflects the advanced state.
    const r3 = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(r3.json().data.params.flowState).toBe('collect_enrichment');
    expect(r3.json().data.params.brand).toBe('Acme');
  });

  it('PATCH /chats/:id/params — invalid body 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { dateRangeType: 'monthly' /* not a valid enum */ },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /chats/:id/params — cross-user (Bob → Alice chat) 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      payload: { brand: 'Acme' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── POST /chats/:id/params/brand-suggest ───────────────────────────
  it('POST /chats/:id/params/brand-suggest — returns top5/top3/top2', async () => {
    chatCompleteMock.mockResolvedValueOnce(
      JSON.stringify({
        top5: ['Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
        top3: ['Beta', 'Gamma', 'Delta'],
        top2: ['Beta', 'Gamma'],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/params/brand-suggest`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { brand: 'Acme' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.competitors).toEqual({
      top5: ['Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
      top3: ['Beta', 'Gamma', 'Delta'],
      top2: ['Beta', 'Gamma'],
    });
  });

  it('POST /chats/:id/params/brand-suggest — 400 on empty brand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/params/brand-suggest`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { brand: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /chats/:id/params/brand-suggest — cross-user (Bob → Alice chat) 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/params/brand-suggest`,
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      payload: { brand: 'Acme' },
    });
    expect(res.statusCode).toBe(404);
  });
});
