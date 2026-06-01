/**
 * M8.10 — Phase 3 full-pipeline integration test.
 *
 * Walks the entire Phase 2 → Phase 3 handoff end-to-end against a live
 * Postgres + Redis. Picks up where M7.10 left off:
 *
 *   1. Seed: user (Alice), chat (PR Impact agent), 3 articles already
 *      inserted (the Phase 2 upload path is M7.10's test — we skip it),
 *      chat_params with flowState='complete' + enrichmentType='standard'.
 *   2. Mock `getModel` to return a stub provider whose `complete()` returns
 *      a valid 3-article enrichment JSON. Keeps the test deterministic and
 *      free of Azure key requirements.
 *   3. POST /api/v1/chats/:id/enrich        → { message: 'enqueued' }
 *   4. Subscribe to Redis `agent:enrichment:incoming` — assert publish.
 *   5. Manually invoke enrichmentSubscriber.handleMessage to simulate the
 *      bus delivery (avoids pub/sub timing flake).
 *   6. Assert enrichment_jobs row created, status='processing', batchCount>0.
 *   7. Poll until status flips to 'completed' (worker auto-runs inline).
 *   8. Assert 3 enrichments rows inserted with all 5 dimensions populated.
 *   9. GET /api/v1/chats/:id/enrich/json    → DashboardJson; persisted to
 *      enrichment_jobs.dashboardJson.
 *  10. Assert end-to-end took <10s.
 *
 * Skips when DATABASE_URL is unset OR Redis is unavailable / <5.0 (BullMQ
 * minimum). Same posture as M7.10's phase2-pipeline test.
 *
 * @file test/integration/phase3-pipeline.integration.test.ts
 */
process.env.DATABASE_URL ??=
  'postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.STORAGE_MODE ??= 'inmemory';
// Force the server bootstrap path that registers + starts the inline worker
// (server.ts skips startInlineWorker when NODE_ENV === 'test').
process.env.NODE_ENV = 'development';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type {
  LLMProvider,
  LLMCompleteResponse,
} from '../../src/lib/llm-providers/types.js';

// ─── Mock the LLM gateway so we don't need an Azure key. The Phase 3
//     pipeline reaches getModel() in two places: EnrichmentAgent.perceive
//     (for planBatching) and EnrichBatchWorker (for provider.complete).
//     We keep `planBatching` and `validateJSON` real — only the provider
//     itself is faked. ──────────────────────────────────────────────────
const fakeProvider: LLMProvider = {
  id: 'azure-openai' as const,
  config: {
    modelName: 'gpt-4.1-test',
    maxInputTokens: 200_000,
    defaultMaxOutputTokens: 4_000,
  },
  countTokens: (s: string) => Math.max(1, Math.ceil(s.length / 4)),
  complete: vi.fn(),
};

vi.mock('../../src/lib/llm-gateway.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/llm-gateway.js')>(
      '../../src/lib/llm-gateway.js',
    );
  return {
    ...actual,
    // Replace ONLY getModel — planBatching, validateJSON, etc. stay real.
    getModel: vi.fn(async () => fakeProvider),
  };
});

// We don't need the chat-complete LLM either, but the chat-flow path the
// enrich endpoint touches stays read-only, so this mock is purely
// defensive. Mirrors phase2-pipeline.integration.test.ts.
vi.mock('../../src/lib/llm.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/llm.js')>(
    '../../src/lib/llm.js',
  );
  return {
    ...actual,
    chatComplete: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ top5: [], top3: [], top2: [] })),
    parseChoice: vi.fn().mockResolvedValue(null),
    chatCompleteStream: async function* () {
      yield 'mock';
    },
  };
});

// ─── Probe infrastructure before importing modules that hold live clients. ─
async function postgresReachable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { prisma: probe } = await import('@prsi/shared/db');
    await probe.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function redisCompatible(
  url: string,
): Promise<{ ok: boolean; reason?: string }> {
  const probe = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    lazyConnect: true,
  });
  try {
    await probe.connect();
    const pong = await probe.ping();
    if (pong !== 'PONG') return { ok: false, reason: 'ping not PONG' };
    const info = await probe.info('server');
    const match = /redis_version:(\d+)\./.exec(info);
    const major = match ? Number(match[1]) : 0;
    await probe.quit();
    if (major < 5) {
      return { ok: false, reason: `Redis ${major}.x < 5.0 (BullMQ minimum)` };
    }
    return { ok: true };
  } catch (err) {
    try {
      probe.disconnect();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: (err as Error).message };
  }
}

