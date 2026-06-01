/**
 * M7.10 — Phase 2 full-pipeline integration test.
 *
 * Walks the entire Phase 2 user journey end-to-end against a live Postgres
 * and live Redis, with a real BullMQ inline worker driving both Phase 2
 * processors (parse-upload + data-extract):
 *
 *   1. Seed: user (Alice) + chat (PR Impact agent).
 *   2. POST /api/v1/uploads        — multipart CSV → S3 (inmemory) → queue.
 *   3. Poll GET /uploads/:id       — parse-upload worker flips status='ready'.
 *   4. Assert: schema + dateRange + articles inserted with publisher_domain.
 *   5. PATCH /chats/:id/params     — enrichment + brand + competitors + intention.
 *   6. POST /chats/:id/query/generate  — query references brand/competitors/dates.
 *   7. POST /chats/:id/query/confirm   — enqueue data-extract.
 *   8. Poll GET /chats/:id/params — DataExtractAgent flips flowState='complete'.
 *   9. Assert: subscribed event bus emitted the expected WS events.
 *
 * Requires both live Postgres AND Redis. Skips otherwise (same posture as
 * the M7.4 / M7.7 worker integration tests). The LLM is mocked so the suite
 * runs without an Azure OpenAI key — every other layer is real.
 *
 * @file test/integration/phase2-pipeline.integration.test.ts
 */
process.env.DATABASE_URL ??=
  'postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.STORAGE_MODE ??= 'inmemory';
// Force the server bootstrap path that registers + starts the inline worker.
// (server.ts skips startInlineWorker when NODE_ENV === 'test'.)
process.env.NODE_ENV = 'development';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

