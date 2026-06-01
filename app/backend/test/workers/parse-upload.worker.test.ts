/**
 * M7.4 — ParseUploadWorker integration test.
 *
 * Exercises the full processor pipeline against the real Postgres + Prisma
 * stack. Storage is mocked (we feed it a CSV stream directly so the test
 * doesn't have to round-trip through MinIO) and publishChatEvent is captured
 * for assertion.
 *
 * Requires a live Postgres. Falls back to the docker-compose dev URL so
 * `pnpm test` works without manually exporting DATABASE_URL (mirrors the
 * phase2-rls.integration test). If Postgres can't be reached the suite is
 * skipped with a clear log line — same posture as queue.test.ts.
 */
process.env.DATABASE_URL ??=
  'postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public';
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.STORAGE_MODE ??= 'inmemory';

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Job } from 'bullmq';

// ─── Probe Postgres BEFORE importing modules that hold a live client. ─────
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
    '[parse-upload.worker.test] skipping — Postgres unreachable at',
    process.env.DATABASE_URL,
  );
}

// ─── Mocks (declared BEFORE dynamic imports so vi.mock hoisting applies). ─

// Storage: replaced per-test by setting `getObjectImpl`.
let getObjectImpl: (key: string) => Promise<NodeJS.ReadableStream> = async () => {
  throw new Error('getObjectImpl not set');
};
vi.mock('../../src/lib/storage.js', () => ({
  getStorage: () => ({
    putObject: vi.fn(),
    getObject: (key: string) => getObjectImpl(key),
    deleteObject: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    ping: vi.fn(),
  }),
  resetStorageForTests: vi.fn(),
}));

// Event bus: capture every event the worker emits.
const publishedEvents: Array<{ chatId: string; type: string; payload: unknown }> = [];
vi.mock('../../src/lib/event-bus.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/event-bus.js')>(
      '../../src/lib/event-bus.js',
    );
  return {
    ...actual,
    publishChatEvent: vi.fn(async (chatId: string, type: string, payload: unknown) => {
      publishedEvents.push({ chatId, type, payload });
    }),
  };
});

// Dynamic imports — only safe after vi.mock declarations above.
const { prisma } = await import('@prsi/shared/db');
const { hashPassword } = await import('../../src/lib/bcrypt.js');
const { parseUploadProcessor } = await import('../../src/workers/parse-upload.worker.js');
const { closeRedis } = await import('../../src/lib/redis.js');

const TEST_EMAIL = 'm7-4-worker@test.local';

/** Build a fake BullMQ job — we never actually enqueue. */
function fakeJob(data: { uploadId: string; userId: string; chatId: string }): Job {
  return {
    name: 'parse-upload',
    data,
    id: 'test-job',
  } as unknown as Job;
}

