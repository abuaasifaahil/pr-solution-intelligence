/**
 * M8.4 — EnrichmentAgent unit tests.
 *
 * Pure-unit suite. Prisma + RLS replaced with in-memory mocks; the LLM
 * gateway, queue, and event bus are captured. Mirrors the patterns used by
 * `data-extract.agent.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────
// In-memory stores
// ───────────────────────────────────────────────────────────────────────
interface ParamsRow {
  chatId: string;
  enrichmentType: 'standard' | 'reach' | null;
}
interface ArticleRow {
  id: string;
  chatId: string;
  content: string | null;
  description: string | null;
}
interface EnrichmentJobRow {
  id: string;
  chatId: string;
  userId: string;
  totalArticles: number;
  batchCount: number;
  modelUsed: string;
  enrichmentType: 'standard' | 'reach';
  status: string;
  startedAt: Date | null;
}
interface EnrichmentBatchRow {
  id: string;
  jobId: string;
  batchNumber: number;
  articleIds: string[];
  estimatedTokens: number;
  status: string;
}

const paramsStore: ParamsRow[] = [];
const articleStore: ArticleRow[] = [];
const enrichmentJobStore: EnrichmentJobRow[] = [];
const enrichmentBatchStore: EnrichmentBatchRow[] = [];

let jobIdCounter = 0;
let batchIdCounter = 0;

const mockChatParams = {
  findUnique: vi.fn(
    async ({ where }: { where: { chatId: string } }) =>
      paramsStore.find((r) => r.chatId === where.chatId) ?? null,
  ),
};

const mockArticle = {
  findMany: vi.fn(
    async ({
      where,
      select: _select,
    }: {
      where: { chatId?: string; id?: { in: string[] } };
      select?: unknown;
    }) => {
      return articleStore
        .filter((a) => {
          if (where.chatId && a.chatId !== where.chatId) return false;
          if (where.id?.in && !where.id.in.includes(a.id)) return false;
          return true;
        })
        .map((a) => ({ id: a.id, content: a.content, description: a.description }));
    },
  ),
};

const mockEnrichmentJob = {
  create: vi.fn(async ({ data }: { data: Omit<EnrichmentJobRow, 'id'> }) => {
    const row: EnrichmentJobRow = { id: `job-${++jobIdCounter}`, ...data };
    enrichmentJobStore.push(row);
    return row;
  }),
};

const mockEnrichmentBatch = {
  create: vi.fn(async ({ data }: { data: Omit<EnrichmentBatchRow, 'id'> }) => {
    const row: EnrichmentBatchRow = { id: `batch-${++batchIdCounter}`, ...data };
    enrichmentBatchStore.push(row);
    return row;
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    chatParams: mockChatParams,
    article: mockArticle,
    enrichmentJob: mockEnrichmentJob,
    enrichmentBatch: mockEnrichmentBatch,
    agentLog: { create: vi.fn().mockResolvedValue({}) },
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      chatParams: mockChatParams,
      article: mockArticle,
      enrichmentJob: mockEnrichmentJob,
      enrichmentBatch: mockEnrichmentBatch,
    }),
  ),
  asAdmin: vi.fn(),
}));

// LLM gateway — return a deterministic stub provider + a simple planBatching
// that creates one batch per article (predictable for assertions).
const fakeProvider = {
  id: 'azure-openai' as const,
  config: {
    modelName: 'gpt-4.1',
    maxInputTokens: 200_000,
    defaultMaxOutputTokens: 4_000,
  },
  countTokens: (s: string) => s.length,
  complete: vi.fn(),
};

const getModelMock = vi.fn(async () => fakeProvider);
const planBatchingMock = vi.fn(
  (articles: Array<{ id: string; content: string }>) => ({
    batches: articles.map((a) => ({ articleIds: [a.id], estimatedTokens: 10 })),
    totalEstimatedTokens: articles.length * 10,
  }),
);

vi.mock('../../src/lib/llm-gateway.js', () => ({
  getModel: getModelMock,
  planBatching: planBatchingMock,
  countTokens: (s: string) => s.length,
}));

const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: vi.fn(async () => {}),
  subscribeChatEvents: vi.fn(),
}));

const queueAddMock = vi.fn(
  async (_name: string, _data: Record<string, unknown>) => ({
    id: 'fake-job-id',
  }),
);
vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => ({ add: queueAddMock }),
  startInlineWorker: vi.fn(),
  closeQueue: vi.fn(),
  QUEUE_NAME_PHASE2: 'phase2-jobs',
}));

const { EnrichmentAgent } = await import('../../src/agents/enrichment.agent.js');

const USER = '00000000-0000-0000-0000-00000000aaaa';
const CHAT = '00000000-0000-0000-0000-00000000bbbb';

function seedArticles(n: number, chatId = CHAT): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `art-${i}`;
    articleStore.push({
      id,
      chatId,
      content: `body of article ${i}`,
      description: null,
    });
    ids.push(id);
  }
  return ids;
}

function seedParams(type: 'standard' | 'reach' | null = 'standard') {
  paramsStore.push({ chatId: CHAT, enrichmentType: type });
}

function newAgent() {
  return new EnrichmentAgent('id-1', 'Enrichment Agent', 'enrichment');
}

beforeEach(() => {
  paramsStore.length = 0;
  articleStore.length = 0;
  enrichmentJobStore.length = 0;
  enrichmentBatchStore.length = 0;
  jobIdCounter = 0;
  batchIdCounter = 0;
  mockChatParams.findUnique.mockClear();
  mockArticle.findMany.mockClear();
  mockEnrichmentJob.create.mockClear();
  mockEnrichmentBatch.create.mockClear();
  getModelMock.mockClear();
  planBatchingMock.mockClear();
  publishChatEventMock.mockClear();
  queueAddMock.mockClear();
  delete process.env.MAX_TOKENS_PER_JOB;
});

describe('EnrichmentAgent.perceive', () => {
  it('loads ALL articles for the chat when articleIds is empty', async () => {
    seedParams('standard');
    seedArticles(3);
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    })) as unknown as { articleIds: string[]; enrichmentType: string };
    expect(ctx.articleIds).toHaveLength(3);
    // Verify it queried by chatId without an id filter.
    expect(mockArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: CHAT },
        select: { id: true, content: true, description: true },
      }),
    );
  });

  it('respects explicit articleIds — filters to subset', async () => {
    seedParams('standard');
    const ids = seedArticles(5);
    const subset = [ids[0]!, ids[2]!];
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: subset },
    })) as unknown as { articleIds: string[] };
    expect(ctx.articleIds.sort()).toEqual(subset.sort());
    expect(mockArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: subset }, chatId: CHAT },
      }),
    );
  });

  it('derives enrichmentType from chat_params when caller does not supply one', async () => {
    seedParams('reach');
    seedArticles(2);
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    })) as unknown as { enrichmentType: 'standard' | 'reach' };
    expect(ctx.enrichmentType).toBe('reach');
  });

  it('caller-supplied enrichmentType wins over chat_params', async () => {
    seedParams('standard');
    seedArticles(2);
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [], enrichmentType: 'reach' },
    })) as unknown as { enrichmentType: 'standard' | 'reach' };
    expect(ctx.enrichmentType).toBe('reach');
  });

  it('defaults enrichmentType to standard when nothing is configured', async () => {
    // No chat_params row at all.
    seedArticles(2);
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    })) as unknown as { enrichmentType: 'standard' | 'reach' };
    expect(ctx.enrichmentType).toBe('standard');
  });

  it('throws when no articles match', async () => {
    seedParams('standard');
    // No articles seeded.
    const agent = newAgent();
    await expect(
      agent.perceive({
        userId: USER,
        chatId: CHAT,
        message: '',
        metadata: { articleIds: [] },
      }),
    ).rejects.toThrow(/no articles found/);
  });

  it('throws when chatId is missing', async () => {
    const agent = newAgent();
    await expect(
      agent.perceive({
        userId: USER,
        message: '',
        metadata: { articleIds: [] },
      } as Parameters<typeof agent.perceive>[0]),
    ).rejects.toThrow(/chatId/);
  });
});

describe('EnrichmentAgent.reason', () => {
  it('computes batches via planBatching and returns the total', async () => {
    seedParams('standard');
    seedArticles(4);
    const agent = newAgent();
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    });
    const r = (await agent.reason(ctx)) as unknown as {
      batches: Array<{ articleIds: string[]; estimatedTokens: number }>;
      totalEstimatedTokens: number;
    };
    expect(planBatchingMock).toHaveBeenCalledTimes(1);
    expect(r.batches).toHaveLength(4); // mock returns one batch per article
    // total = 4 articles * 10 token estimate + 4 batches * 900 (few-shot)
    expect(r.totalEstimatedTokens).toBe(40 + 4 * 900);
  });

  it('throws when totalEstimatedTokens exceeds MAX_TOKENS_PER_JOB', async () => {
    process.env.MAX_TOKENS_PER_JOB = '100';
    // planBatching returns 1 batch * 900 overhead = 900 >> 100.
    seedParams('standard');
    seedArticles(1);
    // Re-import to pick up env change.
    vi.resetModules();
    const { EnrichmentAgent: Fresh } = await import(
      '../../src/agents/enrichment.agent.js'
    );
    const agent = new Fresh('id-1', 'Enrichment Agent', 'enrichment');
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    });
    await expect(agent.reason(ctx)).rejects.toThrow(/MAX_TOKENS_PER_JOB/);
  });
});

describe('EnrichmentAgent.plan', () => {
  it('writes enrichment_job + N enrichment_batches rows and returns batch ids', async () => {
    seedParams('standard');
    seedArticles(3);
    const agent = newAgent();
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    });
    const reasoned = await agent.reason(ctx);
    const plan = (await agent.plan(reasoned)) as unknown as {
      jobId: string;
      batches: Array<{ id: string; batchNumber: number }>;
    };

    expect(mockEnrichmentJob.create).toHaveBeenCalledTimes(1);
    const jobCreateArgs = mockEnrichmentJob.create.mock.calls[0]![0] as {
      data: EnrichmentJobRow;
    };
    expect(jobCreateArgs.data.chatId).toBe(CHAT);
    expect(jobCreateArgs.data.userId).toBe(USER);
    expect(jobCreateArgs.data.totalArticles).toBe(3);
    expect(jobCreateArgs.data.batchCount).toBe(3);
    expect(jobCreateArgs.data.modelUsed).toBe('gpt-4.1');
    expect(jobCreateArgs.data.enrichmentType).toBe('standard');
    expect(jobCreateArgs.data.status).toBe('processing');

    expect(mockEnrichmentBatch.create).toHaveBeenCalledTimes(3);
    expect(plan.batches).toHaveLength(3);
    expect(plan.batches.map((b) => b.batchNumber)).toEqual([1, 2, 3]);
    expect(plan.jobId).toBe('job-1');
  });
});

describe('EnrichmentAgent.act', () => {
  async function fullLifecycleThroughPlan(
    enrichmentType: 'standard' | 'reach' = 'standard',
  ) {
    seedParams(enrichmentType);
    seedArticles(3);
    const agent = newAgent();
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { articleIds: [] },
    });
    const reasoned = await agent.reason(ctx);
    const plan = await agent.plan(reasoned);
    return { agent, plan };
  }

  it('publishes enrichment:start with the job + counts', async () => {
    const { agent, plan } = await fullLifecycleThroughPlan('standard');
    await agent.act(plan);
    const startCalls = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'enrichment:start',
    );
    expect(startCalls).toHaveLength(1);
    const payload = startCalls[0]![2] as {
      jobId: string;
      totalArticles: number;
      batchCount: number;
      model: string;
    };
    expect(payload.jobId).toBe('job-1');
    expect(payload.totalArticles).toBe(3);
    expect(payload.batchCount).toBe(3);
    expect(payload.model).toBe('gpt-4.1');
  });

  it('enqueues one enrich-batch job per batch with the correct payload', async () => {
    const { agent, plan } = await fullLifecycleThroughPlan('standard');
    await agent.act(plan);
    const enrichCalls = queueAddMock.mock.calls.filter(
      (c) => c[0] === 'enrich-batch',
    );
    expect(enrichCalls).toHaveLength(3);
    // Inspect batch 1 payload shape.
    const payload = enrichCalls[0]![1] as {
      jobId: string;
      batchId: string;
      batchNumber: number;
      chatId: string;
      userId: string;
      articleIds: string[];
      enrichmentType: string;
      modelName: string;
    };
    expect(payload.jobId).toBe('job-1');
    expect(payload.batchId).toBe('batch-1');
    expect(payload.batchNumber).toBe(1);
    expect(payload.chatId).toBe(CHAT);
    expect(payload.userId).toBe(USER);
    expect(payload.enrichmentType).toBe('standard');
    expect(payload.modelName).toBe('gpt-4.1');
    expect(payload.articleIds).toEqual(['art-0']);
  });

  it('with enrichmentType=reach: also queues a single reach-fetch job', async () => {
    const { agent, plan } = await fullLifecycleThroughPlan('reach');
    await agent.act(plan);
    const reachCalls = queueAddMock.mock.calls.filter(
      (c) => c[0] === 'reach-fetch',
    );
    expect(reachCalls).toHaveLength(1);
    const payload = reachCalls[0]![1] as {
      jobId: string;
      chatId: string;
      userId: string;
    };
    expect(payload.jobId).toBe('job-1');
    expect(payload.chatId).toBe(CHAT);
    expect(payload.userId).toBe(USER);
  });

  it('with enrichmentType=standard: does NOT queue a reach-fetch job', async () => {
    const { agent, plan } = await fullLifecycleThroughPlan('standard');
    await agent.act(plan);
    const reachCalls = queueAddMock.mock.calls.filter(
      (c) => c[0] === 'reach-fetch',
    );
    expect(reachCalls).toHaveLength(0);
  });

  it('returns a result reflecting the job + batches', async () => {
    const { agent, plan } = await fullLifecycleThroughPlan('standard');
    const result = (await agent.act(plan)) as {
      jobId: string;
      batchCount: number;
      totalArticles: number;
    };
    expect(result.jobId).toBe('job-1');
    expect(result.batchCount).toBe(3);
    expect(result.totalArticles).toBe(3);
  });
});

describe('EnrichmentAgent.reflect / logAction', () => {
  it('reflect is a no-op (returns undefined, does not throw)', async () => {
    const agent = newAgent();
    await expect(agent.reflect({ anything: 'goes' })).resolves.toBeUndefined();
  });

  it('logAction is overridden to no-op (no agent_logs write)', async () => {
    const agent = newAgent();
    // Override drops all args; we still pass the BaseAgent signature via
    // a cast so the test exercises the call path callers actually use.
    const log = agent.logAction as unknown as (
      action: string,
      input: unknown,
      output: unknown,
      durationMs: number,
    ) => Promise<void>;
    await expect(log('execute', { a: 1 }, { b: 2 }, 100)).resolves.toBeUndefined();
  });
});
