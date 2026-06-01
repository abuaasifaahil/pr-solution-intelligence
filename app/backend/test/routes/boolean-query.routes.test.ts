/**
 * M7.6 — boolean-query routes integration test.
 *
 * In-memory store mirroring the chat-params.routes pattern, with
 * RLS-by-userIdCtx simulation. Storage + queue are mocked. patchParams
 * (invoked inside confirmQuery) is the real implementation, but our
 * chat_params + boolean_query mocks let it run end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ───────────────────────────────────────────────────────────────────────
// In-memory stores. RLS enforced via userIdCtx (set by withUser mock).
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

interface QueryRow {
  id: string;
  chatId: string;
  chatParamsId: string;
  queryText: string;
  queryStructured: unknown;
  version: number;
  isConfirmed: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
}

const paramsStore: ParamsRow[] = [];
const queryStore: QueryRow[] = [];
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

const booleanQueryMock = {
  findFirst: vi.fn(
    async ({
      where,
      orderBy,
    }: {
      where: {
        chatId: string;
        chatParamsId?: string;
        isConfirmed?: boolean;
      };
      orderBy?:
        | { version?: 'asc' | 'desc'; confirmedAt?: 'asc' | 'desc' }
        | Array<Record<string, 'asc' | 'desc'>>;
    }) => {
      const rows = queryStore.filter((q) => {
        if (q.chatId !== where.chatId) return false;
        // RLS: a query is visible only if user owns the chat (chatStore).
        const chatOwner = chatStore.find((c) => c.id === q.chatId);
        if (!chatOwner || chatOwner.userId !== userIdCtx) return false;
        if (where.chatParamsId !== undefined && q.chatParamsId !== where.chatParamsId) return false;
        if (where.isConfirmed !== undefined && q.isConfirmed !== where.isConfirmed) return false;
        return true;
      });
      if (rows.length === 0) return null;
      if (Array.isArray(orderBy)) {
        rows.sort((a, b) => {
          for (const ob of orderBy) {
            if ('isConfirmed' in ob) {
              const diff = (b.isConfirmed ? 1 : 0) - (a.isConfirmed ? 1 : 0);
              if (diff !== 0) return ob.isConfirmed === 'desc' ? diff : -diff;
            }
            if ('version' in ob) {
              const diff = b.version - a.version;
              if (diff !== 0) return ob.version === 'desc' ? diff : -diff;
            }
            if ('confirmedAt' in ob) {
              const at = a.confirmedAt?.getTime() ?? 0;
              const bt = b.confirmedAt?.getTime() ?? 0;
              const diff = bt - at;
              if (diff !== 0) return ob.confirmedAt === 'desc' ? diff : -diff;
            }
          }
          return 0;
        });
      } else if (orderBy?.version) {
        rows.sort((a, b) => (orderBy.version === 'desc' ? b.version - a.version : a.version - b.version));
      } else if (orderBy?.confirmedAt) {
        rows.sort((a, b) => {
          const at = a.confirmedAt?.getTime() ?? 0;
          const bt = b.confirmedAt?.getTime() ?? 0;
          return orderBy.confirmedAt === 'desc' ? bt - at : at - bt;
        });
      }
      return rows[0]!;
    },
  ),
  create: vi.fn(async ({ data }: { data: Partial<QueryRow> }) => {
    const row: QueryRow = {
      id: randomUUID(),
      chatId: data.chatId!,
      chatParamsId: data.chatParamsId!,
      queryText: data.queryText!,
      queryStructured: data.queryStructured ?? {},
      version: data.version ?? 1,
      isConfirmed: data.isConfirmed ?? false,
      confirmedAt: data.confirmedAt ?? null,
      createdAt: new Date(),
    };
    queryStore.push(row);
    return row;
  }),
  update: vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<QueryRow> }) => {
      const r = queryStore.find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      Object.assign(r, data);
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
    booleanQuery: booleanQueryMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({
        chatParams: chatParamsMock,
        chat: chatMock,
        booleanQuery: booleanQueryMock,
      });
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

vi.mock('../../src/lib/llm.js', () => ({
  chatComplete: vi.fn(),
  parseChoice: vi.fn(),
  chatCompleteStream: vi.fn(),
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

const queueAddMock = vi.fn(
  async (_name: string, _payload: Record<string, unknown>) => ({ id: 'job-1' }),
);
vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => ({ add: queueAddMock }),
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

function seedParamsRow(chatId: string, overrides: Partial<ParamsRow> = {}): ParamsRow {
  const row: ParamsRow = {
    id: randomUUID(),
    chatId,
    userId: userA,
    flowState: 'collect_intention',
    dateRangeType: 'custom',
    dateStart: new Date('2026-05-01T00:00:00.000Z'),
    dateEnd: new Date('2026-05-20T00:00:00.000Z'),
    enrichmentType: 'standard',
    reachThreshold: null,
    brand: 'FreshSip',
    competitors: ['PepsiCo'],
    competitorSet: 'custom',
    intention: 'intention_based',
    hasUpload: false,
    uploadId: null,
    collectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  paramsStore.push(row);
  return row;
}

describe('BooleanQuery routes (integration)', () => {
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
    queryStore.length = 0;
    chatStore.length = 0;
    chatId = randomUUID();
    chatStore.push({ id: chatId, userId: userA });
    publishChatEventMock.mockClear();
    queueAddMock.mockClear();
  });

  // ─── POST /chats/:id/query/generate ──────────────────────────────────
  it('POST /generate — happy path returns v1 query', async () => {
    seedParamsRow(chatId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.query.version).toBe(1);
    expect(body.data.query.isConfirmed).toBe(false);
    expect(body.data.query.text).toContain('title:"FreshSip"');
  });

  it('POST /generate — 400 when brand missing', async () => {
    seedParamsRow(chatId, { brand: null });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/brand/);
  });

  it('POST /generate — 404 when chat not owned (RLS)', async () => {
    seedParamsRow(chatId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /generate — 401 when no auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ─── PATCH /chats/:id/query ──────────────────────────────────────────
  it('PATCH /query — happy path bumps version', async () => {
    seedParamsRow(chatId);
    // Generate first so a draft exists.
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/query`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { queryText: 'hand-edited query' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.query.queryText).toBe('hand-edited query');
    expect(body.data.query.version).toBe(2);
  });

  it('PATCH /query — 404 when no draft exists', async () => {
    seedParamsRow(chatId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/query`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { queryText: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /query — 400 on invalid body', async () => {
    seedParamsRow(chatId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/query`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { queryText: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── POST /chats/:id/query/confirm ───────────────────────────────────
  it('POST /confirm — flips is_confirmed, enqueues, advances flow state', async () => {
    seedParamsRow(chatId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/confirm`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.query.isConfirmed).toBe(true);
    expect(body.data.processingJobId).toBeTruthy();

    // BullMQ enqueue.
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![0]).toBe('data-extract');

    // Flow state advanced past generate_query → processing.
    const after = paramsStore.find((p) => p.chatId === chatId)!;
    expect(after.flowState).toBe('processing');

    // WS event emitted by patchParams on state advance.
    const stateChangeCall = publishChatEventMock.mock.calls.find(
      (c) => c[1] === 'flow:state-change',
    );
    expect(stateChangeCall).toBeTruthy();
    expect(stateChangeCall![2]).toMatchObject({ toState: 'processing' });
  });

  it('POST /confirm — 404 when no draft exists', async () => {
    seedParamsRow(chatId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/confirm`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  // ─── GET /chats/:id/query ────────────────────────────────────────────
  it('GET /query — returns the latest draft', async () => {
    seedParamsRow(chatId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/query`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.query.version).toBe(1);
    expect(body.data.query.isConfirmed).toBe(false);
  });

  it('GET /query — returns null when no queries exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/query`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.query).toBeNull();
  });
});
