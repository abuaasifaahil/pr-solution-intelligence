/**
 * M9.7 — probe routes integration test.
 *
 * Tests the two probe endpoints in isolation by mocking the classifier
 * + source-snapshot helper. Storage / queue / event bus / LLM all
 * stubbed because we only care about route plumbing + patch translation.
 *
 * @file backend/test/routes/probe.routes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ─── In-memory chat + params + messages stores ────────────────────────
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
  dataSource: string;
  mediaTypes: unknown;
}

interface MessageRow {
  id: string;
  chatId: string;
  role: string;
  content: string;
  createdAt: Date;
}

const paramsStore: ParamsRow[] = [];
const chatStore: Array<{ id: string; userId: string }> = [];
const messageStore: MessageRow[] = [];
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
      dataSource: 'csv_upload',
      mediaTypes: [],
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
      data: Record<string, unknown> & { upload?: { connect?: { id: string }; disconnect?: boolean } };
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

const messageMock = {
  findFirst: vi.fn(async ({ where }: { where: { chatId: string; role?: string } }) => {
    const matches = messageStore
      .filter((m) => m.chatId === where.chatId && (where.role ? m.role === where.role : true))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches[0] ?? null;
  }),
};

const booleanQueryMock = {
  findFirst: vi.fn(async () => null),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    chatParams: chatParamsMock,
    chat: chatMock,
    message: messageMock,
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
        message: messageMock,
        booleanQuery: booleanQueryMock,
      });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

// ─── Mock sample-classifier ──────────────────────────────────────────
const classifyAndProbeMock = vi.fn();

vi.mock('../../src/lib/sample-classifier.js', () => ({
  sampleClassifier: {
    classifyAndProbe: classifyAndProbeMock,
  },
  SampleClassifier: vi.fn(),
}));

// ─── Mock source-snapshot helper ─────────────────────────────────────
const collectAdapterSamplesMock = vi.fn(async () => []);

vi.mock('../../src/lib/source-snapshot.js', () => ({
  collectAdapterSamples: collectAdapterSamplesMock,
  SAMPLE_LIMIT: 25,
}));

// ─── Other infrastructure stubs ──────────────────────────────────────
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: vi.fn(async () => {}),
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

function emptyProbingResult(): unknown {
  return {
    inferred: {},
    confidence: {
      brand: 0,
      competitors: 0,
      dateRange: 0,
      mediaTypes: 0,
      language: 0,
      intention: 0,
      enrichmentType: 0,
    },
    probes: [
      {
        field: 'brand',
        question: 'Which brand?',
        chips: [],
        allowFreeText: true,
        rationale: 'No sample.',
      },
    ],
    rationale: 'No sample.',
    perSourceStats: [],
  };
}

describe('Probe routes (M9.7)', () => {
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
    messageStore.length = 0;
    chatId = randomUUID();
    chatStore.push({ id: chatId, userId: userA });
    classifyAndProbeMock.mockReset();
    collectAdapterSamplesMock.mockReset();
    collectAdapterSamplesMock.mockResolvedValue([]);
  });

  // ─── GET /chats/:id/probe ───────────────────────────────────────────
  it('GET /probe — 200 with ProbingResult shape', async () => {
    classifyAndProbeMock.mockResolvedValueOnce(emptyProbingResult());
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/probe`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('inferred');
    expect(body.data).toHaveProperty('confidence');
    expect(body.data).toHaveProperty('probes');
    expect(body.data).toHaveProperty('rationale');
    expect(body.data).toHaveProperty('perSourceStats');
  });

  it('GET /probe — 401 unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/probe`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /probe — 404 on foreign chat', async () => {
    classifyAndProbeMock.mockResolvedValueOnce(emptyProbingResult());
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/probe`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /probe — empty source returns ProbingResult with classifier-output probes', async () => {
    classifyAndProbeMock.mockResolvedValueOnce(emptyProbingResult());
    collectAdapterSamplesMock.mockResolvedValueOnce([]); // no source attached
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/probe`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.probes).toHaveLength(1);
    expect(body.data.probes[0].field).toBe('brand');
  });

  // ─── POST /chats/:id/probe/resolve ──────────────────────────────────
  it('POST /resolve — valid resolutions → 200, patchParams merged', async () => {
    classifyAndProbeMock.mockResolvedValue(emptyProbingResult());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [
          { field: 'brand', value: 'Acme' },
          { field: 'competitors', value: ['Beta', 'Gamma'] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.updatedParams.brand).toBe('Acme');
    expect(body.data.updatedParams.competitors).toEqual(['Beta', 'Gamma']);
    expect(body.data.updatedParams.competitorSet).toBe('custom');
    expect(body.data.remainingProbes).toBeDefined();
  });

  it('POST /resolve — enrichmentType "enrichment_plus_reach" → "reach"', async () => {
    classifyAndProbeMock.mockResolvedValue(emptyProbingResult());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [{ field: 'enrichmentType', value: 'enrichment_plus_reach' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.updatedParams.enrichmentType).toBe('reach');
  });

  it('POST /resolve — dateRange writes dateStart, dateEnd, dateRangeType="custom"', async () => {
    classifyAndProbeMock.mockResolvedValue(emptyProbingResult());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [
          {
            field: 'dateRange',
            value: { start: '2025-01-01T00:00:00.000Z', end: '2025-01-31T00:00:00.000Z' },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().data.updatedParams;
    expect(updated.dateStart).toBeDefined();
    expect(updated.dateEnd).toBeDefined();
    expect(updated.dateRangeType).toBe('custom');
  });

  it('POST /resolve — invalid field → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [{ field: 'not_a_field', value: 'x' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /resolve — empty resolutions → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { resolutions: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /resolve — foreign chat → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [{ field: 'brand', value: 'Acme' }],
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /resolve — mediaTypes with unknown type → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/probe/resolve`,
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        resolutions: [{ field: 'mediaTypes', value: ['not_a_media_type'] }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