// ─── Mock the LLM so we don't need an Azure key. The test uses chip clicks
//     (no free-text), so chatComplete is only needed for brand-suggest, which
//     we don't exercise here. Mock both for safety. ─────────────────────────
vi.mock('../../src/lib/llm.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/llm.js')>(
    '../../src/lib/llm.js',
  );
  return {
    ...actual,
    chatComplete: vi.fn().mockResolvedValue(
      JSON.stringify({ top5: [], top3: [], top2: [] }),
    ),
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

async function redisCompatible(url: string): Promise<{ ok: boolean; reason?: string }> {
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
    if (major < 5) return { ok: false, reason: `Redis ${major}.x < 5.0 (BullMQ minimum)` };
    return { ok: true };
  } catch (err) {
    try { probe.disconnect(); } catch { /* ignore */ }
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
    '[phase2-pipeline.integration.test] skipping —',
    'PG_OK=', PG_OK,
    'REDIS_OK=', REDIS.ok,
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
const { subscribeChatEvents } = await import('../../src/lib/event-bus.js');

const TEST_EMAIL = 'm7-10-pipeline@test.local';

function buildMultipart(opts: {
  file: { name: string; content: Buffer; contentType: string };
  fields: Record<string, string>;
}): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----prsiPipelineBoundary' + Math.random().toString(16).slice(2);
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(opts.fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
        'utf8',
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${opts.file.name}"${CRLF}` +
        `Content-Type: ${opts.file.contentType}${CRLF}${CRLF}`,
      'utf8',
    ),
  );
  chunks.push(opts.file.content);
  chunks.push(Buffer.from(CRLF, 'utf8'));
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.byteLength),
    },
  };
}

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
      throw new Error(`pollUntil(${opts.label}) timed out after ${opts.timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

suite('M7.10 — Phase 2 full-pipeline integration', () => {
  let app: FastifyInstance;
  let userId: string;
  let token: string;
  let chatId: string;
  const observedEvents: Array<{ type: string; payload: unknown }> = [];
  let unsubscribe: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // Clean any leftover rows from prior runs.
    await prisma.article.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.upload.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.booleanQuery.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chatParams.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.message.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M7.10 Pipeline Test',
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

    // Drain anything left in the queue from earlier test runs so jobs we
    // enqueue here are the only ones the worker processes.
    await getQueue().drain(true).catch(() => {});

    // Seed a chat (PR Impact agent). The chat row owns the upload + params.
    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M7.10 chat' },
    });
    chatId = chat.id;

    // Subscribe to the chat event bus so we can assert WS event emission.
    unsubscribe = await subscribeChatEvents(chatId, (e) => {
      observedEvents.push(e);
    });
  });

  afterAll(async () => {
    if (unsubscribe) await unsubscribe().catch(() => {});
    try { await app.close(); } catch { /* ignore */ }
    await closeQueue().catch(() => {});

    // Cleanup all owned rows. Cascade on user delete handles most.
    await prisma.article.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.upload.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.booleanQuery.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chatParams.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.message.deleteMany({
      where: { chat: { user: { email: TEST_EMAIL } } },
    });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await closeRedis().catch(() => {});
    await prisma.$disconnect();
  });

  it('walks upload → parse → params → query → confirm → 7-step processing → complete', async () => {
    // ── 1. POST /api/v1/uploads ──────────────────────────────────────────
    const csv = Buffer.from(
      [
        'title,content,source,published_date,url',
        'AMX Series B,Round of $50M,TechCrunch,2025-03-10,https://www.techcrunch.com/a',
        'IPO filed,Filing today,Reuters,2025-03-12,https://reuters.com/b',
        'Hiring spree,200 new roles,WSJ,2025-03-15,https://www.wsj.com/c',
        'Earnings beat,Q1 results,Bloomberg,2025-03-20,https://bloomberg.com/d',
      ].join('\n'),
      'utf8',
    );
    const { body, headers } = buildMultipart({
      file: { name: 'pipeline.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });

    const postUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: body,
    });
    expect(postUpload.statusCode).toBe(200);
    const uploadId = postUpload.json().data.upload.id as string;
    expect(uploadId).toBeTruthy();
    expect(postUpload.json().data.upload.status).toBe('parsing');

    // ── 2. Poll until ParseUploadWorker flips status='ready'. ────────────
    const ready = await pollUntil(
      async () => {
        const r = await app.inject({
          method: 'GET',
          url: `/api/v1/uploads/${uploadId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        return r.json().data.upload as {
          id: string;
          status: string;
          rowCount: number | null;
          columnCount: number | null;
          schemaDetected: unknown;
          dateColumn: string | null;
          dateRangeStart: string | null;
          dateRangeEnd: string | null;
        };
      },
      (u) => u.status === 'ready' || u.status === 'error',
      { timeoutMs: 10_000, label: 'upload→ready' },
    );

    expect(ready.status).toBe('ready');
    expect(ready.rowCount).toBe(4);
    expect(ready.columnCount).toBe(5);
    expect(ready.dateColumn).toBe('published_date');
    expect(ready.dateRangeStart).not.toBeNull();
    expect(ready.dateRangeEnd).not.toBeNull();
    expect(Array.isArray(ready.schemaDetected)).toBe(true);

    // ── 3. Article rows inserted with publisher_domain extracted. ────────
    const articles = await prisma.article.findMany({ where: { uploadId } });
    expect(articles).toHaveLength(4);
    for (const a of articles) {
      expect(a.userId).toBe(userId);
      expect(a.chatId).toBe(chatId);
      expect(a.publisherDomain).toBeTruthy();
    }

    // ── 4. PATCH /chats/:id/params — fill the rest of the flow ───────────
    //
    // The flow engine skips collect_dates when an upload with auto-detected
    // dates exists. We don't manually wire hasUpload here — chat_params
    // will be lazily created by getOrCreateParams (no upload link). For the
    // integration test we PATCH the params directly with all collected
    // fields so the engine lands on `generate_query`.
    const patch1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/chats/${chatId}/params`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: {
        enrichmentType: 'standard',
        brand: 'AMX',
        competitors: ['Reuters', 'Bloomberg'],
        competitorSet: 'custom',
        intention: 'intention_based',
        dateStart: ready.dateRangeStart,
        dateEnd: ready.dateRangeEnd,
        hasUpload: true,
        uploadId,
      },
    });
    expect(patch1.statusCode).toBe(200);
    const patched = patch1.json().data.params as { flowState: string };
    // With all fields set + no confirmed query, the engine returns
    // `generate_query`.
    expect(patched.flowState).toBe('generate_query');

    // ── 5. POST /chats/:id/query/generate ────────────────────────────────
    const gen = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/generate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gen.statusCode).toBe(200);
    const genBody = gen.json().data.query as {
      id: string;
      text: string;
      version: number;
      isConfirmed: boolean;
    };
    expect(genBody.version).toBe(1);
    expect(genBody.isConfirmed).toBe(false);
    // Query references brand + at least one competitor.
    expect(genBody.text).toContain('AMX');
    expect(genBody.text).toMatch(/Reuters|Bloomberg/);

    // ── 6. POST /chats/:id/query/confirm — enqueues data-extract. ────────
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/chats/${chatId}/query/confirm`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().data.processingJobId).toBeTruthy();

    // ── 7. Poll until DataExtractAgent flips flowState='complete'. ───────
    const completed = await pollUntil(
      async () => {
        const r = await app.inject({
          method: 'GET',
          url: `/api/v1/chats/${chatId}/params`,
          headers: { authorization: `Bearer ${token}` },
        });
        return r.json().data.params as { flowState: string };
      },
      (p) => p.flowState === 'complete' || p.flowState === 'error',
      { timeoutMs: 15_000, label: 'params→complete' },
    );
    expect(completed.flowState).toBe('complete');

    // ── 8. WS-style event assertions on subscribed channel. ──────────────
    // Allow a beat for the last few pub/sub messages to arrive.
    await new Promise((r) => setTimeout(r, 200));

    const types = observedEvents.map((e) => e.type);
    // Upload pipeline event(s).
    expect(types).toContain('upload:parsed');
    // Flow state-change(s) — generate_query → processing → complete.
    expect(types).toContain('flow:state-change');
    // Processing pipeline.
    expect(types).toContain('processing:step');
    expect(types).toContain('processing:complete');

    // Final processing:complete payload carries totals.
    const finalComplete = observedEvents.find((e) => e.type === 'processing:complete');
    expect(finalComplete).toBeDefined();
    const cp = finalComplete!.payload as {
      chatId: string;
      totalArticles: number;
      domains: number;
    };
    expect(cp.chatId).toBe(chatId);
    expect(cp.totalArticles).toBe(4);
    expect(cp.domains).toBeGreaterThan(0);
  }, 30_000);
});
