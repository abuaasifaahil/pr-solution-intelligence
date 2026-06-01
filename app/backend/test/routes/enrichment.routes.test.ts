/**
 * M8.7 — enrichment.routes integration tests.
 *
 * In-memory Prisma + withUser mock (mirrors the chat-params.routes pattern).
 * The cross-agent bus, BullMQ queue, and Redis publish layer are stubbed.
 * Covers all 9 routes + WS event emission for /enrich/json.
 *
 * @file backend/test/routes/enrichment.routes.test.ts
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
interface ChatRow {
  id: string;
  userId: string;
}
interface ParamsRow {
  chatId: string;
  userId: string;
  brand: string | null;
  competitors: unknown;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  flowState: string;
}
interface ArticleRow {
  id: string;
  chatId: string;
  userId: string;
  title: string;
  content: string | null;
  description: string | null;
  source: string | null;
  author: string | null;
  publishedDate: Date | null;
  url: string | null;
  publisherDomain: string | null;
  language: string;
  rawData: unknown;
}
interface EnrichmentRow {
  id: string;
  articleId: string;
  chatId: string;
  userId: string;
  sentiment: unknown;
  themes: unknown;
  emotion: unknown;
  entities: unknown;
  signals: unknown;
  reach: unknown;
  socialEngagement: unknown;
  modelUsed: string;
  tokensInput: number;
  tokensOutput: number;
  processingMs: number;
  isValid: boolean;
}
interface JobRow {
  id: string;
  chatId: string;
  userId: string;
  totalArticles: number;
  processedCount: number;
  batchCount: number;
  batchesCompleted: number;
  modelUsed: string;
  enrichmentType: 'standard' | 'reach';
  status: string;
  createdAt: Date;
  dashboardJson: unknown;
}
interface BatchRow {
  id: string;
  jobId: string;
  batchNumber: number;
  status: string;
  retryCount: number;
  estimatedTokens: number;
  actualTokensIn: number | null;
  actualTokensOut: number | null;
  processingMs: number | null;
  error: string | null;
}
interface ReachCacheRow {
  domain: string;
  monthlyVisitors: bigint | null;
  globalRank: number | null;
  category: string | null;
  score: number | null;
  rawResponse: unknown;
  fetchedAt: Date;
  ttlHours: number;
  isValid: boolean;
}

const chatStore: ChatRow[] = [];
const paramsStore: ParamsRow[] = [];
const articleStore: ArticleRow[] = [];
const enrichmentStore: EnrichmentRow[] = [];
const jobStore: JobRow[] = [];
const batchStore: BatchRow[] = [];
const reachCacheStore: ReachCacheRow[] = [];
let userIdCtx = '';

const chatMock = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    chatStore.find((c) => c.id === where.id && c.userId === userIdCtx) ?? null,
  ),
};
const chatParamsMock = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((p) => p.chatId === where.chatId && p.userId === userIdCtx) ?? null,
  ),
};
const articleMock = {
  count: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    articleStore.filter((a) => a.chatId === where.chatId && a.userId === userIdCtx)
      .length,
  ),
  findMany: vi.fn(
    async ({
      where,
      include,
      skip,
      take,
      distinct,
    }: {
      where: { chatId: string; publisherDomain?: { not: null } };
      include?: { enrichment?: boolean };
      orderBy?: unknown;
      skip?: number;
      take?: number;
      distinct?: ['publisherDomain'];
      select?: unknown;
    }) => {
      let rows = articleStore.filter(
        (a) => a.chatId === where.chatId && a.userId === userIdCtx,
      );
      if (where.publisherDomain?.not === null) {
        rows = rows.filter((r) => r.publisherDomain != null);
      }
      if (distinct?.includes('publisherDomain')) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          if (r.publisherDomain == null) return false;
          if (seen.has(r.publisherDomain)) return false;
          seen.add(r.publisherDomain);
          return true;
        });
      }
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((a) => ({
        ...a,
        enrichment: include?.enrichment
          ? enrichmentStore.find((e) => e.articleId === a.id) ?? null
          : undefined,
      }));
    },
  ),
  findFirst: vi.fn(async ({ where, include }: {
    where: { id: string };
    include?: { enrichment?: boolean };
  }) => {
    const a = articleStore.find(
      (x) => x.id === where.id && x.userId === userIdCtx,
    );
    if (!a) return null;
    return {
      ...a,
      enrichment: include?.enrichment
        ? enrichmentStore.find((e) => e.articleId === a.id) ?? null
        : undefined,
    };
  }),
};
const enrichmentMock = {
  findMany: vi.fn(
    async ({
      where,
      select,
      include,
    }: {
      where: { chatId: string; isValid?: boolean };
      select?: { reach?: boolean };
      include?: { article?: { select: { publisherDomain: true } } };
    }) => {
      const rows = enrichmentStore.filter(
        (e) =>
          e.chatId === where.chatId &&
          e.userId === userIdCtx &&
          (where.isValid === undefined || e.isValid === where.isValid),
      );
      if (select?.reach) {
        return rows.map((e) => ({ reach: e.reach }));
      }
      if (include?.article) {
        return rows.map((e) => ({
          ...e,
          article: {
            publisherDomain:
              articleStore.find((a) => a.id === e.articleId)?.publisherDomain ?? null,
          },
        }));
      }
      return rows;
    },
  ),
};
const enrichmentJobMock = {
  findFirst: vi.fn(async ({ where }: { where: { chatId: string } }) => {
    const rows = jobStore.filter(
      (j) => j.chatId === where.chatId && j.userId === userIdCtx,
    );
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows[0] ?? null;
  }),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = jobStore.find((j) => j.id === where.id);
      if (!row) throw new Error('job not found');
      Object.assign(row, data);
      return { ...row };
    },
  ),
};
const enrichmentBatchMock = {
  findMany: vi.fn(
    async ({
      where,
    }: {
      where: { jobId: string; status?: string };
      orderBy?: unknown;
    }) => {
      const rows = batchStore.filter(
        (b) =>
          b.jobId === where.jobId &&
          (where.status === undefined || b.status === where.status),
      );
      rows.sort((a, b) => a.batchNumber - b.batchNumber);
      return rows;
    },
  ),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = batchStore.find((b) => b.id === where.id);
      if (!row) throw new Error('batch not found');
      Object.assign(row, data);
      return { ...row };
    },
  ),
};
const reachCacheMock = {
  findUnique: vi.fn(async ({ where }: { where: { domain: string } }) =>
    reachCacheStore.find((r) => r.domain === where.domain) ?? null,
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    chat: chatMock,
    chatParams: chatParamsMock,
    article: articleMock,
    enrichment: enrichmentMock,
    enrichmentJob: enrichmentJobMock,
    enrichmentBatch: enrichmentBatchMock,
    reachCache: reachCacheMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({
        chat: chatMock,
        chatParams: chatParamsMock,
        article: articleMock,
        enrichment: enrichmentMock,
        enrichmentJob: enrichmentJobMock,
        enrichmentBatch: enrichmentBatchMock,
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
const publishAgentBusMock = vi.fn(async (_chan: string, _payload: unknown) => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: publishAgentBusMock,
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
const tokenA = signAccess({
  userId: userA,
  email: 'a@test.local',
  role: 'analyst',
  sessionId: 's',
});
const tokenB = signAccess({
  userId: userB,
  email: 'b@test.local',
  role: 'analyst',
  sessionId: 's',
});

// ───────────────────────────────────────────────────────────────────────
// Seed helpers
// ───────────────────────────────────────────────────────────────────────
function seedChat(chatId: string, userId = userA): void {
  chatStore.push({ id: chatId, userId });
}
function seedParams(
  chatId: string,
  overrides: Partial<ParamsRow> = {},
  userId = userA,
): void {
  paramsStore.push({
    chatId,
    userId,
    brand: 'FreshSip',
    competitors: ['PepsiCo'],
    dateStart: new Date('2026-05-01'),
    dateEnd: new Date('2026-05-20'),
    enrichmentType: 'standard',
    flowState: 'complete',
    ...overrides,
  });
}
function seedArticle(
  chatId: string,
  enrichment?: Partial<EnrichmentRow>,
  overrides: Partial<ArticleRow> = {},
  userId = userA,
): ArticleRow {
  const id = randomUUID();
  const article: ArticleRow = {
    id,
    chatId,
    userId,
    title: `Article ${id.slice(0, 4)}`,
    content: 'body',
    description: 'desc',
    source: 'Reuters',
    author: 'Jane Doe',
    publishedDate: new Date('2026-05-15'),
    url: 'https://example.com/a',
    publisherDomain: 'example.com',
    language: 'en',
    rawData: {},
    ...overrides,
  };
  articleStore.push(article);
  if (enrichment) {
    enrichmentStore.push({
      id: randomUUID(),
      articleId: id,
      chatId,
      userId,
      sentiment: { overall: 'positive' },
      themes: { main: ['Product Launch'], secondary: [], tertiary: [] },
      emotion: { primary: 'joy' },
      entities: { organization: ['FreshSip'] },
      signals: [],
      reach: null,
      socialEngagement: null,
      modelUsed: 'gpt-4.1',
      tokensInput: 1000,
      tokensOutput: 200,
      processingMs: 500,
      isValid: true,
      ...enrichment,
    });
  }
  return article;
}
function seedJob(chatId: string, overrides: Partial<JobRow> = {}): JobRow {
  const row: JobRow = {
    id: randomUUID(),
    chatId,
    userId: userA,
    totalArticles: 3,
    processedCount: 3,
    batchCount: 1,
    batchesCompleted: 1,
    modelUsed: 'gpt-4.1',
    enrichmentType: 'standard',
    status: 'completed',
    createdAt: new Date(),
    dashboardJson: null,
    ...overrides,
  };
  jobStore.push(row);
  return row;
}

describe('Enrichment routes (integration)', () => {
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
    chatStore.length = 0;
    paramsStore.length = 0;
    articleStore.length = 0;
    enrichmentStore.length = 0;
    jobStore.length = 0;
    batchStore.length = 0;
    reachCacheStore.length = 0;
    chatId = randomUUID();
    seedChat(chatId);
    publishChatEventMock.mockClear();
    publishAgentBusMock.mockClear();
    queueAddMock.mockClear();
  });

  // ─── POST /chats/:id/enrich ──────────────────────────────────────────
  it('POST /chats/:id/enrich — enqueues on happy path', async () => {
    seedParams(chatId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ jobId: null, message: 'enqueued' });
    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock.mock.calls[0]![0]).toBe('agent:enrichment:incoming');
  });

  it('POST /chats/:id/enrich — 400 when flowState !== complete', async () => {
    seedParams(chatId, { flowState: 'collect_brand' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Articles not yet extracted/);
    expect(publishAgentBusMock).not.toHaveBeenCalled();
  });

  it('POST /chats/:id/enrich — 404 for wrong chat (RLS)', async () => {
    seedParams(chatId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── GET /chats/:id/enrich/status ────────────────────────────────────
  it('GET /chats/:id/enrich/status — returns job + batches + progress', async () => {
    const job = seedJob(chatId, { totalArticles: 10, processedCount: 5 });
    batchStore.push({
      id: randomUUID(),
      jobId: job.id,
      batchNumber: 1,
      status: 'completed',
      retryCount: 0,
      estimatedTokens: 4000,
      actualTokensIn: 3800,
      actualTokensOut: 800,
      processingMs: 1100,
      error: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/status`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.job).not.toBeNull();
    expect(body.data.batches).toHaveLength(1);
    expect(body.data.progress).toEqual({ processed: 5, total: 10, percent: 50 });
  });

  // ─── GET /chats/:id/enrich/result ────────────────────────────────────
  it('GET /chats/:id/enrich/result — paginates', async () => {
    for (let i = 0; i < 7; i++) {
      seedArticle(chatId, { sentiment: { overall: 'positive' } });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/result?page=1&pageSize=3`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.articles).toHaveLength(3);
    expect(body.data.pagination).toMatchObject({
      page: 1,
      pageSize: 3,
      total: 7,
      totalPages: 3,
    });
  });

  it('GET /chats/:id/enrich/result — out-of-range page → empty articles', async () => {
    for (let i = 0; i < 3; i++) {
      seedArticle(chatId, { sentiment: { overall: 'positive' } });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/result?page=99&pageSize=50`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.articles).toEqual([]);
  });

  // ─── GET /chats/:id/enrich/json ──────────────────────────────────────
  it('GET /chats/:id/enrich/json — computes + persists; second call returns cached', async () => {
    seedParams(chatId);
    const job = seedJob(chatId);
    seedArticle(chatId, { sentiment: { overall: 'positive' } });
    seedArticle(chatId, { sentiment: { overall: 'negative' } });

    // First call — computes and persists.
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/json`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.data.cached).toBe(false);
    expect(firstBody.data.dashboard.articles).toHaveLength(2);

    // Persisted onto the job row.
    expect(job.dashboardJson).not.toBeNull();

    // WS event emitted exactly once.
    const jsonReadyCalls = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'enrichment:json-ready',
    );
    expect(jsonReadyCalls).toHaveLength(1);
    expect(jsonReadyCalls[0]![2]).toMatchObject({
      chatId,
      artifactId: job.id,
      articleCount: 2,
    });

    // Second call — cached path. WS event NOT re-emitted.
    publishChatEventMock.mockClear();
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/json`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.cached).toBe(true);
    const secondJsonReady = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'enrichment:json-ready',
    );
    expect(secondJsonReady).toHaveLength(0);
  });

  it('GET /chats/:id/enrich/json — 404 when no job exists', async () => {
    seedParams(chatId);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/json`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── GET /chats/:id/enrich/summary ───────────────────────────────────
  it('GET /chats/:id/enrich/summary — returns aggregations', async () => {
    seedArticle(chatId, { sentiment: { overall: 'positive' } });
    seedArticle(chatId, { sentiment: { overall: 'negative' } });
    seedArticle(chatId, { sentiment: { overall: 'neutral' } });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/summary`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.totalArticles).toBe(3);
    expect(body.data.sentimentDistribution).toEqual({
      positive: 1,
      neutral: 1,
      negative: 1,
    });
  });

  // ─── GET /enrichments/:articleId ─────────────────────────────────────
  it('GET /enrichments/:articleId — returns detail', async () => {
    const article = seedArticle(chatId, { sentiment: { overall: 'positive' } });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/enrichments/${article.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.article.id).toBe(article.id);
    expect(body.data.enrichment).not.toBeNull();
  });

  it('GET /enrichments/:articleId — 404 cross-user (RLS)', async () => {
    const article = seedArticle(chatId, { sentiment: { overall: 'positive' } });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/enrichments/${article.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── POST /chats/:id/reach/fetch ─────────────────────────────────────
  it('POST /chats/:id/reach/fetch — enqueues reach-fetch', async () => {
    const job = seedJob(chatId, { enrichmentType: 'reach' });
    seedArticle(chatId, undefined, { publisherDomain: 'reuters.com' });
    seedArticle(chatId, undefined, { publisherDomain: 'bbc.com' });
    seedArticle(chatId, undefined, { publisherDomain: 'reuters.com' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/reach/fetch`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.jobId).toBe(job.id);
    expect(body.data.domains).toBe(2); // DISTINCT
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![0]).toBe('reach-fetch');
  });

  it('POST /chats/:id/reach/fetch — 404 when no job exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/reach/fetch`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  // ─── GET /reach/cache/:domain ────────────────────────────────────────
  it('GET /reach/cache/:domain — returns row (cross-user — global)', async () => {
    reachCacheStore.push({
      domain: 'reuters.com',
      monthlyVisitors: BigInt(50_000_000),
      globalRank: 100,
      category: 'News and Media',
      score: 95,
      rawResponse: {},
      fetchedAt: new Date(),
      ttlHours: 168,
      isValid: true,
    });

    // userB sees the SAME global row — reach_cache bypasses RLS.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reach/cache/reuters.com`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.domain).toBe('reuters.com');
    expect(body.data.monthlyVisitors).toBe(50_000_000); // BigInt → Number
    expect(body.data.score).toBe(95);
  });

  it('GET /reach/cache/:domain — 404 when no row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/reach/cache/unknown.example`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── POST /chats/:id/enrich/retry ────────────────────────────────────
  it('POST /chats/:id/enrich/retry — re-enqueues failed batches', async () => {
    const job = seedJob(chatId, {
      batchCount: 3,
      batchesCompleted: 3,
      status: 'partial',
    });
    batchStore.push(
      {
        id: randomUUID(),
        jobId: job.id,
        batchNumber: 1,
        status: 'completed',
        retryCount: 0,
        estimatedTokens: 1000,
        actualTokensIn: 900,
        actualTokensOut: 200,
        processingMs: 800,
        error: null,
      },
      {
        id: randomUUID(),
        jobId: job.id,
        batchNumber: 2,
        status: 'failed',
        retryCount: 3,
        estimatedTokens: 1200,
        actualTokensIn: null,
        actualTokensOut: null,
        processingMs: 5000,
        error: 'timeout',
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich/retry`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.retriedBatches).toBe(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![0]).toBe('enrich-batch');
  });

  it('POST /chats/:id/enrich/retry — 404 when no job exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich/retry`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
