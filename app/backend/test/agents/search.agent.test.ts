/**
 * M9.5 — SearchAgent unit tests.
 *
 * Pure-unit suite. All OpenSearch / Prisma / RLS / event-bus surfaces
 * are mocked. The agent's full perceive → reason → plan → act → reflect
 * → learn lifecycle runs without hitting a real cluster or DB.
 *
 * Mocked surfaces:
 *   - lib/opensearch-client.search        — programmable hits per call
 *   - lib/opensearch-indices.resolveIndices — fixed index list
 *   - lib/prisma-rls.withUser              — passthrough to in-memory tx
 *   - services/article-bulk-insert        — counts batches, ids, calls
 *   - services/search-history.service     — captures memory write
 *   - lib/event-bus                       — collects published events
 *   - env.hasOpenSearchConfig             — returns true
 *   - env.loadEnv                         — programmable MAX_PAGES / PAGE_SIZE
 */
process.env.OPENSEARCH_URL ??= 'https://example.com';
process.env.OPENSEARCH_USERNAME ??= 'u';
process.env.OPENSEARCH_PASSWORD ??= 'p';

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Programmable mock state ─────────────────────────────────────────────
type Hit = { _id: string; _source: Record<string, unknown>; sort?: unknown[] };
let scriptedPages: Hit[][] = [];
let scriptedError: Error | null = null;
let scriptedTotalHits = 0;
let envMaxPages = 3;
let envPageSize = 500;

interface ChatParamsRow {
  chatId: string;
  userId: string;
  dataSource: 'csv_upload' | 'opensearch';
  mediaTypes: string[];
  enrichmentType: 'standard' | 'reach' | null;
}
interface BooleanQueryRow {
  id: string;
  chatId: string;
  isConfirmed: boolean;
  queryStructured: Record<string, unknown>;
}

const chatParamsStore: ChatParamsRow[] = [];
const queryStore: BooleanQueryRow[] = [];

// ─── env / config mocks ──────────────────────────────────────────────────
vi.mock('../../src/env.js', () => ({
  hasOpenSearchConfig: vi.fn(() => true),
  loadEnv: vi.fn(() => ({
    OPENSEARCH_MAX_PAGES: envMaxPages,
    OPENSEARCH_PAGE_SIZE: envPageSize,
    OPENSEARCH_FIELDS_FOR_QUERY: 'title,content,description,summary',
  })),
}));

// ─── OpenSearch indices resolver ─────────────────────────────────────────
const resolveIndicesMock = vi.fn((_input: unknown) => [
  'amx-data-2026-05-01*',
  'amx-print*',
]);
vi.mock('../../src/lib/opensearch-indices.js', () => ({
  resolveIndices: resolveIndicesMock,
}));

// ─── OpenSearch search() wrapper ─────────────────────────────────────────
const searchMock = vi.fn(async () => {
  if (scriptedError) throw scriptedError;
  const page = scriptedPages.shift() ?? [];
  return {
    hits: page,
    totalHits: scriptedTotalHits,
    retriesUsed: 0,
    latencyMs: 5,
    raw: {},
  };
});
vi.mock('../../src/lib/opensearch-client.js', () => ({
  search: searchMock,
  getOpenSearchClient: vi.fn(),
  probeOpenSearch: vi.fn(),
  _resetOpenSearchClientForTests: vi.fn(),
}));

// ─── opensearch-dsl: cheap passthrough; we don't assert the DSL body ─────
vi.mock('../../src/lib/opensearch-dsl.js', () => ({
  buildOpenSearchDsl: vi.fn((_s: unknown, opts?: { searchAfter?: unknown[] }) => ({
    query: { match_all: {} },
    sort: [{ pubDate: 'desc' }, { _id: 'desc' }],
    size: envPageSize,
    _source: true,
    ...(opts?.searchAfter ? { search_after: opts.searchAfter } : {}),
  })),
}));

