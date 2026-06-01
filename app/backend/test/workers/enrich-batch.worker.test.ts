/**
 * M8.5 — EnrichBatchWorker integration test.
 *
 * Exercises the BullMQ processor against the real Postgres + Prisma stack:
 *   - Real DB writes (enrichment_jobs, enrichment_batches, enrichments)
 *   - Mocked LLM gateway (getModel returns a stub provider with a scripted
 *     complete() response per test)
 *   - Captured publishChatEvent (we never actually open Redis pub/sub)
 *   - Captured queue.add (we never actually enqueue a follow-up retry)
 *
 * Requires a live Postgres. Falls back to the docker-compose dev URL so
 * `pnpm test` works without manually exporting DATABASE_URL. If Postgres
 * can't be reached, the suite is skipped — mirrors parse-upload.worker.test.
 *
 * @file backend/test/workers/enrich-batch.worker.test.ts
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
    '[enrich-batch.worker.test] skipping — Postgres unreachable at',
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
    publishAgentBus: vi.fn(async () => {}),
  };
});

// ─── Mock LLM gateway. Test scripts the `complete()` response per case. ──
type CompleteFn = (
  req: unknown,
) => Promise<{
  text: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  durationMs: number;
}>;

let scriptedComplete: CompleteFn = async () => {
  throw new Error('scriptedComplete not configured');
};

vi.mock('../../src/lib/llm-gateway.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/llm-gateway.js')>(
      '../../src/lib/llm-gateway.js',
    );
  return {
    ...actual,
    getModel: vi.fn(async () => ({
      id: 'azure-openai' as const,
      config: {
        modelName: 'gpt-4.1-test',
        maxInputTokens: 200_000,
        defaultMaxOutputTokens: 4_000,
      },
      countTokens: (s: string) => Math.ceil(s.length / 4),
      complete: (req: unknown) => scriptedComplete(req),
    })),
  };
});

// ─── Mock queue so we can observe re-enqueues without touching Redis. ────
const queueAddCalls: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('../../src/lib/queue.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/queue.js')>(
      '../../src/lib/queue.js',
    );
  return {
    ...actual,
    getQueue: () => ({
      add: vi.fn(async (name: string, data: Record<string, unknown>) => {
        queueAddCalls.push({ name, data });
        return { id: 'fake-job-id' };
      }),
    }),
  };
});

// Dynamic imports — only safe after vi.mock declarations above.
const { prisma } = await import('@prsi/shared/db');
const { hashPassword } = await import('../../src/lib/bcrypt.js');
const { enrichBatchProcessor } = await import(
  '../../src/workers/enrich-batch.worker.js'
);
const { closeRedis } = await import('../../src/lib/redis.js');

const TEST_EMAIL = 'm8-5-worker@test.local';

function fakeJob(data: {
  jobId: string;
  batchId: string;
  batchNumber: number;
  chatId: string;
  userId: string;
  articleIds: string[];
  enrichmentType: 'standard' | 'reach';
  modelName: string;
}): Job {
  return {
    name: 'enrich-batch',
    data,
    id: 'test-job',
  } as unknown as Job;
}

/**
 * Build the JSON text the validator expects for a given set of article ids.
 * Uses the exact 6-dimension shape from EnrichmentBatchResponseSchema.
 */
function buildEnrichmentPayload(articleIds: string[]): string {
  return JSON.stringify({
    articles: articleIds.map((id) => ({
      articleId: id,
      sentiment: {
        label: 'positive',
        confidence: 0.9,
        reason: 'Test rationale',
      },
      themes: [
        { level: 'main', name: 'Theme A', confidence: 0.9, reason: 'r' },
        { level: 'secondary', name: 'Theme B', confidence: 0.7, reason: 'r' },
        { level: 'tertiary', name: 'Theme C', confidence: 0.5, reason: 'r' },
      ],
      emotion: { label: 'joy', intensity: 0.6 },
      entities: [{ type: 'company', name: 'TestCo', mentions: 1 }],
      signals: [
        { type: 'emerging', description: 'growth', reason: 'positive trend' },
      ],
    })),
  });
}

