/**
 * M7.7 — DataExtractWorker integration test.
 *
 * Exercises the full processor against the real Postgres + Prisma stack.
 * publishChatEvent is captured for assertion; the queue itself is not
 * exercised (we invoke the processor function directly with a fake job).
 *
 * Requires a live Postgres. Falls back to the docker-compose dev URL so
 * `pnpm test` works without exporting DATABASE_URL. If Postgres can't be
 * reached, the suite is skipped — same posture as parse-upload.worker.test.
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
    '[data-extract.worker.test] skipping — Postgres unreachable at',
    process.env.DATABASE_URL,
  );
}

// ─── Mock event-bus to capture published events. ─────────────────────────
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
  };
});

// Dynamic imports — safe only after vi.mock declarations above.
const { prisma } = await import('@prsi/shared/db');
const { hashPassword } = await import('../../src/lib/bcrypt.js');
const { dataExtractProcessor } = await import(
  '../../src/workers/data-extract.worker.js'
);
const { DataExtractAgent } = await import('../../src/agents/data-extract.agent.js');
const { AgentRegistry } = await import('../../src/agents/agent-registry.js');
const { closeRedis } = await import('../../src/lib/redis.js');

const TEST_EMAIL = 'm7-7-worker@test.local';

function fakeJob(data: {
  userId: string;
  chatId: string;
  queryId: string;
}): Job {
  return {
    name: 'data-extract',
    data,
    id: 'test-job',
  } as unknown as Job;
}

suite('M7.7 — DataExtractWorker', () => {
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M7.7 Worker Test',
        role: 'analyst',
      },
    });
    userId = user.id;

    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M7.7 chat' },
    });
    chatId = chat.id;

    // Register the singleton agent (worker resolves it by type).
    AgentRegistry.clear();
    AgentRegistry.register(
      new DataExtractAgent(
        '00000000-0000-0000-0000-0000000d4ea7',
        'Data Extract Agent',
        'data_extract',
      ),
    );
  });

  afterAll(async () => {
    AgentRegistry.clear();
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await closeRedis().catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    publishedEvents.length = 0;
    // Clean per-test rows. Order matters: articles -> boolean_queries ->
    // chat_params -> uploads (all owned by our test user/chat).
    await prisma.article.deleteMany({ where: { userId } });
    await prisma.booleanQuery.deleteMany({ where: { chatId } });
    await prisma.chatParams.deleteMany({ where: { userId } });
    await prisma.upload.deleteMany({ where: { userId } });
  });

  it('processes a ready upload → emits 7 step events + 1 complete, flowState=complete', async () => {
    const upload = await prisma.upload.create({
      data: {
        userId,
        chatId,
        filename: 'data.csv',
        mimeType: 'text/csv',
        filePath: `uploads/${userId}/test/data.csv`,
        sizeBytes: BigInt(200),
        status: 'ready',
        rowCount: 10,
        columnCount: 5,
        dateColumn: 'published_date',
        dateRangeStart: new Date('2025-03-10'),
        dateRangeEnd: new Date('2025-03-20'),
        parsedAt: new Date(),
      },
    });

    // 10 articles linked to the upload, mixed domains (4 distinct).
    const domains = [
      'techcrunch.com',
      'reuters.com',
      'wsj.com',
      'bloomberg.com',
      'techcrunch.com',
      'reuters.com',
      'wsj.com',
      'bloomberg.com',
      'techcrunch.com',
      'reuters.com',
    ];
    for (let i = 0; i < 10; i++) {
      await prisma.article.create({
        data: {
          userId,
          chatId,
          uploadId: upload.id,
          title: `Article ${i}`,
          publisherDomain: domains[i]!,
        },
      });
    }

    const params = await prisma.chatParams.create({
      data: {
        chatId,
        userId,
        flowState: 'processing',
        brand: 'Acme',
        competitors: ['Beta', 'Gamma'],
        dateStart: new Date('2025-03-10'),
        dateEnd: new Date('2025-03-20'),
        enrichmentType: 'standard',
        uploadId: upload.id,
        hasUpload: true,
      },
    });

    const query = await prisma.booleanQuery.create({
      data: {
        chatId,
        chatParamsId: params.id,
        queryText: '("Acme") AND ("Beta" OR "Gamma")',
        queryStructured: {},
        version: 1,
        isConfirmed: true,
        confirmedAt: new Date(),
      },
    });

    const result = (await dataExtractProcessor(
      fakeJob({ userId, chatId, queryId: query.id }),
      'tok',
    )) as { articlesInserted: number; domainsExtracted: number; qualityScore: string };

    // 7 step events fired in spec order, all 'done'.
    const stepEvents = publishedEvents.filter((e) => e.type === 'processing:step');
    expect(stepEvents).toHaveLength(7);
    expect(stepEvents.map((e) => (e.payload as { stepKey: string }).stepKey)).toEqual([
      'validate',
      'parse',
      'dates',
      'domains',
      'normalize',
      'insert',
      'handoff',
    ]);
    for (const e of stepEvents) {
      expect((e.payload as { status: string }).status).toBe('done');
      expect((e.payload as { chatId: string }).chatId).toBe(chatId);
    }

    // Exactly one processing:complete with the aggregate metrics.
    const completeEvents = publishedEvents.filter(
      (e) => e.type === 'processing:complete',
    );
    expect(completeEvents).toHaveLength(1);
    const completePayload = completeEvents[0]!.payload as {
      chatId: string;
      totalArticles: number;
      domains: number;
    };
    expect(completePayload.chatId).toBe(chatId);
    expect(completePayload.totalArticles).toBe(10);
    expect(completePayload.domains).toBe(4); // 4 distinct domains

    // chat_params.flowState flipped to 'complete' by the handoff step.
    const freshParams = await prisma.chatParams.findUniqueOrThrow({
      where: { chatId },
    });
    expect(freshParams.flowState).toBe('complete');
    expect(freshParams.collectedAt).not.toBeNull();

    // Return value reflects the run.
    expect(result.articlesInserted).toBe(10);
    expect(result.domainsExtracted).toBe(4);
    expect(result.qualityScore).toBe('pass');
  });

  it('upload.status=parsing → validate fails, processing:step failed, throws', async () => {
    const upload = await prisma.upload.create({
      data: {
        userId,
        chatId,
        filename: 'data.csv',
        mimeType: 'text/csv',
        filePath: `uploads/${userId}/test/data.csv`,
        sizeBytes: BigInt(200),
        status: 'parsing', // not ready
      },
    });

    const params = await prisma.chatParams.create({
      data: {
        chatId,
        userId,
        flowState: 'processing',
        brand: 'Acme',
        competitors: ['Beta'],
        uploadId: upload.id,
        hasUpload: true,
      },
    });

    const query = await prisma.booleanQuery.create({
      data: {
        chatId,
        chatParamsId: params.id,
        queryText: 'q',
        queryStructured: {},
        version: 1,
        isConfirmed: true,
        confirmedAt: new Date(),
      },
    });

    await expect(
      dataExtractProcessor(
        fakeJob({ userId, chatId, queryId: query.id }),
        'tok',
      ),
    ).rejects.toThrow(/upload not ready/);

    // Only the validate step fired, and it fired with status='failed'.
    const stepEvents = publishedEvents.filter((e) => e.type === 'processing:step');
    expect(stepEvents).toHaveLength(1);
    expect((stepEvents[0]!.payload as { stepKey: string }).stepKey).toBe('validate');
    expect((stepEvents[0]!.payload as { status: string }).status).toBe('failed');

    // No processing:complete on failure.
    expect(
      publishedEvents.filter((e) => e.type === 'processing:complete'),
    ).toHaveLength(0);

    // flowState did NOT advance.
    const freshParams = await prisma.chatParams.findUniqueOrThrow({
      where: { chatId },
    });
    expect(freshParams.flowState).toBe('processing');
  });
});
