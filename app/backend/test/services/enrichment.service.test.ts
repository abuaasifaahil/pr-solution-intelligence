/**
 * M8.7 — enrichment.service unit tests.
 *
 * Exercises the aggregator + summary on top of in-memory mocks for the
 * Prisma layer. The withUser RLS wrapper is faked so we directly hand
 * the mock objects to the service callbacks; the suite doesn't need
 * Redis or Postgres.
 *
 * @file backend/test/services/enrichment.service.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ───────────────────────────────────────────────────────────────────────
// In-memory stores
// ───────────────────────────────────────────────────────────────────────
interface ChatRow {
  id: string;
  userId: string;
}
interface ParamsRow {
  chatId: string;
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
  enrichment?: EnrichmentRow | null;
}
interface EnrichmentRow {
  id: string;
  articleId: string;
  chatId: string;
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

const chatStore: ChatRow[] = [];
const paramsStore: ParamsRow[] = [];
const articleStore: ArticleRow[] = [];
const enrichmentStore: EnrichmentRow[] = [];
const jobStore: JobRow[] = [];
const batchStore: BatchRow[] = [];

const chatMock = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    chatStore.find((c) => c.id === where.id) ?? null,
  ),
};
const chatParamsMock = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((p) => p.chatId === where.chatId) ?? null,
  ),
};
const articleMock = {
  count: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    articleStore.filter((a) => a.chatId === where.chatId).length,
  ),
  findMany: vi.fn(
    async ({
      where,
      include,
      skip,
      take,
    }: {
      where: { chatId: string };
      include?: { enrichment?: boolean };
      orderBy?: unknown;
      skip?: number;
      take?: number;
    }) => {
      let rows = articleStore.filter((a) => a.chatId === where.chatId);
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
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    articleStore.find((a) => a.id === where.id) ?? null,
  ),
};
const enrichmentMock = {
  findMany: vi.fn(
    async ({
      where,
      include,
    }: {
      where: { chatId: string; isValid?: boolean };
      include?: { article?: { select: { publisherDomain: true } } };
    }) => {
      const rows = enrichmentStore.filter(
        (e) =>
          e.chatId === where.chatId &&
          (where.isValid === undefined || e.isValid === where.isValid),
      );
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
    const rows = jobStore.filter((j) => j.chatId === where.chatId);
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

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    chat: chatMock,
    chatParams: chatParamsMock,
    article: articleMock,
    enrichment: enrichmentMock,
    enrichmentJob: enrichmentJobMock,
    enrichmentBatch: enrichmentBatchMock,
    reachCache: { findUnique: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      chat: chatMock,
      chatParams: chatParamsMock,
      article: articleMock,
      enrichment: enrichmentMock,
      enrichmentJob: enrichmentJobMock,
      enrichmentBatch: enrichmentBatchMock,
    }),
  ),
  asAdmin: vi.fn(),
}));

const publishAgentBusMock = vi.fn(async (_chan: string, _payload: unknown) => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishAgentBus: publishAgentBusMock,
  publishChatEvent: vi.fn(),
  subscribeChatEvents: vi.fn(),
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

const {
  enqueueManualEnrich,
  buildDashboardJson,
  buildSummary,
  listEnrichedArticles,
  getLatestJobStatus,
  retryFailedBatches,
} = await import('../../src/services/enrichment.service.js');

// ───────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────
const USER_A = randomUUID();
const CHAT_A = randomUUID();

function seedChat(): void {
  chatStore.push({ id: CHAT_A, userId: USER_A });
}

function seedParams(overrides: Partial<ParamsRow> = {}): void {
  paramsStore.push({
    chatId: CHAT_A,
    brand: 'FreshSip',
    competitors: ['PepsiCo', 'Coca-Cola'],
    dateStart: new Date('2026-05-01'),
    dateEnd: new Date('2026-05-20'),
    enrichmentType: 'standard',
    flowState: 'complete',
    ...overrides,
  });
}

function seedJob(overrides: Partial<JobRow> = {}): JobRow {
  const row: JobRow = {
    id: randomUUID(),
    chatId: CHAT_A,
    userId: USER_A,
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

function seedArticle(
  rawData: unknown = {},
  enrichment?: Partial<EnrichmentRow>,
  overrides: Partial<ArticleRow> = {},
): ArticleRow {
  const id = randomUUID();
  const article: ArticleRow = {
    id,
    chatId: CHAT_A,
    title: `Article ${id.slice(0, 4)}`,
    content: 'body',
    description: 'desc',
    source: 'Reuters',
    author: 'Jane Doe',
    publishedDate: new Date('2026-05-15'),
    url: 'https://example.com/a',
    publisherDomain: 'example.com',
    language: 'en',
    rawData,
    ...overrides,
  };
  articleStore.push(article);
  if (enrichment) {
    enrichmentStore.push({
      id: randomUUID(),
      articleId: id,
      chatId: CHAT_A,
      sentiment: { overall: 'positive', score: 0.8 },
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

beforeEach(() => {
  chatStore.length = 0;
  paramsStore.length = 0;
  articleStore.length = 0;
  enrichmentStore.length = 0;
  jobStore.length = 0;
  batchStore.length = 0;
  publishAgentBusMock.mockClear();
  queueAddMock.mockClear();
});

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────

describe('enrichment.service — buildDashboardJson', () => {
  it('happy path: 3 articles with enrichments → full structure returned', async () => {
    seedChat();
    seedParams();
    seedJob();
    seedArticle({}, { sentiment: { overall: 'positive', score: 0.8 } });
    seedArticle({}, { sentiment: { overall: 'negative', score: -0.6 } });
    seedArticle({}, { sentiment: { overall: 'neutral', score: 0.0 } });

    const json = await buildDashboardJson(USER_A, CHAT_A);
    expect(json.chatId).toBe(CHAT_A);
    expect(json.jobId).toBe(jobStore[0]!.id);
    expect(json.analysisContext.brand).toBe('FreshSip');
    expect(json.analysisContext.competitors).toEqual(['PepsiCo', 'Coca-Cola']);
    expect(json.analysisContext.dateRange).toEqual({
      start: new Date('2026-05-01').toISOString(),
      end: new Date('2026-05-20').toISOString(),
    });
    expect(json.analysisContext.enrichmentType).toBe('standard');
    expect(json.analysisContext.modelUsed).toBe('gpt-4.1');
    expect(json.articles).toHaveLength(3);
    expect(json.articles[0]!.enrichment).not.toBeNull();
    expect(json.stats.totalArticles).toBe(3);
    expect(json.stats.enrichedCount).toBe(3);
    expect(json.stats.sentimentDistribution).toEqual({
      positive: 1,
      neutral: 1,
      negative: 1,
    });
  });

  it('throws "No enrichment job" when no job exists', async () => {
    seedChat();
    seedParams();
    await expect(buildDashboardJson(USER_A, CHAT_A)).rejects.toThrow(
      /No enrichment job/,
    );
  });

  it('throws "Chat not found" when chat missing', async () => {
    await expect(buildDashboardJson(USER_A, CHAT_A)).rejects.toThrow('Chat not found');
  });

  it('extracts social engagement from raw_data', async () => {
    seedChat();
    seedParams();
    seedJob();
    seedArticle({
      likes: 1500,
      shares: 100,
      comments: 50,
      // engagement_rate is non-integer; preserved as-is.
      engagement_rate: 0.04,
    }, { sentiment: { overall: 'positive', score: 0.5 } });

    const json = await buildDashboardJson(USER_A, CHAT_A);
    expect(json.articles[0]!.socialEngagement).toEqual({
      likes: 1500,
      shares: 100,
      comments: 50,
      engagement_rate: 0.04,
    });
  });

  it('socialEngagement null when raw_data has no engagement fields', async () => {
    seedChat();
    seedParams();
    seedJob();
    seedArticle({ unrelated_field: 'foo' }, { sentiment: { overall: 'neutral' } });
    const json = await buildDashboardJson(USER_A, CHAT_A);
    expect(json.articles[0]!.socialEngagement).toBeNull();
  });

  it('mediaType defaults to "Online News" when raw_data omits it', async () => {
    seedChat();
    seedParams();
    seedJob();
    seedArticle({}, { sentiment: { overall: 'positive' } });
    const json = await buildDashboardJson(USER_A, CHAT_A);
    expect(json.articles[0]!.mediaType).toBe('Online News');
  });
});

describe('enrichment.service — buildSummary', () => {
  it('computes sentiment distribution', async () => {
    seedChat();
    seedArticle({}, { sentiment: { overall: 'positive' } });
    seedArticle({}, { sentiment: { overall: 'positive' } });
    seedArticle({}, { sentiment: { overall: 'negative' } });
    seedArticle({}, { sentiment: { overall: 'neutral' } });
    seedArticle({}, { sentiment: { overall: 'neutral' } });

    const summary = await buildSummary(USER_A, CHAT_A);
    expect(summary.totalArticles).toBe(5);
    expect(summary.sentimentDistribution).toEqual({
      positive: 2,
      neutral: 2,
      negative: 1,
    });
  });

  it('computes top 10 themes / top 20 entities / top signals', async () => {
    seedChat();
    // Three articles all share the same main theme; entity counts diverge.
    seedArticle({}, {
      sentiment: { overall: 'positive' },
      themes: { main: ['AI Ethics'], secondary: ['Regulation'], tertiary: [] },
      entities: { organization: ['OpenAI', 'Anthropic'], person: ['Sam Altman'] },
      signals: [{ type: 'emerging', description: 'AI safety push' }],
    });
    seedArticle({}, {
      sentiment: { overall: 'neutral' },
      themes: { main: ['AI Ethics'], secondary: [], tertiary: [] },
      entities: { organization: ['OpenAI'], person: [] },
      signals: [
        { type: 'emerging', description: 'AI safety push' },
        { type: 'crisis', description: 'Major outage' },
      ],
    });
    seedArticle({}, {
      sentiment: { overall: 'positive' },
      themes: { main: ['Product Launch'], secondary: [], tertiary: [] },
      entities: { organization: ['OpenAI', 'Microsoft'] },
      signals: [],
    });

    const summary = await buildSummary(USER_A, CHAT_A);
    expect(summary.topThemes[0]).toMatchObject({
      name: 'AI Ethics',
      level: 'main',
      count: 2,
    });
    expect(summary.topEntities[0]).toMatchObject({
      name: 'OpenAI',
      type: 'organization',
      count: 3,
    });
    expect(summary.topSignals[0]).toMatchObject({ type: 'emerging', count: 2 });
    expect(summary.topSignals.find((s) => s.type === 'crisis')).toMatchObject({
      type: 'crisis',
      count: 1,
    });
  });

  it('caps themes at 10 / entities at 20', async () => {
    seedChat();
    // 25 unique main themes + 30 unique organizations — assert caps.
    const themes: string[] = [];
    const orgs: string[] = [];
    for (let i = 0; i < 25; i++) themes.push(`Theme ${i}`);
    for (let i = 0; i < 30; i++) orgs.push(`Org ${i}`);
    seedArticle({}, {
      sentiment: { overall: 'positive' },
      themes: { main: themes, secondary: [], tertiary: [] },
      entities: { organization: orgs },
      signals: [],
    });
    const summary = await buildSummary(USER_A, CHAT_A);
    expect(summary.topThemes).toHaveLength(10);
    expect(summary.topEntities).toHaveLength(20);
  });

  it('includes reachStats when reach data present', async () => {
    seedChat();
    seedArticle({}, {
      sentiment: { overall: 'positive' },
      reach: { domain: 'example.com', monthly_visitors: 1_000_000, score: 75 },
    }, { publisherDomain: 'example.com' });
    seedArticle({}, {
      sentiment: { overall: 'neutral' },
      reach: { domain: 'reuters.com', monthly_visitors: 50_000_000, score: 95 },
    }, { publisherDomain: 'reuters.com' });

    const summary = await buildSummary(USER_A, CHAT_A);
    expect(summary.reachStats).toBeDefined();
    expect(summary.reachStats!.totalDomains).toBe(2);
    expect(summary.reachStats!.resolved).toBe(2);
    expect(summary.reachStats!.avgScore).toBe(Math.round((75 + 95) / 2));
    // reuters.com has higher monthly_visitors so it sorts first.
    expect(summary.reachStats!.topDomains[0]!.domain).toBe('reuters.com');
  });

  it('omits reachStats when no reach data present', async () => {
    seedChat();
    seedArticle({}, { sentiment: { overall: 'positive' } });
    const summary = await buildSummary(USER_A, CHAT_A);
    expect(summary.reachStats).toBeUndefined();
  });
});

describe('enrichment.service — listEnrichedArticles', () => {
  it('paginates and clamps pageSize to 1-200', async () => {
    seedChat();
    for (let i = 0; i < 12; i++) {
      seedArticle({}, { sentiment: { overall: 'positive' } });
    }
    const page1 = await listEnrichedArticles(USER_A, CHAT_A, 1, 5);
    expect(page1.articles).toHaveLength(5);
    expect(page1.pagination.total).toBe(12);
    expect(page1.pagination.totalPages).toBe(3);

    // Out-of-range page returns an empty page but echoes safe pagination.
    const beyond = await listEnrichedArticles(USER_A, CHAT_A, 99, 5);
    expect(beyond.articles).toHaveLength(0);

    // Page size > 200 clamps to 200.
    const clamped = await listEnrichedArticles(USER_A, CHAT_A, 1, 5000);
    expect(clamped.pagination.pageSize).toBe(200);
  });
});

describe('enrichment.service — getLatestJobStatus', () => {
  it('returns job + batches + progress', async () => {
    seedChat();
    const job = seedJob({
      processedCount: 5,
      totalArticles: 10,
      enrichmentType: 'standard',
    });
    batchStore.push({
      id: randomUUID(),
      jobId: job.id,
      batchNumber: 1,
      status: 'completed',
      retryCount: 0,
      estimatedTokens: 5000,
      actualTokensIn: 4800,
      actualTokensOut: 1200,
      processingMs: 1500,
      error: null,
    });

    const out = await getLatestJobStatus(USER_A, CHAT_A);
    expect(out.job).not.toBeNull();
    expect(out.batches).toHaveLength(1);
    expect(out.progress).toEqual({ processed: 5, total: 10, percent: 50 });
    expect(out.reachCoverage).toBeUndefined();
  });

  it('returns reachCoverage when enrichmentType==reach', async () => {
    seedChat();
    const job = seedJob({ enrichmentType: 'reach' });
    // Two enrichments — one with reach, one without.
    seedArticle({}, {
      sentiment: { overall: 'positive' },
      reach: { domain: 'a.com', monthly_visitors: 1000, score: 50 },
    });
    seedArticle({}, { sentiment: { overall: 'positive' }, reach: null });
    expect(job.enrichmentType).toBe('reach');

    const out = await getLatestJobStatus(USER_A, CHAT_A);
    expect(out.reachCoverage).toEqual({ resolved: 1, total: 2, percent: 50 });
  });

  it('returns empty status when no job exists', async () => {
    seedChat();
    const out = await getLatestJobStatus(USER_A, CHAT_A);
    expect(out.job).toBeNull();
    expect(out.batches).toEqual([]);
    expect(out.progress).toEqual({ processed: 0, total: 0, percent: 0 });
  });
});

describe('enrichment.service — enqueueManualEnrich', () => {
  it('publishes to agent:enrichment:incoming on happy path', async () => {
    seedChat();
    seedParams({ flowState: 'complete' });

    const out = await enqueueManualEnrich(USER_A, CHAT_A);
    expect(out.message).toBe('enqueued');
    expect(out.enrichmentType).toBe('standard');
    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock.mock.calls[0]![0]).toBe('agent:enrichment:incoming');
  });

  it('throws "Articles not yet extracted" when flow !== complete', async () => {
    seedChat();
    seedParams({ flowState: 'collect_brand' });
    await expect(enqueueManualEnrich(USER_A, CHAT_A)).rejects.toThrow(
      /Articles not yet extracted/,
    );
    expect(publishAgentBusMock).not.toHaveBeenCalled();
  });

  it('throws "Chat not found" when chat row missing', async () => {
    await expect(enqueueManualEnrich(USER_A, CHAT_A)).rejects.toThrow(
      'Chat not found',
    );
  });

  it('honors body.enrichmentType override', async () => {
    seedChat();
    seedParams({ flowState: 'complete', enrichmentType: 'standard' });
    const out = await enqueueManualEnrich(USER_A, CHAT_A, 'reach');
    expect(out.enrichmentType).toBe('reach');
    const payload = publishAgentBusMock.mock.calls[0]![1] as {
      enrichmentType: string;
    };
    expect(payload.enrichmentType).toBe('reach');
  });
});

describe('enrichment.service — retryFailedBatches', () => {
  it('re-enqueues failed batches and resets state', async () => {
    seedChat();
    const job = seedJob({ batchCount: 3, batchesCompleted: 3, status: 'partial' });
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
        processingMs: 1000,
        error: null,
      },
      {
        id: randomUUID(),
        jobId: job.id,
        batchNumber: 2,
        status: 'failed',
        retryCount: 3,
        estimatedTokens: 1500,
        actualTokensIn: null,
        actualTokensOut: null,
        processingMs: 5000,
        error: 'LLM timeout',
      },
      {
        id: randomUUID(),
        jobId: job.id,
        batchNumber: 3,
        status: 'failed',
        retryCount: 3,
        estimatedTokens: 2000,
        actualTokensIn: null,
        actualTokensOut: null,
        processingMs: 5000,
        error: 'schema validation failed',
      },
    );

    const out = await retryFailedBatches(USER_A, CHAT_A);
    expect(out.retriedBatches).toBe(2);
    expect(queueAddMock).toHaveBeenCalledTimes(2);

    const resetBatches = batchStore.filter(
      (b) => b.batchNumber === 2 || b.batchNumber === 3,
    );
    for (const b of resetBatches) {
      expect(b.status).toBe('pending');
      expect(b.retryCount).toBe(0);
      expect(b.error).toBeNull();
    }
  });

  it('throws "No enrichment job" when none exists', async () => {
    seedChat();
    await expect(retryFailedBatches(USER_A, CHAT_A)).rejects.toThrow(
      'No enrichment job for this chat',
    );
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});
