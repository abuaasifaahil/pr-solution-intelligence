/**
 * M7.7 — DataExtractAgent unit tests.
 *
 * Pure-unit suite: Prisma/RLS is replaced with in-memory mocks and the
 * event bus is captured. The full perceive → reason → plan → act → reflect
 * lifecycle runs without touching a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────
// In-memory mock stores
// ───────────────────────────────────────────────────────────────────────
interface ParamsRow {
  id: string;
  chatId: string;
  userId: string;
  flowState: string;
  brand: string | null;
  competitors: unknown;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  uploadId: string | null;
  collectedAt: Date | null;
}

interface UploadRow {
  id: string;
  status: string;
  rowCount: number | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
}

interface ArticleRow {
  id: string;
  uploadId: string | null;
  chatId: string;
  publisherDomain: string | null;
}

interface BooleanQueryRow {
  id: string;
  chatId: string;
  isConfirmed: boolean;
}

const paramsStore: ParamsRow[] = [];
const uploadStore: UploadRow[] = [];
const articleStore: ArticleRow[] = [];
const queryStore: BooleanQueryRow[] = [];

// Domain count: returned by tx.$queryRaw for the 'domains' step.
let domainCount = 0;

const mockChatParams = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((r) => r.chatId === where.chatId) ?? null,
  ),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { chatId: string };
      data: Partial<ParamsRow>;
    }) => {
      const r = paramsStore.find((x) => x.chatId === where.chatId);
      if (!r) throw new Error('not found');
      Object.assign(r, data);
      return { ...r };
    },
  ),
};

const mockUpload = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    uploadStore.find((u) => u.id === where.id) ?? null,
  ),
};

const mockArticle = {
  count: vi.fn(
    async ({ where }: { where: { chatId?: string; uploadId?: string | null } }) => {
      return articleStore.filter((a) => {
        if (where.chatId && a.chatId !== where.chatId) return false;
        if (where.uploadId && a.uploadId !== where.uploadId) return false;
        return true;
      }).length;
    },
  ),
};

const mockBooleanQuery = {
  findFirst: vi.fn(
    async ({ where }: { where: { id: string; chatId: string } }) =>
      queryStore.find((q) => q.id === where.id && q.chatId === where.chatId) ?? null,
  ),
};

// tx.$queryRaw is a tagged template; return [{ count: bigint }].
const mockQueryRaw = vi.fn(async () => [{ count: BigInt(domainCount) }]);

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    chatParams: mockChatParams,
    upload: mockUpload,
    article: mockArticle,
    booleanQuery: mockBooleanQuery,
    agentLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: mockQueryRaw,
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      chatParams: mockChatParams,
      upload: mockUpload,
      article: mockArticle,
      booleanQuery: mockBooleanQuery,
      $queryRaw: mockQueryRaw,
    }),
  ),
  asAdmin: vi.fn(),
}));

const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
const publishAgentBusMock = vi.fn(
  async (_channel: string, _payload: unknown) => {},
);
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: publishAgentBusMock,
  subscribeChatEvents: vi.fn(),
}));

const { DataExtractAgent } = await import('../../src/agents/data-extract.agent.js');

const USER = '00000000-0000-0000-0000-00000000aaaa';
const CHAT = '00000000-0000-0000-0000-00000000bbbb';
const UPLOAD = '00000000-0000-0000-0000-00000000cccc';
const QUERY = '00000000-0000-0000-0000-00000000dddd';

function seed(opts?: {
  uploadStatus?: string;
  rowCount?: number;
  articleCount?: number;
  dateRangeStart?: Date | null;
  dateRangeEnd?: Date | null;
  domainCount?: number;
}) {
  const dateStart = new Date('2025-01-01');
  const dateEnd = new Date('2025-01-31');
  paramsStore.push({
    id: 'p1',
    chatId: CHAT,
    userId: USER,
    flowState: 'processing',
    brand: 'Acme',
    competitors: ['Beta', 'Gamma'],
    dateStart,
    dateEnd,
    enrichmentType: 'standard',
    uploadId: UPLOAD,
    collectedAt: null,
  });
  uploadStore.push({
    id: UPLOAD,
    status: opts?.uploadStatus ?? 'ready',
    rowCount: opts?.rowCount ?? 10,
    dateRangeStart: opts?.dateRangeStart ?? dateStart,
    dateRangeEnd: opts?.dateRangeEnd ?? dateEnd,
  });
  const n = opts?.articleCount ?? 10;
  for (let i = 0; i < n; i++) {
    articleStore.push({
      id: `a${i}`,
      uploadId: UPLOAD,
      chatId: CHAT,
      publisherDomain: `pub${i % 3}.example.com`,
    });
  }
  queryStore.push({ id: QUERY, chatId: CHAT, isConfirmed: true });
  domainCount = opts?.domainCount ?? 3;
}

describe('DataExtractAgent', () => {
  beforeEach(() => {
    paramsStore.length = 0;
    uploadStore.length = 0;
    articleStore.length = 0;
    queryStore.length = 0;
    domainCount = 0;
    publishChatEventMock.mockClear();
    publishAgentBusMock.mockClear();
    mockChatParams.findUnique.mockClear();
    mockChatParams.update.mockClear();
    mockUpload.findFirst.mockClear();
    mockArticle.count.mockClear();
    mockBooleanQuery.findFirst.mockClear();
    mockQueryRaw.mockClear();
  });

  it('perceive — returns ctx with uploadId, brand, competitors, dateRange', async () => {
    seed();
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    })) as unknown as Record<string, unknown>;
    expect(ctx.userId).toBe(USER);
    expect(ctx.chatId).toBe(CHAT);
    expect(ctx.uploadId).toBe(UPLOAD);
    expect(ctx.brand).toBe('Acme');
    expect(ctx.competitors).toEqual(['Beta', 'Gamma']);
    expect((ctx.dateRange as { start: Date; end: Date }).start).toBeInstanceOf(Date);
    expect(ctx.articleCount).toBe(10);
  });

  it('reason — throws when uploadId is null (api_crawl path not supported)', async () => {
    seed();
    paramsStore[0]!.uploadId = null;
    uploadStore.length = 0;
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    });
    await expect(agent.reason(ctx)).rejects.toThrow(/API crawl/);
  });

  it('plan — returns 7 ordered steps with the spec names', async () => {
    seed();
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    });
    const reasoned = await agent.reason(ctx);
    const plan = (await agent.plan(reasoned)) as {
      steps: Array<{ name: string; key: string }>;
    };
    expect(plan.steps.map((s) => s.key)).toEqual([
      'validate',
      'parse',
      'dates',
      'domains',
      'normalize',
      'insert',
      'handoff',
    ]);
    expect(plan.steps.map((s) => s.name)).toEqual([
      'Validate Schema',
      'Parse Articles',
      'Detect Date Range',
      'Extract Domains',
      'Normalize Schema',
      'Insert to Database',
      'Handoff Ready',
    ]);
  });

  it('act — emits 7 processing:step events + 1 processing:complete', async () => {
    seed();
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    });
    const reasoned = await agent.reason(ctx);
    const plan = await agent.plan(reasoned);
    const result = (await agent.act(plan)) as {
      articlesInserted: number;
      domainsExtracted: number;
      qualityScore: string;
    };

    const stepEvents = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'processing:step',
    );
    const completeEvents = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'processing:complete',
    );
    expect(stepEvents).toHaveLength(7);
    expect(completeEvents).toHaveLength(1);

    // Order matches the plan.
    expect(
      stepEvents.map((c) => (c[2] as { stepKey: string }).stepKey),
    ).toEqual([
      'validate',
      'parse',
      'dates',
      'domains',
      'normalize',
      'insert',
      'handoff',
    ]);
    // Every step succeeded.
    for (const call of stepEvents) {
      expect((call[2] as { status: string }).status).toBe('done');
    }
    // Final event carries the aggregate.
    const completePayload = completeEvents[0]![2] as {
      chatId: string;
      totalArticles: number;
      domains: number;
    };
    expect(completePayload.chatId).toBe(CHAT);
    expect(completePayload.totalArticles).toBe(10);
    expect(completePayload.domains).toBe(3);

    // Handoff step flipped flowState to 'complete'.
    expect(paramsStore[0]!.flowState).toBe('complete');
    expect(paramsStore[0]!.collectedAt).not.toBeNull();

    // M8.4 contract — handoff publishes on the cross-agent bus after the
    // 7-step pipeline commits.
    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock).toHaveBeenCalledWith(
      'agent:enrichment:incoming',
      expect.objectContaining({
        chatId: CHAT,
        userId: USER,
        articleIds: [],
      }),
    );

    // Return value reflects the run.
    expect(result.articlesInserted).toBe(10);
    expect(result.domainsExtracted).toBe(3);
    expect(result.qualityScore).toBe('pass');
  });

  it('act — validate-step failure emits failed processing:step + throws', async () => {
    // Upload still in 'parsing' state -> validate throws.
    seed({ uploadStatus: 'parsing' });
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    });
    const reasoned = await agent.reason(ctx);
    const plan = await agent.plan(reasoned);

    await expect(agent.act(plan)).rejects.toThrow(/upload not ready/);

    const stepEvents = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'processing:step',
    );
    // Only the failing step fired.
    expect(stepEvents).toHaveLength(1);
    const payload = stepEvents[0]![2] as { stepKey: string; status: string; error: string };
    expect(payload.stepKey).toBe('validate');
    expect(payload.status).toBe('failed');
    expect(payload.error).toMatch(/upload not ready/);

    // No processing:complete on failure.
    expect(
      publishChatEventMock.mock.calls.filter((c) => c[1] === 'processing:complete'),
    ).toHaveLength(0);

    // flowState did NOT advance (handoff never ran).
    expect(paramsStore[0]!.flowState).toBe('processing');

    // No cross-agent bus publish on failure either — the handoff only fires
    // after the full pipeline commits.
    expect(publishAgentBusMock).not.toHaveBeenCalled();
  });

  it('reflect — logs warning when domain extraction rate <90%', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    await agent.reflect({
      articlesInserted: 100,
      domainsExtracted: 50, // 50% rate
      totalMs: 1000,
      qualityScore: 'pass',
    });
    expect(warn).toHaveBeenCalledWith(
      '[data-extract] domain extraction rate below 90%',
      expect.objectContaining({ rate: 0.5 }),
    );
    warn.mockRestore();
  });

  it('reflect — does not warn when domain extraction rate >=90%', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = new DataExtractAgent('id-1', 'Data Extract', 'data_extract');
    await agent.reflect({
      articlesInserted: 100,
      domainsExtracted: 95,
      totalMs: 1000,
      qualityScore: 'pass',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
