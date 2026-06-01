/**
 * M8.6 — SimilarWebAgent unit tests.
 *
 * Pure-unit suite. Prisma + RLS are replaced with in-memory mocks; the
 * similarweb-client (fetch path) is captured. Mirrors the M8.4
 * EnrichmentAgent test layout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────
// In-memory stores
// ───────────────────────────────────────────────────────────────────────
interface ArticleRow {
  id: string;
  chatId: string;
  publisherDomain: string | null;
}
interface EnrichmentRow {
  id: string;
  articleId: string;
  chatId: string;
  reach: unknown;
  article: { publisherDomain: string | null };
}
interface ReachCacheRow {
  domain: string;
  monthlyVisitors: number | null;
  globalRank: number | null;
  category: string | null;
  score: number | null;
  rawResponse: unknown;
  fetchedAt: Date;
  ttlHours: number;
  isValid: boolean;
}

const articleStore: ArticleRow[] = [];
const enrichmentStore: EnrichmentRow[] = [];
const reachCacheStore: ReachCacheRow[] = [];

const mockArticle = {
  findMany: vi.fn(
    async ({
      where,
      distinct: _d,
      select: _s,
    }: {
      where: { chatId?: string; publisherDomain?: { not: null } };
      distinct?: unknown;
      select?: unknown;
    }) => {
      const filtered = articleStore.filter((a) => {
        if (where.chatId && a.chatId !== where.chatId) return false;
        if (where.publisherDomain && a.publisherDomain == null) return false;
        return true;
      });
      // Emulate DISTINCT by publisherDomain.
      const seen = new Set<string>();
      const out: Array<{ publisherDomain: string | null }> = [];
      for (const a of filtered) {
        const d = a.publisherDomain;
        if (d == null || seen.has(d)) continue;
        seen.add(d);
        out.push({ publisherDomain: d });
      }
      return out;
    },
  ),
};

const mockEnrichment = {
  findMany: vi.fn(
    async ({ where }: { where: { chatId: string }; include?: unknown }) => {
      return enrichmentStore
        .filter((e) => e.chatId === where.chatId)
        .map((e) => ({ ...e })); // shallow copy
    },
  ),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { reach: unknown };
    }) => {
      const row = enrichmentStore.find((e) => e.id === where.id);
      if (!row) throw new Error('not found');
      row.reach = data.reach;
      return row;
    },
  ),
};

const mockReachCache = {
  findMany: vi.fn(
    async ({
      where,
    }: {
      where: { domain: { in: string[] }; isValid?: boolean };
    }) => {
      return reachCacheStore.filter(
        (r) =>
          where.domain.in.includes(r.domain) &&
          (where.isValid === undefined || r.isValid === where.isValid),
      );
    },
  ),
  upsert: vi.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: { domain: string };
      create: Omit<ReachCacheRow, 'fetchedAt'> & { fetchedAt?: Date };
      update: Partial<ReachCacheRow>;
    }) => {
      const existing = reachCacheStore.find((r) => r.domain === where.domain);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row: ReachCacheRow = {
        domain: create.domain,
        monthlyVisitors: create.monthlyVisitors,
        globalRank: create.globalRank,
        category: create.category,
        score: create.score,
        rawResponse: create.rawResponse,
        fetchedAt: create.fetchedAt ?? new Date(),
        ttlHours: create.ttlHours,
        isValid: create.isValid,
      };
      reachCacheStore.push(row);
      return row;
    },
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    article: mockArticle,
    enrichment: mockEnrichment,
    reachCache: mockReachCache,
    agentLog: { create: vi.fn().mockResolvedValue({}) },
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      article: mockArticle,
      enrichment: mockEnrichment,
      reachCache: mockReachCache,
    }),
  ),
  asAdmin: vi.fn(),
}));

const fetchSimilarWebBatchMock = vi.fn(
  async (
    domains: string[],
    _apiKey: string,
  ): Promise<
    Array<{
      domain: string;
      monthly_visitors: number | null;
      global_rank: number | null;
      category: string | null;
      score: number | null;
      raw: unknown;
    }>
  > => {
    return domains.map((d) => ({
      domain: d,
      monthly_visitors: 1_000_000,
      global_rank: 100,
      category: 'News',
      score: 50,
      raw: { visits: 1_000_000 },
    }));
  },
);
const getSimilarWebKeyMock = vi.fn(
  async (_uid: string): Promise<string | null> => 'fake-api-key',
);

vi.mock('../../src/lib/similarweb-client.js', () => ({
  fetchSimilarWeb: vi.fn(),
  fetchSimilarWebBatch: fetchSimilarWebBatchMock,
  getSimilarWebKey: getSimilarWebKeyMock,
}));

const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: vi.fn(async () => {}),
  subscribeChatEvents: vi.fn(),
}));

const { SimilarWebAgent } = await import('../../src/agents/similarweb.agent.js');

const USER = '00000000-0000-0000-0000-00000000aaaa';
const CHAT = '00000000-0000-0000-0000-00000000bbbb';
const JOB = 'job-1';

function seedArticles(domains: string[]): void {
  for (let i = 0; i < domains.length; i++) {
    articleStore.push({
      id: `art-${i}`,
      chatId: CHAT,
      publisherDomain: domains[i] ?? null,
    });
  }
}

function seedEnrichment(articleId: string, domain: string | null): EnrichmentRow {
  const row: EnrichmentRow = {
    id: `enr-${articleId}`,
    articleId,
    chatId: CHAT,
    reach: null,
    article: { publisherDomain: domain },
  };
  enrichmentStore.push(row);
  return row;
}

function seedCacheRow(
  domain: string,
  opts: { ageHours?: number; ttlHours?: number; isValid?: boolean } = {},
): void {
  const ageHours = opts.ageHours ?? 0;
  reachCacheStore.push({
    domain,
    monthlyVisitors: 500_000,
    globalRank: 200,
    category: 'Cached Category',
    score: 47,
    rawResponse: {},
    fetchedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000),
    ttlHours: opts.ttlHours ?? 168,
    isValid: opts.isValid ?? true,
  });
}

function newAgent() {
  return new SimilarWebAgent('id-1', 'SimilarWeb Agent', 'similarweb');
}

beforeEach(() => {
  articleStore.length = 0;
  enrichmentStore.length = 0;
  reachCacheStore.length = 0;
  mockArticle.findMany.mockClear();
  mockEnrichment.findMany.mockClear();
  mockEnrichment.update.mockClear();
  mockReachCache.findMany.mockClear();
  mockReachCache.upsert.mockClear();
  fetchSimilarWebBatchMock.mockClear();
  getSimilarWebKeyMock.mockClear();
  publishChatEventMock.mockClear();
  // Default: getSimilarWebKey returns a key so fetch path runs.
  getSimilarWebKeyMock.mockImplementation(async () => 'fake-api-key');
});

// ───────────────────────────────────────────────────────────────────────
// perceive
// ───────────────────────────────────────────────────────────────────────
describe('SimilarWebAgent.perceive', () => {
  it('loads DISTINCT publisher_domains and the user api key', async () => {
    seedArticles(['a.com', 'b.com', 'a.com', 'c.com']); // a.com duplicated
    const agent = newAgent();
    const ctx = (await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { jobId: JOB },
    })) as { domains: string[]; apiKey: string | null; jobId: string };
    expect(ctx.domains.sort()).toEqual(['a.com', 'b.com', 'c.com']);
    expect(ctx.apiKey).toBe('fake-api-key');
    expect(ctx.jobId).toBe(JOB);
    expect(getSimilarWebKeyMock).toHaveBeenCalledWith(USER);
  });

  it('throws when chatId is missing', async () => {
    const agent = newAgent();
    await expect(
      agent.perceive({
        userId: USER,
        message: '',
        metadata: { jobId: JOB },
      } as Parameters<typeof agent.perceive>[0]),
    ).rejects.toThrow(/chatId/);
  });

  it('throws when metadata.jobId is missing', async () => {
    const agent = newAgent();
    await expect(
      agent.perceive({
        userId: USER,
        chatId: CHAT,
        message: '',
        metadata: {},
      } as Parameters<typeof agent.perceive>[0]),
    ).rejects.toThrow(/jobId/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// reason
// ───────────────────────────────────────────────────────────────────────
describe('SimilarWebAgent.reason', () => {
  it('partitions domains into cached / uncached based on TTL', async () => {
    seedArticles(['fresh.com', 'stale.com', 'new.com']);
    seedCacheRow('fresh.com', { ageHours: 1, ttlHours: 168 });   // valid
    seedCacheRow('stale.com', { ageHours: 200, ttlHours: 168 }); // expired
    // new.com has no cache row.

    const agent = newAgent();
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { jobId: JOB },
    });
    const r = (await agent.reason(ctx)) as {
      cached: string[];
      uncached: string[];
    };
    expect(r.cached).toEqual(['fresh.com']);
    expect(r.uncached.sort()).toEqual(['new.com', 'stale.com']);
  });

  it('returns empty cached/uncached when no domains', async () => {
    const agent = newAgent();
    // seed no articles; perceive returns domains=[]
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { jobId: JOB },
    });
    const r = (await agent.reason(ctx)) as {
      cached: string[];
      uncached: string[];
    };
    expect(r.cached).toEqual([]);
    expect(r.uncached).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// act
// ───────────────────────────────────────────────────────────────────────
describe('SimilarWebAgent.act', () => {
  async function runThrough(opts: { domains: string[]; apiKey?: string | null }) {
    seedArticles(opts.domains);
    if (opts.apiKey === null) {
      getSimilarWebKeyMock.mockImplementationOnce(async () => null);
    }
    const agent = newAgent();
    const ctx = await agent.perceive({
      userId: USER,
      chatId: CHAT,
      message: '',
      metadata: { jobId: JOB },
    });
    const reasoned = await agent.reason(ctx);
    const plan = await agent.plan(reasoned);
    return { agent, plan };
  }

  it('emits enrichment:reach-start with the domain count', async () => {
    const { agent, plan } = await runThrough({ domains: ['a.com', 'b.com'] });
    await agent.act(plan);
    const starts = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'enrichment:reach-start',
    );
    expect(starts).toHaveLength(1);
    const payload = starts[0]![2] as {
      jobId: string;
      chatId: string;
      domains: number;
    };
    expect(payload.jobId).toBe(JOB);
    expect(payload.chatId).toBe(CHAT);
    expect(payload.domains).toBe(2);
  });

  it('fetches ONLY uncached domains via fetchSimilarWebBatch', async () => {
    seedCacheRow('cached.com', { ageHours: 1 });
    const { agent, plan } = await runThrough({
      domains: ['cached.com', 'fresh1.com', 'fresh2.com'],
    });
    await agent.act(plan);
    expect(fetchSimilarWebBatchMock).toHaveBeenCalledTimes(1);
    const passed = fetchSimilarWebBatchMock.mock.calls[0]![0];
    expect(passed.sort()).toEqual(['fresh1.com', 'fresh2.com']);
  });

  it('upserts fetched rows into reach_cache and merges into enrichments.reach', async () => {
    const { agent, plan } = await runThrough({ domains: ['a.com', 'b.com'] });
    // Seed enrichments for the articles we already created.
    seedEnrichment('art-0', 'a.com');
    seedEnrichment('art-1', 'b.com');

    const result = (await agent.act(plan)) as {
      total: number;
      resolved: number;
      coveragePercent: number;
    };

    // Two upserts (one per fetched domain).
    expect(mockReachCache.upsert).toHaveBeenCalledTimes(2);
    // Both enrichments got their reach JSONB populated.
    expect(mockEnrichment.update).toHaveBeenCalledTimes(2);
    const updateArgs = mockEnrichment.update.mock.calls.map(
      (c) =>
        (c[0] as { data: { reach: { domain: string; score: number } } }).data
          .reach,
    );
    const domains = updateArgs.map((r) => r.domain).sort();
    expect(domains).toEqual(['a.com', 'b.com']);
    expect(updateArgs[0]!.score).toBe(50);

    expect(result.total).toBe(2);
    expect(result.resolved).toBe(2);
    expect(result.coveragePercent).toBe(100);
  });

  it('emits enrichment:reach-complete with coverage stats', async () => {
    const { agent, plan } = await runThrough({ domains: ['a.com', 'b.com'] });
    seedEnrichment('art-0', 'a.com');
    seedEnrichment('art-1', 'b.com');
    await agent.act(plan);
    const completes = publishChatEventMock.mock.calls.filter(
      (c) => c[1] === 'enrichment:reach-complete',
    );
    expect(completes).toHaveLength(1);
    const payload = completes[0]![2] as {
      jobId: string;
      resolved: number;
      total: number;
      coverage: number;
      duration: number;
    };
    expect(payload.jobId).toBe(JOB);
    expect(payload.resolved).toBe(2);
    expect(payload.total).toBe(2);
    expect(payload.coverage).toBe(100);
    expect(payload.duration).toBeGreaterThanOrEqual(0);
  });

  it('with empty domains: emits start + complete with total=0 and 100% coverage', async () => {
    const { agent, plan } = await runThrough({ domains: [] });
    const result = (await agent.act(plan)) as {
      total: number;
      resolved: number;
      coveragePercent: number;
    };
    expect(result.total).toBe(0);
    expect(result.resolved).toBe(0);
    // Empty-set coverage is 100% by convention.
    expect(result.coveragePercent).toBe(100);
    // Should NOT call fetchSimilarWebBatch.
    expect(fetchSimilarWebBatchMock).not.toHaveBeenCalled();
    // Both events still fire.
    const types = publishChatEventMock.mock.calls.map((c) => c[1]);
    expect(types).toContain('enrichment:reach-start');
    expect(types).toContain('enrichment:reach-complete');
  });

  it('without apiKey: skips fetch but still merges cached rows', async () => {
    seedCacheRow('cached.com', { ageHours: 1 });
    const { agent, plan } = await runThrough({
      domains: ['cached.com', 'new.com'],
      apiKey: null,
    });
    seedEnrichment('art-0', 'cached.com');
    seedEnrichment('art-1', 'new.com');

    const result = (await agent.act(plan)) as {
      total: number;
      resolved: number;
      coveragePercent: number;
    };

    // No fetch — apiKey was null.
    expect(fetchSimilarWebBatchMock).not.toHaveBeenCalled();
    // Still merged the one cached row.
    expect(mockEnrichment.update).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(2);
    expect(result.resolved).toBe(1);
    expect(result.coveragePercent).toBe(50);
  });

  it('skips enrichments with no matching cache row', async () => {
    const { agent, plan } = await runThrough({ domains: ['a.com'] });
    seedEnrichment('art-0', 'a.com');
    seedEnrichment('art-x', null); // no publisher_domain
    seedEnrichment('art-y', 'unrelated.com'); // domain not in our set

    await agent.act(plan);
    // Only one update — only art-0 has both a matching domain and a cache row.
    expect(mockEnrichment.update).toHaveBeenCalledTimes(1);
    const args = mockEnrichment.update.mock.calls[0]![0] as {
      where: { id: string };
    };
    expect(args.where.id).toBe('enr-art-0');
  });
});

// ───────────────────────────────────────────────────────────────────────
// reflect / logAction
// ───────────────────────────────────────────────────────────────────────
describe('SimilarWebAgent.reflect / logAction', () => {
  it('reflect warns when coverage < 95% on a non-empty job', async () => {
    const agent = newAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await agent.reflect({
      jobId: JOB,
      total: 10,
      resolved: 5,
      coveragePercent: 50,
      durationMs: 100,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[similarweb-agent] coverage below 95%',
      expect.objectContaining({ coveragePercent: 50 }),
    );
    warnSpy.mockRestore();
  });

  it('reflect stays quiet when coverage >= 95%', async () => {
    const agent = newAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await agent.reflect({
      jobId: JOB,
      total: 10,
      resolved: 10,
      coveragePercent: 100,
      durationMs: 100,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reflect stays quiet on an empty job (total=0)', async () => {
    const agent = newAgent();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await agent.reflect({
      jobId: JOB,
      total: 0,
      resolved: 0,
      coveragePercent: 100,
      durationMs: 0,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logAction is overridden to no-op (no agent_logs write)', async () => {
    const agent = newAgent();
    const log = agent.logAction as unknown as (
      action: string,
      input: unknown,
      output: unknown,
      durationMs: number,
    ) => Promise<void>;
    await expect(log('execute', { a: 1 }, { b: 2 }, 100)).resolves.toBeUndefined();
  });
});