suite('M7.4 — ParseUploadWorker', () => {
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    // Cleanup leftovers from prior runs (cascade clears any owned rows).
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

    const user = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M7.4 Worker Test',
        role: 'analyst',
      },
    });
    userId = user.id;

    const chat = await prisma.chat.create({
      data: { userId, agentType: 'pr_impact', title: 'M7.4 chat' },
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
    // Each test starts with no upload / article rows for this user.
    await prisma.article.deleteMany({ where: { userId } });
    await prisma.upload.deleteMany({ where: { userId } });
  });

  it('parses a 5-row CSV → status=ready, 5 articles inserted, upload:parsed emitted', async () => {
    // Seed an upload row already in `parsing` state (M7.3 leaves it there).
    const upload = await prisma.upload.create({
      data: {
        userId,
        chatId,
        filename: 'data.csv',
        mimeType: 'text/csv',
        filePath: `uploads/${userId}/test/data.csv`,
        sizeBytes: BigInt(200),
        status: 'parsing',
      },
    });

    // Mock storage to return a 5-row CSV with mixed column names.
    const csv = [
      'headline,body,publisher,published_date,url',
      'AMX Series B,Round of $50M,TechCrunch,2025-03-10,https://www.techcrunch.com/a',
      'IPO filed,Filing today,Reuters,2025-03-12,https://reuters.com/b',
      'Hiring spree,200 new roles,WSJ,2025-03-15,https://www.wsj.com/c',
      'New product,Launch event,The Verge,2025-03-18,https://www.theverge.com/d',
      'Earnings beat,Q1 results,Bloomberg,2025-03-20,https://bloomberg.com/e',
    ].join('\n');
    getObjectImpl = async () => Readable.from(Buffer.from(csv, 'utf8'));

    const result = await parseUploadProcessor(
      fakeJob({ uploadId: upload.id, userId, chatId }),
      'tok',
    );

    expect(result).toEqual({ uploadId: upload.id, rowCount: 5 });

    // Upload row should be flipped to 'ready' with all metadata populated.
    const fresh = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(fresh.status).toBe('ready');
    expect(fresh.rowCount).toBe(5);
    expect(fresh.columnCount).toBe(5);
    expect(fresh.dateColumn).toBe('published_date');
    expect(fresh.dateRangeStart).not.toBeNull();
    expect(fresh.dateRangeEnd).not.toBeNull();
    expect(fresh.parsedAt).not.toBeNull();
    expect(Array.isArray(fresh.schemaDetected)).toBe(true);
    expect((fresh.schemaDetected as Array<{ name: string }>).length).toBe(5);

    // 5 articles inserted, all denormalized userId/chatId correctly.
    const articles = await prisma.article.findMany({ where: { uploadId: upload.id } });
    expect(articles).toHaveLength(5);
    for (const a of articles) {
      expect(a.userId).toBe(userId);
      expect(a.chatId).toBe(chatId);
      expect(a.title).not.toBe('');
    }
    // First article: column-alias mapping worked (`headline` → title).
    const first = articles.find((a) => a.title === 'AMX Series B');
    expect(first).toBeDefined();
    expect(first?.content).toBe('Round of $50M');
    expect(first?.source).toBe('TechCrunch');
    expect(first?.publisherDomain).toBe('techcrunch.com');

    // WS event emission.
    const parsed = publishedEvents.find((e) => e.type === 'upload:parsed');
    expect(parsed).toBeDefined();
    expect(parsed?.chatId).toBe(chatId);
    const payload = parsed?.payload as {
      uploadId: string;
      rowCount: number;
      columns: string[];
      dateRange: { start: string; end: string } | null;
    };
    expect(payload.uploadId).toBe(upload.id);
    expect(payload.rowCount).toBe(5);
    expect(payload.columns).toEqual([
      'headline',
      'body',
      'publisher',
      'published_date',
      'url',
    ]);
    expect(payload.dateRange).not.toBeNull();
  });

  it('empty CSV → status=error, no articles, upload:error emitted, processor throws', async () => {
    const upload = await prisma.upload.create({
      data: {
        userId,
        chatId,
        filename: 'empty.csv',
        mimeType: 'text/csv',
        filePath: `uploads/${userId}/test/empty.csv`,
        sizeBytes: BigInt(0),
        status: 'parsing',
      },
    });

    // Header-only CSV → PapaParse yields zero data rows.
    getObjectImpl = async () =>
      Readable.from(Buffer.from('title,source\n', 'utf8'));

    await expect(
      parseUploadProcessor(
        fakeJob({ uploadId: upload.id, userId, chatId }),
        'tok',
      ),
    ).rejects.toThrow(/0 rows/);

    const fresh = await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(fresh.status).toBe('error');
    expect(fresh.errorMessage).toMatch(/0 rows/);

    const articleCount = await prisma.article.count({ where: { uploadId: upload.id } });
    expect(articleCount).toBe(0);

    const errEvent = publishedEvents.find((e) => e.type === 'upload:error');
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { uploadId: string }).uploadId).toBe(upload.id);
  });
});