// ─── article-bulk-insert service ────────────────────────────────────────
const bulkInsertMock = vi.fn(
  async (
    _tx: unknown,
    opts: { articles: { openSearchId: string }[]; chatId: string; userId: string },
  ) => {
    return { inserted: opts.articles.length, batches: 1 };
  },
);
vi.mock('../../src/services/article-bulk-insert.service.js', () => ({
  bulkInsertArticles: bulkInsertMock,
}));

// ─── search-history service ──────────────────────────────────────────────
interface FakeSearchHistoryRow {
  id: string;
  chatId: string;
  queryHash: string;
  articleIds: string[];
  totalHits: number;
  indicesQueried: string[];
  coverageReach: number | null;
  executedAt: Date;
}
interface RecordSearchPayload {
  chatId: string;
  queryHash: string;
  articleIds: string[];
  totalHits: number;
  indicesQueried: string[];
  coverageReach: number | null;
}
const recordSearchMock = vi.fn<
  [userId: string, payload: RecordSearchPayload],
  Promise<FakeSearchHistoryRow>
>(async (_uid, payload) => ({
  id: 'sh-1',
  chatId: payload.chatId,
  queryHash: payload.queryHash,
  articleIds: payload.articleIds,
  totalHits: payload.totalHits,
  indicesQueried: payload.indicesQueried,
  coverageReach: payload.coverageReach,
  executedAt: new Date(),
}));
const findCachedSearchMock = vi.fn<
  [userId: string, chatId: string, queryHash: string],
  Promise<FakeSearchHistoryRow | null>
>(async () => null);
vi.mock('../../src/services/search-history.service.js', () => ({
  recordSearchExecution: recordSearchMock,
  findCachedSearch: findCachedSearchMock,
}));

// ─── event-bus ───────────────────────────────────────────────────────────
const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
const publishAgentBusMock = vi.fn(async (_channel: string, _payload: unknown) => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: publishAgentBusMock,
  subscribeChatEvents: vi.fn(),
}));

// ─── Prisma + withUser ───────────────────────────────────────────────────
const mockChatParams = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    chatParamsStore.find((p) => p.chatId === where.chatId) ?? null,
  ),
};
const mockBooleanQuery = {
  findFirst: vi.fn(
    async ({
      where,
    }: {
      where: { id: string; chatId: string; isConfirmed?: boolean };
    }) =>
      queryStore.find(
        (q) =>
          q.id === where.id &&
          q.chatId === where.chatId &&
          (where.isConfirmed === undefined || q.isConfirmed === where.isConfirmed),
      ) ?? null,
  ),
};
const withUserMock = vi.fn(
  async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ chatParams: mockChatParams, booleanQuery: mockBooleanQuery }),
);
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: withUserMock,
  asAdmin: vi.fn(),
}));
vi.mock('@prsi/shared/db', () => ({
  prisma: {
    agentLog: { create: vi.fn().mockResolvedValue({}) },
    $disconnect: vi.fn(),
  },
}));

const { SearchAgent } = await import('../../src/agents/search.agent.js');

// ─── Helpers ─────────────────────────────────────────────────────────────
const USER = '00000000-0000-0000-0000-00000000aaaa';
const CHAT = '00000000-0000-0000-0000-00000000bbbb';
const QUERY = '00000000-0000-0000-0000-00000000cccc';

function seed(opts: {
  enrichmentType?: 'standard' | 'reach';
  mediaTypes?: string[];
  dataSource?: 'opensearch' | 'csv_upload';
} = {}) {
  chatParamsStore.push({
    chatId: CHAT,
    userId: USER,
    dataSource: opts.dataSource ?? 'opensearch',
    mediaTypes: opts.mediaTypes ?? [],
    enrichmentType: opts.enrichmentType ?? 'standard',
  });
  queryStore.push({
    id: QUERY,
    chatId: CHAT,
    isConfirmed: true,
    queryStructured: {
      brand: 'FreshSip',
      brandFields: ['title'],
      competitors: ['PepsiCo'],
      competitorFields: ['content'],
      dateRange: { start: '2026-05-01', end: '2026-05-20' },
      language: 'en',
    },
  });
}