const PG_OK = (await postgresReachable()).ok;
const REDIS = await redisCompatible(process.env.REDIS_URL);
const INFRA_OK = PG_OK && REDIS.ok;

const suite = INFRA_OK ? describe : describe.skip;

if (!INFRA_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    '[phase3-pipeline.integration.test] skipping —',
    'PG_OK=',
    PG_OK,
    'REDIS_OK=',
    REDIS.ok,
    REDIS.reason ? `(${REDIS.reason})` : '',
  );
}

// ─── Dynamic imports — only safe after vi.mock declarations above. ───────
const { buildServer } = await import('../../src/server.js');
const { prisma } = await import('@prsi/shared/db');
const { hashPassword } = await import('../../src/lib/bcrypt.js');
const { signAccess } = await import('../../src/lib/jwt.js');
const { closeRedis } = await import('../../src/lib/redis.js');
const { closeQueue, getQueue } = await import('../../src/lib/queue.js');
const { handleMessage, ENRICHMENT_INCOMING_CHANNEL } = await import(
  '../../src/agents/enrichment-subscriber.js'
);

const TEST_EMAIL = 'm8-10-pipeline@test.local';

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const start = Date.now();
  const interval = opts.intervalMs ?? 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(
        `pollUntil(${opts.label}) timed out after ${opts.timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Builds a valid LLM batch response for the given article ids — one entry
 * per article, each with all 5 LLM dimensions populated. Lets us assert
 * the persisted enrichments row reflects this exact shape downstream.
 */
function buildFakeBatchResponseJSON(articleIds: string[]): string {
  return JSON.stringify({
    articles: articleIds.map((id, i) => ({
      articleId: id,
      sentiment: {
        label: i % 2 === 0 ? 'positive' : 'neutral',
        confidence: 0.85,
        reason: 'Test reason from stubbed provider.',
      },
      themes: [
        {
          level: 'main',
          name: 'Funding',
          confidence: 0.9,
          reason: 'Mentions Series B.',
        },
        {
          level: 'secondary',
          name: 'Growth',
          confidence: 0.6,
          reason: 'Hiring spree.',
        },
      ],
      emotion: { label: 'trust', intensity: 0.6 },
      entities: [
        { type: 'company', name: 'AMX', mentions: 2 },
        { type: 'location', name: 'New York', mentions: 1 },
      ],
      signals: [
        {
          type: 'emerging',
          description: 'New product line',
          reason: 'Press release announces launch.',
        },
      ],
    })),
  });
}

suite('M8.10 — Phase 3 full-pipeline integration', () => {
  let app: FastifyInstance;
  let userId: string;
  let token: string;
  let chatId: string;

  beforeAll(async () => {
    // Clean leftover rows from prior runs.
    await prisma.enrichment.deleteMany({
      where: { user: { email: TEST_EMAIL } },
    });
    await prisma.enrichmentBatch.deleteMany({
      where: { job: { user: { email: TEST_EMAIL } } },
    });
    await prisma.enrichmentJob.deleteMany({
      where: { user: { email: TEST_EMAIL } },
    });
    await prisma.article.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.upload.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.booleanQuery.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chatParams.deleteMany({
      where: { user: { email: TEST_EMAIL } },
    });
    await prisma.message.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M8.10 Pipeline Test',
        role: 'analyst',
      },
    });
    userId = user.id;
    token = signAccess({
      userId,
      email: TEST_EMAIL,
      role: 'analyst',
      sessionId: 's',
    });

    app = await buildServer();
    await app.ready();

    // Drain anything left in the queue from earlier runs.
    await getQueue().drain(true).catch(() => {});

    // Seed: PR Impact chat + 3 articles + complete chat_params.
    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M8.10 chat' },
    });
    chatId = chat.id;

    // Stage 3 articles — content provides the LLM payload the worker reads.
    await prisma.article.createMany({
      data: [
        {
          chatId,
          userId,
          title: 'AMX Series B announced',
          content: 'AMX raises $50M Series B to expand AI offerings.',
          source: 'TechCrunch',
          publisherDomain: 'techcrunch.com',
          url: 'https://techcrunch.com/a',
          publishedDate: new Date('2025-03-10'),
          language: 'en',
        },
        {
          chatId,
          userId,
          title: 'AMX hiring spree',
          content: 'AMX opens 200 new engineering roles across NYC and SF.',
          source: 'Reuters',
          publisherDomain: 'reuters.com',
          url: 'https://reuters.com/b',
          publishedDate: new Date('2025-03-12'),
          language: 'en',
        },
        {
          chatId,
          userId,
          title: 'AMX product launch',
          content: 'AMX launches new PR intelligence product line.',
          source: 'Bloomberg',
          publisherDomain: 'bloomberg.com',
          url: 'https://bloomberg.com/c',
          publishedDate: new Date('2025-03-15'),
          language: 'en',
        },
      ],
    });

    // chat_params with flowState='complete' so enqueueManualEnrich's
    // "Articles not yet extracted" guard passes.
    await prisma.chatParams.create({
      data: {
        chatId,
        userId,
        flowState: 'complete',
        enrichmentType: 'standard',
        brand: 'AMX',
        competitors: ['Reuters', 'Bloomberg'],
        competitorSet: 'custom',
        intention: 'intention_based',
      },
    });

    // Wire the stub provider's complete() so it returns a JSON matching
    // whatever articleIds the worker requests this batch.
    (fakeProvider.complete as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { messages: Array<{ role: string; content: string }> }) => {
        // The user message is the last in the array; it embeds the article
        // ids the worker just selected. Pull them out so the response can
        // address each article correctly.
        const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
        const idMatches = userMsg.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        );
        const ids = idMatches ? Array.from(new Set(idMatches)) : [];
        const text = buildFakeBatchResponseJSON(ids);
        return {
          text,
          tokensInput: 1000,
          tokensOutput: 500,
          model: fakeProvider.config.modelName,
          durationMs: 50,
        } satisfies LLMCompleteResponse;
      },
    );
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    await closeQueue().catch(() => {});

    // Cleanup. Cascade on user delete handles most, but enrichment_jobs is
    // user-scoped — clear in-process first to keep deletion deterministic.
    await prisma.enrichment
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.enrichmentBatch
      .deleteMany({ where: { job: { user: { email: TEST_EMAIL } } } })
      .catch(() => {});
    await prisma.enrichmentJob
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.article
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.upload
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.booleanQuery
      .deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } })
      .catch(() => {});
    await prisma.chatParams
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.message
      .deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } })
      .catch(() => {});
    await prisma.chat
      .deleteMany({ where: { user: { email: TEST_EMAIL } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: TEST_EMAIL } })
      .catch(() => {});

    await closeRedis().catch(() => {});
    await prisma.$disconnect();
  });

  it('chat complete → ENRICHMENT_READY bus → agent → worker → enrichments → /enrich/json', async () => {
    const tPipelineStart = Date.now();

    // ─── Subscribe to the cross-agent bus so we can witness the publish ──
    const busSub = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
    });
    const busMessages: string[] = [];
    busSub.on('message', (chan, raw) => {
      if (chan === ENRICHMENT_INCOMING_CHANNEL) busMessages.push(raw);
    });
    await busSub.subscribe(ENRICHMENT_INCOMING_CHANNEL);

    // ─── 1) POST /chats/:id/enrich ─────────────────────────────────────
    const trigger = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/enrich`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(trigger.statusCode).toBe(200);
    const triggerBody = trigger.json();
    expect(triggerBody.success).toBe(true);
    expect(triggerBody.data.message).toBe('enqueued');
    expect(triggerBody.data.enrichmentType).toBe('standard');

    // ─── 2) Bus publish observed ───────────────────────────────────────
    // Allow a tick for ioredis to deliver the publish.
    await pollUntil(
      async () => busMessages.length,
      (n) => n >= 1,
      { timeoutMs: 3_000, label: 'agent:enrichment:incoming publish' },
    );
    const busPayload = JSON.parse(busMessages[0]!) as {
      chatId: string;
      userId: string;
      enrichmentType: string;
    };
    expect(busPayload.chatId).toBe(chatId);
    expect(busPayload.userId).toBe(userId);
    expect(busPayload.enrichmentType).toBe('standard');

    // ─── 3) Drive the subscriber in-band ───────────────────────────────
    // The server starts its own subscriber on the same channel; we also
    // call handleMessage directly so the assertion order is deterministic
    // (no race between the in-process subscriber and our test thread).
    await handleMessage(busMessages[0]!);

    // ─── 4) enrichment_job created, status='processing' (or already
    //      'completed' if the worker ran inside the handleMessage call) ─
    const initialJob = await pollUntil(
      async () =>
        prisma.enrichmentJob.findFirst({
          where: { chatId },
          orderBy: { createdAt: 'desc' },
        }),
      (j) => j !== null,
      { timeoutMs: 5_000, label: 'enrichment_job created' },
    );
    expect(initialJob!.chatId).toBe(chatId);
    expect(initialJob!.userId).toBe(userId);
    expect(initialJob!.totalArticles).toBe(3);
    expect(initialJob!.batchCount).toBeGreaterThan(0);
    expect(['processing', 'completed', 'partial']).toContain(initialJob!.status);

    // ─── 5) Wait for the job to reach a terminal state ────────────────
    const finalJob = await pollUntil(
      async () =>
        prisma.enrichmentJob.findFirst({
          where: { id: initialJob!.id },
        }),
      (j) => j != null && ['completed', 'partial', 'failed'].includes(j.status),
      { timeoutMs: 10_000, label: 'enrichment_job → terminal' },
    );
    expect(finalJob!.status).toBe('completed');
    expect(finalJob!.batchesCompleted).toBe(finalJob!.batchCount);
    expect(finalJob!.processedCount).toBe(3);

    // ─── 6) enrichments rows populated for all 3 articles ─────────────
    const enrichments = await prisma.enrichment.findMany({
      where: { chatId },
    });
    expect(enrichments).toHaveLength(3);
    for (const e of enrichments) {
      expect(e.sentiment).toBeTruthy();
      expect(e.themes).toBeTruthy();
      expect(e.emotion).toBeTruthy();
      expect(e.entities).toBeTruthy();
      expect(e.signals).toBeTruthy();
      expect(e.modelUsed).toBe(fakeProvider.config.modelName);
      expect(e.isValid).toBe(true);
    }

    // ─── 7) GET /enrich/json → DashboardJson; persists dashboardJson ──
    const jsonRes = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/json`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jsonRes.statusCode).toBe(200);
    const jsonBody = jsonRes.json();
    expect(jsonBody.success).toBe(true);
    const dashboard = jsonBody.data.dashboard as {
      chatId: string;
      jobId: string;
      articles: Array<{ id: string; enrichment: unknown }>;
      stats: { totalArticles: number; enrichedCount: number };
    };
    expect(dashboard.chatId).toBe(chatId);
    expect(dashboard.jobId).toBe(finalJob!.id);
    expect(dashboard.articles).toHaveLength(3);
    expect(dashboard.stats.totalArticles).toBe(3);
    expect(dashboard.stats.enrichedCount).toBe(3);
    // First read computes + persists; cached flag is false on the first hit.
    expect(jsonBody.data.cached).toBe(false);

    // Persisted on the job row?
    const refetchedJob = await prisma.enrichmentJob.findUnique({
      where: { id: finalJob!.id },
    });
    expect(refetchedJob!.dashboardJson).toBeTruthy();

    // ─── 8) Second GET returns cached: true ─────────────────────────────
    const jsonRes2 = await app.inject({
      method: 'GET',
      url: `/api/v1/chats/${chatId}/enrich/json`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jsonRes2.statusCode).toBe(200);
    expect(jsonRes2.json().data.cached).toBe(true);

    // ─── 9) End-to-end budget — full pipeline under 10s ───────────────
    const totalMs = Date.now() - tPipelineStart;
    expect(totalMs).toBeLessThan(10_000);

    // Tear down the assertion subscriber.
    try {
      await busSub.unsubscribe(ENRICHMENT_INCOMING_CHANNEL);
      busSub.disconnect();
    } catch {
      /* ignore */
    }
  }, 30_000);
});
