/**
 * M8.6 — ReachFetchWorker integration test.
 *
 * Exercises the BullMQ processor against the real Postgres + Prisma stack.
 * The similarweb-client (fetch path) is mocked; publishChatEvent is
 * captured. We invoke the processor directly with a fake job — the queue
 * itself isn't exercised.
 *
 * Requires a live Postgres. Falls back to the docker-compose dev URL so
 * `pnpm test` works without manually exporting DATABASE_URL. If Postgres
 * can't be reached the suite is skipped — mirrors parse-upload.worker.test.
 *
 * @file backend/test/workers/reach-fetch.worker.test.ts
 */
process.env.DATABASE_URL ??=
  'postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public';
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.STORAGE_MODE ??= 'inmemory';

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

// ─── Probe Postgres BEFORE importing modules that hold a live client. ────
async function postgresReachable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { prisma: probe } = await import('@prsi/shared/db');
    await probe.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

const PG_OK = (await postgresReachable()).ok;
const suite = PG_OK ? describe : describe.skip;

if (!PG_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    '[reach-fetch.worker.test] skipping — Postgres unreachable at',
    process.env.DATABASE_URL,
  );
}

// ─── Mock event-bus. ────────────────────────────────────────────────────
const publishedEvents: Array<{ chatId: string; type: string; payload: unknown }> = [];
vi.mock('../../src/lib/event-bus.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/event-bus.js')>(
      '../../src/lib/event-bus.js',
    );
  return {
    ...actual,
    publishChatEvent: vi.fn(
      async (chatId: string, type: string, payload: unknown) => {
        publishedEvents.push({ chatId, type, payload });
      },
    ),
    publishAgentBus: vi.fn(async () => {}),
  };
});

// ─── Mock similarweb-client. ────────────────────────────────────────────
const fetchedDomains: string[][] = [];
vi.mock('../../src/lib/similarweb-client.js', () => ({
  fetchSimilarWeb: vi.fn(),
  fetchSimilarWebBatch: vi.fn(async (domains: string[], _apiKey: string) => {
    fetchedDomains.push([...domains]);
    return domains.map((d) => ({
      domain: d,
      monthly_visitors: 2_000_000,
      global_rank: 555,
      category: 'Mocked News',
      score: 56,
      raw: { visits: 2_000_000 },
    }));
  }),
  getSimilarWebKey: vi.fn(async () => 'fake-api-key'),
}));

// Dynamic imports — safe only after vi.mock declarations above.
const { prisma } = await import('@prsi/shared/db');
const { hashPassword } = await import('../../src/lib/bcrypt.js');
const { reachFetchProcessor } = await import(
  '../../src/workers/reach-fetch.worker.js'
);
const { SimilarWebAgent } = await import('../../src/agents/similarweb.agent.js');
const { AgentRegistry } = await import('../../src/agents/agent-registry.js');
const { closeRedis } = await import('../../src/lib/redis.js');

const TEST_EMAIL = 'm8-6-worker@test.local';

function fakeJob(data: {
  jobId: string;
  chatId: string;
  userId: string;
}): Job {
  return {
    name: 'reach-fetch',
    data,
    id: 'test-job',
  } as unknown as Job;
}

suite('M8.6 — ReachFetchWorker', () => {
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M8.6 Worker Test',
        role: 'analyst',
      },
    });
    userId = user.id;

    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M8.6 chat' },
    });
    chatId = chat.id;

    AgentRegistry.clear();
    AgentRegistry.register(
      new SimilarWebAgent(
        '00000000-0000-0000-0000-0000005e4cb1',
        'SimilarWeb Agent',
        'similarweb',
      ),
    );
  });

  afterAll(async () => {
    AgentRegistry.clear();
    await prisma.enrichment.deleteMany({ where: { userId } });
    await prisma.article.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    // Clean any reach_cache rows the test created. These are GLOBAL so we
    // target them by the specific test domains we know we inserted.
    await prisma.reachCache.deleteMany({
      where: {
        domain: {
          in: ['m86-domain-a.example', 'm86-domain-b.example', 'm86-domain-c.example'],
        },
      },
    });
    await closeRedis().catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    publishedEvents.length = 0;
    fetchedDomains.length = 0;
    await prisma.enrichment.deleteMany({ where: { userId } });
    await prisma.article.deleteMany({ where: { userId } });
    await prisma.reachCache.deleteMany({
      where: {
        domain: {
          in: ['m86-domain-a.example', 'm86-domain-b.example', 'm86-domain-c.example'],
        },
      },
    });
  });

  it('processes a chat with 3 publisher_domains → fan-out fetch + reach-start/complete events', async () => {
    // Seed 3 articles with distinct domains.
    const domains = [
      'm86-domain-a.example',
      'm86-domain-b.example',
      'm86-domain-c.example',
    ];
    for (let i = 0; i < domains.length; i++) {
      await prisma.article.create({
        data: {
          userId,
          chatId,
          title: `Article ${i}`,
          publisherDomain: domains[i]!,
        },
      });
    }

    const jobId = '00000000-0000-0000-0000-00000000d000';

    const result = (await reachFetchProcessor(
      fakeJob({ jobId, chatId, userId }),
      'tok',
    )) as {
      jobId: string;
      total: number;
      resolved: number;
      coveragePercent: number;
    };

    // Agent received the worker payload and ran end-to-end.
    expect(result.jobId).toBe(jobId);
    expect(result.total).toBe(3);
    expect(result.resolved).toBe(3);
    expect(result.coveragePercent).toBe(100);

    // fetchSimilarWebBatch was called once with all 3 domains.
    expect(fetchedDomains).toHaveLength(1);
    expect(fetchedDomains[0]!.sort()).toEqual([...domains].sort());

    // reach_cache rows now exist for all 3 domains.
    const cacheRows = await prisma.reachCache.findMany({
      where: { domain: { in: domains } },
    });
    expect(cacheRows).toHaveLength(3);
    for (const row of cacheRows) {
      expect(row.monthlyVisitors).toBeTruthy();
      expect(row.isValid).toBe(true);
    }

    // Both lifecycle events fired on the chat channel.
    const types = publishedEvents.map((e) => e.type);
    expect(types).toContain('enrichment:reach-start');
    expect(types).toContain('enrichment:reach-complete');

    const completeEvent = publishedEvents.find(
      (e) => e.type === 'enrichment:reach-complete',
    );
    expect(completeEvent).toBeDefined();
    const payload = completeEvent!.payload as {
      jobId: string;
      resolved: number;
      total: number;
      coverage: number;
    };
    expect(payload.jobId).toBe(jobId);
    expect(payload.resolved).toBe(3);
    expect(payload.total).toBe(3);
    expect(payload.coverage).toBe(100);
  });
});