function makeHit(id: string, opts?: { reach?: number | null }): Hit {
  return {
    _id: id,
    _source: {
      title: `Article ${id}`,
      content: `body ${id}`,
      pubDate: '2026-05-10',
      ...(opts?.reach !== undefined ? { reach: opts.reach } : {}),
    },
    sort: [`2026-05-10`, id],
  };
}

function fullPage(n: number, prefix = 'os', opts?: { reach?: number | null }): Hit[] {
  return Array.from({ length: n }, (_, i) => makeHit(`${prefix}-${i}`, opts));
}

function newAgent() {
  return new SearchAgent('id', 'Search', 'search');
}

function eventsOfType(type: string) {
  return publishChatEventMock.mock.calls.filter((c) => c[1] === type);
}

// ─── Lifecycle reset ─────────────────────────────────────────────────────
beforeEach(() => {
  chatParamsStore.length = 0;
  queryStore.length = 0;
  scriptedPages = [];
  scriptedError = null;
  scriptedTotalHits = 0;
  envMaxPages = 3;
  envPageSize = 500;
  publishChatEventMock.mockClear();
  publishAgentBusMock.mockClear();
  searchMock.mockClear();
  resolveIndicesMock.mockClear();
  bulkInsertMock.mockClear();
  recordSearchMock.mockClear();
  findCachedSearchMock.mockClear();
  withUserMock.mockClear();
  mockChatParams.findUnique.mockClear();
  mockBooleanQuery.findFirst.mockClear();
});

describe('SearchAgent — happy path', () => {
  it('3 full pages × pageSize 500 → 1500 inserts, 3 progress events, search:fetched fires', async () => {
    envPageSize = 500;
    envMaxPages = 3;
    seed();
    scriptedTotalHits = 1500;
    scriptedPages = [fullPage(500, 'p1', { reach: 1000 }), fullPage(500, 'p2', { reach: 1000 }), fullPage(500, 'p3', { reach: 1000 })];

    const agent = newAgent();
    const result = (await agent.execute({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    })) as { articlesInserted: number; pagesScanned: number; paused: boolean };

    expect(result.articlesInserted).toBe(1500);
    expect(result.pagesScanned).toBe(3);
    expect(eventsOfType('search:start')).toHaveLength(1);
    expect(eventsOfType('search:progress')).toHaveLength(3);
    expect(eventsOfType('search:fetched')).toHaveLength(1);
    expect(eventsOfType('search:complete')).toHaveLength(1);
    expect(eventsOfType('reach:absent')).toHaveLength(0);
    // Handoff dispatched.
    expect(publishAgentBusMock).toHaveBeenCalledWith(
      'agent:enrichment:incoming',
      expect.objectContaining({ chatId: CHAT, userId: USER, articleIds: [] }),
    );
    expect(result.paused).toBe(false);
  });

  it('partial final page (487 hits when pageSize=500) → 1 progress event lastPage=true + search:fetched', async () => {
    envPageSize = 500;
    envMaxPages = 3;
    seed();
    scriptedTotalHits = 487;
    scriptedPages = [fullPage(487, 'p1', { reach: 1000 })];

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    const progress = eventsOfType('search:progress');
    expect(progress).toHaveLength(1);
    expect((progress[0]![2] as { lastPage: boolean; totalSoFar: number }).lastPage).toBe(true);
    expect(eventsOfType('search:fetched')).toHaveLength(1);
  });
});