suite('M8.5 — EnrichBatchWorker', () => {
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M8.5 Worker Test',
        role: 'analyst',
      },
    });
    userId = user.id;

    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M8.5 chat' },
    });
    chatId = chat.id;
  });

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await closeRedis().catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    publishedEvents.length = 0;
    queueAddCalls.length = 0;
    // Wipe per-user rows so each test starts on a known slate.
    await prisma.enrichment.deleteMany({ where: { userId } });
    await prisma.enrichmentBatch.deleteMany({
      where: { job: { userId } },
    });
    await prisma.enrichmentJob.deleteMany({ where: { userId } });
    await prisma.article.deleteMany({ where: { userId } });
  });

  /**
   * Test fixture: seeds N articles, an enrichment_job with batchCount=batches,
   * and `batches` enrichment_batches each holding articlesPerBatch ids.
   */
  async function seed(opts: {
    batches: number;
    articlesPerBatch: number;
  }): Promise<{
    jobId: string;
    batchIds: string[];
    articleIdsByBatch: string[][];
  }> {
    const totalArticles = opts.batches * opts.articlesPerBatch;
    const articles = await Promise.all(
      Array.from({ length: totalArticles }, (_, i) =>
        prisma.article.create({
          data: {
            chatId,
            userId,
            title: `Article ${i}`,
            content: `Body of article ${i} with enough text for token sizing.`,
            description: null,
            source: 'TestSource',
            author: 'Tester',
            publishedDate: new Date('2026-05-01'),
            url: `https://example.com/a${i}`,
            publisherDomain: 'example.com',
            language: 'en',
          },
        }),
      ),
    );

    const job = await prisma.enrichmentJob.create({
      data: {
        chatId,
        userId,
        totalArticles,
        batchCount: opts.batches,
        modelUsed: 'gpt-4.1-test',
        enrichmentType: 'standard',
        status: 'processing',
        startedAt: new Date(),
      },
    });

    const articleIdsByBatch: string[][] = [];
    const batchIds: string[] = [];
    for (let b = 0; b < opts.batches; b++) {
      const ids = articles
        .slice(b * opts.articlesPerBatch, (b + 1) * opts.articlesPerBatch)
        .map((a) => a.id);
      articleIdsByBatch.push(ids);
      const batchRow = await prisma.enrichmentBatch.create({
        data: {
          jobId: job.id,
          batchNumber: b + 1,
          articleIds: ids,
          estimatedTokens: 100,
          status: 'pending',
        },
      });
      batchIds.push(batchRow.id);
    }

    return { jobId: job.id, batchIds, articleIdsByBatch };
  }

  // ─── Case 1: happy path, single batch is the LAST batch ─────────────────
  it('happy path — 3 articles in a single batch → enrichments inserted + batch + job finalized', async () => {
    const { jobId, batchIds, articleIdsByBatch } = await seed({
      batches: 1,
      articlesPerBatch: 3,
    });
    const ids = articleIdsByBatch[0]!;
    scriptedComplete = async () => ({
      text: buildEnrichmentPayload(ids),
      tokensInput: 600,
      tokensOutput: 300,
      model: 'gpt-4.1-test',
      durationMs: 1234,
    });

    const result = await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[0]!,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: ids,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    expect(result).toEqual({ batchId: batchIds[0], processedCount: 3 });

    // 3 enrichment rows
    const enrichments = await prisma.enrichment.findMany({
      where: { userId, chatId },
    });
    expect(enrichments).toHaveLength(3);
    for (const e of enrichments) {
      expect(e.batchId).toBe(batchIds[0]);
      expect(e.modelUsed).toBe('gpt-4.1-test');
      expect(e.isValid).toBe(true);
    }

    // Batch row marked completed with actual tokens
    const freshBatch = await prisma.enrichmentBatch.findUniqueOrThrow({
      where: { id: batchIds[0]! },
    });
    expect(freshBatch.status).toBe('completed');
    expect(freshBatch.actualTokensIn).toBe(600);
    expect(freshBatch.actualTokensOut).toBe(300);
    expect(freshBatch.processingMs).not.toBeNull();

    // Parent job finalized
    const freshJob = await prisma.enrichmentJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(freshJob.status).toBe('completed');
    expect(freshJob.processedCount).toBe(3);
    expect(freshJob.batchesCompleted).toBe(1);
    expect(Number(freshJob.totalTokensInput)).toBe(600);
    expect(Number(freshJob.totalTokensOutput)).toBe(300);
    expect(freshJob.completedAt).not.toBeNull();

    // Event ordering: batch-start, batch-complete, progress, complete
    const types = publishedEvents.map((e) => e.type);
    expect(types).toEqual([
      'enrichment:batch-start',
      'enrichment:batch-complete',
      'enrichment:progress',
      'enrichment:complete',
    ]);

    const progress = publishedEvents.find((e) => e.type === 'enrichment:progress')!;
    expect((progress.payload as { percent: number }).percent).toBe(100);

    const complete = publishedEvents.find((e) => e.type === 'enrichment:complete')!;
    const cp = complete.payload as { totalArticles: number; status: string };
    expect(cp.totalArticles).toBe(3);
    expect(cp.status).toBe('completed');
  });

  // ─── Case 2: multi-batch — first batch emits progress but NOT complete ──
  it('multi-batch — first of two batches emits progress=50, no complete yet; second finalizes', async () => {
    const { jobId, batchIds, articleIdsByBatch } = await seed({
      batches: 2,
      articlesPerBatch: 2,
    });

    // ── Run batch 1 ────────────────────────────────────────────────────
    scriptedComplete = async () => ({
      text: buildEnrichmentPayload(articleIdsByBatch[0]!),
      tokensInput: 400,
      tokensOutput: 200,
      model: 'gpt-4.1-test',
      durationMs: 500,
    });
    await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[0]!,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: articleIdsByBatch[0]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    const typesAfterFirst = publishedEvents.map((e) => e.type);
    expect(typesAfterFirst).toContain('enrichment:batch-complete');
    expect(typesAfterFirst).toContain('enrichment:progress');
    expect(typesAfterFirst).not.toContain('enrichment:complete');

    const firstProgress = publishedEvents.find((e) => e.type === 'enrichment:progress')!;
    expect((firstProgress.payload as { percent: number }).percent).toBe(50);

    const jobAfterFirst = await prisma.enrichmentJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(jobAfterFirst.batchesCompleted).toBe(1);
    expect(jobAfterFirst.processedCount).toBe(2);
    expect(jobAfterFirst.status).toBe('processing'); // not yet finalized

    // ── Run batch 2 ────────────────────────────────────────────────────
    publishedEvents.length = 0;
    scriptedComplete = async () => ({
      text: buildEnrichmentPayload(articleIdsByBatch[1]!),
      tokensInput: 400,
      tokensOutput: 200,
      model: 'gpt-4.1-test',
      durationMs: 500,
    });
    await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[1]!,
        batchNumber: 2,
        chatId,
        userId,
        articleIds: articleIdsByBatch[1]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    const typesAfterSecond = publishedEvents.map((e) => e.type);
    expect(typesAfterSecond).toContain('enrichment:complete');

    const finalJob = await prisma.enrichmentJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(finalJob.status).toBe('completed');
    expect(finalJob.processedCount).toBe(4);
    expect(finalJob.batchesCompleted).toBe(2);
    expect(finalJob.completedAt).not.toBeNull();
  });

  // ─── Case 3: malformed JSON triggers retry path ──────────────────────────
  it('malformed JSON → batch goes retrying, batch-error emitted with retrying=true, job re-enqueued', async () => {
    const { jobId, batchIds, articleIdsByBatch } = await seed({
      batches: 1,
      articlesPerBatch: 2,
    });
    scriptedComplete = async () => ({
      text: 'not valid json at all',
      tokensInput: 100,
      tokensOutput: 0,
      model: 'gpt-4.1-test',
      durationMs: 100,
    });

    const result = await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[0]!,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: articleIdsByBatch[0]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    // Returns a failure marker (no throw, processor swallows in-band).
    expect(result).toEqual({ batchId: batchIds[0], failed: true });

    const freshBatch = await prisma.enrichmentBatch.findUniqueOrThrow({
      where: { id: batchIds[0]! },
    });
    expect(freshBatch.status).toBe('retrying');
    expect(freshBatch.retryCount).toBe(1);
    expect(freshBatch.error).toBeTruthy();

    const errEvent = publishedEvents.find(
      (e) => e.type === 'enrichment:batch-error',
    )!;
    expect(errEvent).toBeDefined();
    expect((errEvent.payload as { retrying: boolean }).retrying).toBe(true);

    // Queue re-add observed.
    const reAdd = queueAddCalls.find((c) => c.name === 'enrich-batch');
    expect(reAdd).toBeDefined();
    expect((reAdd!.data as { batchId: string }).batchId).toBe(batchIds[0]);

    // No `complete` since the batch did not finalize.
    expect(publishedEvents.map((e) => e.type)).not.toContain('enrichment:complete');
  });

  // ─── Case 4: Zod-invalid JSON (confidence > 1) → same retry path ────────
  it('Zod-invalid JSON (confidence>1) → retry path identical to malformed JSON', async () => {
    const { jobId, batchIds, articleIdsByBatch } = await seed({
      batches: 1,
      articlesPerBatch: 2,
    });
    // Schema demands confidence ≤ 1.
    scriptedComplete = async () => ({
      text: JSON.stringify({
        articles: articleIdsByBatch[0]!.map((id) => ({
          articleId: id,
          sentiment: { label: 'positive', confidence: 1.5, reason: 'r' },
          themes: [
            { level: 'main', name: 'A', confidence: 0.9, reason: 'r' },
            { level: 'secondary', name: 'B', confidence: 0.7, reason: 'r' },
            { level: 'tertiary', name: 'C', confidence: 0.5, reason: 'r' },
          ],
          emotion: { label: 'joy', intensity: 0.6 },
          entities: [{ type: 'company', name: 'X', mentions: 1 }],
          signals: [
            { type: 'emerging', description: 'd', reason: 'r' },
          ],
        })),
      }),
      tokensInput: 200,
      tokensOutput: 50,
      model: 'gpt-4.1-test',
      durationMs: 100,
    });

    await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[0]!,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: articleIdsByBatch[0]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    const freshBatch = await prisma.enrichmentBatch.findUniqueOrThrow({
      where: { id: batchIds[0]! },
    });
    expect(freshBatch.status).toBe('retrying');
    expect(freshBatch.retryCount).toBe(1);
    expect(freshBatch.error).toMatch(/schema validation/);
  });

  // ─── Case 5: retry exceeded → failed + job becomes 'partial' ────────────
  it('retry exhausted → batch failed, batch-error retrying=false, job finalizes as partial', async () => {
    // Two-batch setup: batch[0] succeeds, batch[1] runs at retry_count=3
    // (already exceeded) and should mark itself failed + finalize the job
    // as 'partial'.
    const { jobId, batchIds, articleIdsByBatch } = await seed({
      batches: 2,
      articlesPerBatch: 2,
    });

    // Pre-mark batch[1] with retry_count=3 to simulate exhausted retries.
    await prisma.enrichmentBatch.update({
      where: { id: batchIds[1]! },
      data: { retryCount: 3 },
    });

    // Run batch[0] cleanly.
    scriptedComplete = async () => ({
      text: buildEnrichmentPayload(articleIdsByBatch[0]!),
      tokensInput: 400,
      tokensOutput: 200,
      model: 'gpt-4.1-test',
      durationMs: 500,
    });
    await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[0]!,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: articleIdsByBatch[0]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    // Now run batch[1] with a malformed response — retry_count becomes 4,
    // which is > MAX_RETRIES, so it should mark failed (not retry).
    publishedEvents.length = 0;
    queueAddCalls.length = 0;
    scriptedComplete = async () => ({
      text: 'still not json',
      tokensInput: 50,
      tokensOutput: 0,
      model: 'gpt-4.1-test',
      durationMs: 100,
    });
    await enrichBatchProcessor(
      fakeJob({
        jobId,
        batchId: batchIds[1]!,
        batchNumber: 2,
        chatId,
        userId,
        articleIds: articleIdsByBatch[1]!,
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    const freshBatch = await prisma.enrichmentBatch.findUniqueOrThrow({
      where: { id: batchIds[1]! },
    });
    expect(freshBatch.status).toBe('failed');
    expect(freshBatch.retryCount).toBe(4);

    const errEvent = publishedEvents.find(
      (e) => e.type === 'enrichment:batch-error',
    )!;
    expect(errEvent).toBeDefined();
    expect((errEvent.payload as { retrying: boolean }).retrying).toBe(false);

    // No re-enqueue.
    expect(queueAddCalls.filter((c) => c.name === 'enrich-batch')).toHaveLength(0);

    // Job finalized as 'partial' (one batch completed, one failed).
    const finalJob = await prisma.enrichmentJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(finalJob.status).toBe('partial');
    expect(finalJob.completedAt).not.toBeNull();

    expect(publishedEvents.map((e) => e.type)).toContain('enrichment:complete');
  });

  // ─── Case 6: no articles loaded → batch failure ─────────────────────────
  it('articleIds resolve to zero rows → batch goes retrying with "no articles loaded" error', async () => {
    // Seed only the job + batch, but pass non-existent article ids.
    const job = await prisma.enrichmentJob.create({
      data: {
        chatId,
        userId,
        totalArticles: 1,
        batchCount: 1,
        modelUsed: 'gpt-4.1-test',
        enrichmentType: 'standard',
        status: 'processing',
        startedAt: new Date(),
      },
    });
    const bogusId = '00000000-0000-0000-0000-00000000dead';
    const batch = await prisma.enrichmentBatch.create({
      data: {
        jobId: job.id,
        batchNumber: 1,
        articleIds: [bogusId],
        estimatedTokens: 50,
        status: 'pending',
      },
    });

    // Provider should never even be called, but provide a sane stub.
    scriptedComplete = async () => ({
      text: '{}',
      tokensInput: 0,
      tokensOutput: 0,
      model: 'gpt-4.1-test',
      durationMs: 0,
    });

    await enrichBatchProcessor(
      fakeJob({
        jobId: job.id,
        batchId: batch.id,
        batchNumber: 1,
        chatId,
        userId,
        articleIds: [bogusId],
        enrichmentType: 'standard',
        modelName: 'gpt-4.1-test',
      }),
      'tok',
    );

    const freshBatch = await prisma.enrichmentBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(freshBatch.error).toMatch(/no articles loaded/);
    // First failure → retrying (count=1 ≤ MAX_RETRIES).
    expect(freshBatch.status).toBe('retrying');
  });
});