describe('SearchAgent — empty results', () => {
  it('zero hits on first page → search:complete with count=0, ready=false, no handoff, no presence', async () => {
    seed();
    scriptedTotalHits = 0;
    scriptedPages = [[]]; // one call, empty

    const agent = newAgent();
    const result = (await agent.execute({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    })) as { articlesInserted: number };

    expect(result.articlesInserted).toBe(0);
    const complete = eventsOfType('search:complete');
    expect(complete).toHaveLength(1);
    expect((complete[0]![2] as { ready: boolean; count: number }).ready).toBe(false);
    expect((complete[0]![2] as { count: number }).count).toBe(0);
    expect(eventsOfType('reach:absent')).toHaveLength(0);
    expect(publishAgentBusMock).not.toHaveBeenCalled();
  });
});

describe('SearchAgent — reach presence gate', () => {
  it('reach absent + enrichmentType=standard → emits reach:absent, search:complete NOT emitted, search_history still recorded', async () => {
    seed({ enrichmentType: 'standard' });
    scriptedTotalHits = 50;
    // All hits missing reach.
    scriptedPages = [fullPage(50, 'p1')];

    const agent = newAgent();
    const result = (await agent.execute({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    })) as { paused: boolean };

    expect(eventsOfType('reach:absent')).toHaveLength(1);
    expect(eventsOfType('search:complete')).toHaveLength(0);
    expect(publishAgentBusMock).not.toHaveBeenCalled();
    expect(recordSearchMock).toHaveBeenCalledTimes(1);
    expect(result.paused).toBe(true);
  });

  it('reach absent + enrichmentType=reach → no probe, search:complete fires, handoff dispatched', async () => {
    seed({ enrichmentType: 'reach' });
    scriptedTotalHits = 50;
    scriptedPages = [fullPage(50, 'p1')];

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(eventsOfType('reach:absent')).toHaveLength(0);
    expect(eventsOfType('search:complete')).toHaveLength(1);
    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock.mock.calls[0]![1]).toMatchObject({
      enrichmentType: 'reach',
    });
  });

  it('reach present + enrichmentType=standard → no probe, search:complete fires', async () => {
    seed({ enrichmentType: 'standard' });
    scriptedTotalHits = 50;
    scriptedPages = [fullPage(50, 'p1', { reach: 1000 })]; // every hit has reach

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(eventsOfType('reach:absent')).toHaveLength(0);
    expect(eventsOfType('search:complete')).toHaveLength(1);
    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
  });
});

describe('SearchAgent — error paths', () => {
  it('400-class error → search:error emitted, no search:complete, no handoff', async () => {
    seed();
    scriptedError = new Error('Invalid OpenSearch query syntax or parameters.');

    const agent = newAgent();
    await expect(
      agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } }),
    ).rejects.toThrow(/Invalid OpenSearch/);

    expect(eventsOfType('search:error')).toHaveLength(1);
    expect(eventsOfType('search:complete')).toHaveLength(0);
    expect(publishAgentBusMock).not.toHaveBeenCalled();
    // Memory NOT recorded — we throw out of act() before learn() runs.
    expect(recordSearchMock).not.toHaveBeenCalled();
  });

  it('post-retry failure → search:error emitted', async () => {
    seed();
    scriptedError = new Error('OpenSearch search failed after retries.');

    const agent = newAgent();
    await expect(
      agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } }),
    ).rejects.toThrow(/failed after retries/);

    const errs = eventsOfType('search:error');
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  it('chat_params.dataSource=csv_upload → perceive throws (defensive)', async () => {
    seed({ dataSource: 'csv_upload' });
    const agent = newAgent();
    await expect(
      agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } }),
    ).rejects.toThrow(/dataSource='opensearch'/);
  });
});

describe('SearchAgent — pagination + caps', () => {
  it('search_after sort tuple from page N is passed as searchAfter to page N+1', async () => {
    envPageSize = 500;
    envMaxPages = 2;
    seed();
    scriptedTotalHits = 1000;
    scriptedPages = [fullPage(500, 'p1', { reach: 1000 }), fullPage(500, 'p2', { reach: 1000 })];

    const { buildOpenSearchDsl: dslMock } = await import('../../src/lib/opensearch-dsl.js');
    (dslMock as ReturnType<typeof vi.fn>).mockClear();

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    // 2 DSL builds — 1st without searchAfter, 2nd with sort from p1's last hit.
    const calls = (dslMock as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![1]).toEqual({ searchAfter: undefined });
    expect(calls[1]![1].searchAfter).toEqual(['2026-05-10', 'p1-499']);
  });

  it('OPENSEARCH_MAX_PAGES=1 caps the loop after 1 page', async () => {
    envPageSize = 500;
    envMaxPages = 1;
    seed();
    scriptedTotalHits = 5000;
    // Even with hits beyond the cap, the agent should stop after page 1.
    scriptedPages = [fullPage(500, 'p1', { reach: 1000 })];

    const agent = newAgent();
    const result = (await agent.execute({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { queryId: QUERY },
    })) as { pagesScanned: number };

    expect(result.pagesScanned).toBe(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});

describe('SearchAgent — mediaTypes routing', () => {
  it('chat_params.mediaTypes=["x_twitter"] → resolveIndices receives that list', async () => {
    seed({ mediaTypes: ['x_twitter'], enrichmentType: 'reach' });
    scriptedPages = [[]]; // empty, agent stops fast
    scriptedTotalHits = 0;

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(resolveIndicesMock).toHaveBeenCalledTimes(1);
    const arg = resolveIndicesMock.mock.calls[0]![0] as {
      mediaTypes: string[] | null;
    };
    expect(arg.mediaTypes).toEqual(['x_twitter']);
  });

  it('chat_params.mediaTypes=[] → resolveIndices receives null (use defaults)', async () => {
    seed({ mediaTypes: [], enrichmentType: 'reach' });
    scriptedPages = [[]];
    scriptedTotalHits = 0;

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    const arg = resolveIndicesMock.mock.calls[0]![0] as {
      mediaTypes: string[] | null;
    };
    expect(arg.mediaTypes).toBeNull();
  });
});

describe('SearchAgent — memory contract', () => {
  it('search_history row is written with queryHash + articleIds + totalHits + indicesQueried', async () => {
    seed({ enrichmentType: 'reach' });
    scriptedTotalHits = 50;
    scriptedPages = [fullPage(50, 'p1', { reach: 1000 })];

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(recordSearchMock).toHaveBeenCalledTimes(1);
    const [, payload] = recordSearchMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      chatId: CHAT,
      // queryHash is deterministic but we only need to confirm it's hex.
      queryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      totalHits: 50,
    });
    expect(payload.articleIds).toHaveLength(50);
    expect(payload.articleIds[0]).toMatch(/^p1-/);
  });

  it('reach absent + standard enrichment → memory STILL recorded (paused run)', async () => {
    seed({ enrichmentType: 'standard' });
    scriptedTotalHits = 50;
    scriptedPages = [fullPage(50, 'p1')]; // no reach

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(recordSearchMock).toHaveBeenCalledTimes(1);
  });

  it('findCachedSearch is consulted in perceive (logging only — no short-circuit)', async () => {
    seed({ enrichmentType: 'reach' });
    scriptedTotalHits = 50;
    scriptedPages = [fullPage(50, 'p1', { reach: 1000 })];
    findCachedSearchMock.mockResolvedValueOnce({
      id: 'sh-prior',
      chatId: CHAT,
      queryHash: 'whatever',
      articleIds: [],
      totalHits: 0,
      indicesQueried: [],
      coverageReach: null,
      executedAt: new Date(),
    });

    const agent = newAgent();
    await agent.execute({ userId: USER, chatId: CHAT, message: '', metadata: { queryId: QUERY } });

    expect(findCachedSearchMock).toHaveBeenCalledTimes(1);
    // Agent should NOT short-circuit — it should still run the search.
    expect(searchMock).toHaveBeenCalled();
  });
});
