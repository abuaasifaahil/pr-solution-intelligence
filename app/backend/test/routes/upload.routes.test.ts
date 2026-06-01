/**
 * M7.3 — upload routes integration test.
 *
 * Uses an in-memory data store (mirroring the data-source.routes pattern)
 * so the suite can run without a live Postgres. Storage and BullMQ are
 * mocked — the real wire paths are exercised by storage.test.ts and
 * queue.test.ts respectively. Here we focus on the route surface:
 * multipart parsing, MIME validation, the 50 MB cap, ownership checks,
 * and DELETE cleanup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ────────────────────────────────────────────────────────────────────────
// In-memory stores keyed by (id, userIdCtx). RLS isolation is simulated by
// gating reads/writes on the current userIdCtx, set by the withUser mock.
// ────────────────────────────────────────────────────────────────────────
interface UploadRow {
  id: string; userId: string; chatId: string; filename: string; mimeType: string;
  filePath: string; sizeBytes: bigint; rowCount: number | null; columnCount: number | null;
  schemaDetected: unknown; dateColumn: string | null; dateRangeStart: Date | null;
  dateRangeEnd: Date | null; status: 'uploading' | 'parsing' | 'ready' | 'error';
  errorMessage: string | null; parsedAt: Date | null; createdAt: Date;
}
const uploads: UploadRow[] = [];
const chats: Array<{ id: string; userId: string }> = [];
let userIdCtx = '';

const uploadMock = {
  create: vi.fn(async ({ data }: { data: Partial<UploadRow> }) => {
    const row: UploadRow = {
      id: data.id ?? randomUUID(),
      userId: data.userId!,
      chatId: data.chatId!,
      filename: data.filename!,
      mimeType: data.mimeType!,
      filePath: data.filePath!,
      sizeBytes: BigInt(data.sizeBytes ?? 0n),
      rowCount: null, columnCount: null, schemaDetected: [],
      dateColumn: null, dateRangeStart: null, dateRangeEnd: null,
      status: data.status ?? 'uploading', errorMessage: null, parsedAt: null,
      createdAt: new Date(),
    };
    uploads.push(row);
    return row;
  }),
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    uploads.find((r) => r.id === where.id && r.userId === userIdCtx) ?? null,
  ),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UploadRow> }) => {
    const r = uploads.find((x) => x.id === where.id);
    if (!r) throw new Error('not found');
    Object.assign(r, data);
    return { ...r };
  }),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const i = uploads.findIndex((x) => x.id === where.id);
    if (i >= 0) uploads.splice(i, 1);
    return {};
  }),
};

const chatMock = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    chats.find((c) => c.id === where.id && c.userId === userIdCtx) ?? null,
  ),
};

const articleMock = {
  findMany: vi.fn(async () => []),
  count: vi.fn(async () => 0),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    upload: uploadMock,
    chat: chatMock,
    article: articleMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ upload: uploadMock, chat: chatMock, article: articleMock });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

const storageMock = {
  putObject: vi.fn(async (key: string, body: Buffer) => ({ key, size: body.byteLength })),
  getObject: vi.fn(),
  deleteObject: vi.fn(async () => {}),
  getPresignedPutUrl: vi.fn(),
  ping: vi.fn(),
};

vi.mock('../../src/lib/storage.js', () => ({
  getStorage: () => storageMock,
  resetStorageForTests: vi.fn(),
}));

const queueMock = { add: vi.fn(async () => ({ id: 'job-1' })) };

vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => queueMock,
  startInlineWorker: vi.fn(),
  closeQueue: vi.fn(),
  QUEUE_NAME_PHASE2: 'phase2-jobs',
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const userA = '00000000-0000-0000-0000-00000000aaaa';
const userB = '00000000-0000-0000-0000-00000000bbbb';
const tokenA = signAccess({ userId: userA, email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: userB, email: 'b@test.local', role: 'analyst', sessionId: 's' });

// Build a minimal multipart/form-data body. We deliberately hand-roll this
// rather than depending on form-data because @fastify/multipart only needs
// well-formed CRLF boundaries.
function buildMultipart(opts: {
  file?: { name: string; content: Buffer; contentType: string };
  fields?: Record<string, string>;
}): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----prsiTestBoundary' + Math.random().toString(16).slice(2);
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(opts.fields ?? {})) {
    chunks.push(
      Buffer.from(`--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
        `${value}${CRLF}`,
      'utf8'),
    );
  }
  if (opts.file) {
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
  }
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

describe('Upload routes (integration)', () => {
  let app: FastifyInstance;
  let chatId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    uploads.length = 0;
    chats.length = 0;
    chatId = randomUUID();
    chats.push({ id: chatId, userId: userA });
    storageMock.putObject.mockClear();
    storageMock.deleteObject.mockClear();
    storageMock.putObject.mockImplementation(async (key: string, body: Buffer) => ({
      key,
      size: body.byteLength,
    }));
    queueMock.add.mockClear();
  });

  it('POST /uploads — valid CSV: 200, row inserted, putObject + queue.add called', async () => {
    const csv = Buffer.from('title,source\nHello,Acme\n');
    const { body, headers } = buildMultipart({
      file: { name: 'data.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.success).toBe(true);
    expect(out.data.upload.filename).toBe('data.csv');
    expect(out.data.upload.status).toBe('parsing');
    expect(out.data.upload.sizeBytes).toBe(csv.byteLength);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.userId).toBe(userA);
    expect(uploads[0]!.chatId).toBe(chatId);
    expect(storageMock.putObject).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledWith('parse-upload', expect.objectContaining({
      uploadId: uploads[0]!.id, userId: userA, chatId,
    }));
  });

  it('POST /uploads — oversize file: 413 (server-side limit)', async () => {
    // 51 MB to exceed the 50 MB cap.
    const big = Buffer.alloc(51 * 1024 * 1024, 'x');
    const { body, headers } = buildMultipart({
      file: { name: 'big.csv', content: big, contentType: 'text/csv' },
      fields: { chatId },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });

    expect(res.statusCode).toBe(413);
    expect(uploads).toHaveLength(0);
    expect(storageMock.putObject).not.toHaveBeenCalled();
  }, 30_000);

  it('POST /uploads — text/plain MIME with .csv filename: accepted', async () => {
    const csv = Buffer.from('a,b\n1,2\n');
    const { body, headers } = buildMultipart({
      file: { name: 'data.csv', content: csv, contentType: 'text/plain' },
      fields: { chatId },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.mimeType).toBe('text/plain');
  });

  it('POST /uploads — wrong MIME (image/png): 415', async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { body, headers } = buildMultipart({
      file: { name: 'pic.png', content: fakePng, contentType: 'image/png' },
      fields: { chatId },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });

    expect(res.statusCode).toBe(415);
    expect(uploads).toHaveLength(0);
  });

  it('POST /uploads — chatId not owned: 404', async () => {
    const otherChat = randomUUID();
    // No chat row -> findFirst returns null under RLS.
    const csv = Buffer.from('a,b\n1,2\n');
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId: otherChat },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
    expect(uploads).toHaveLength(0);
  });

  it('POST /uploads — missing auth: 401', async () => {
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: Buffer.from('a,b'), contentType: 'text/csv' },
      fields: { chatId },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers, payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /uploads/:id — returns own row', async () => {
    // Pre-seed via POST so we exercise the full create path.
    const csv = Buffer.from('a,b\n');
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });
    const post = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });
    const id = post.json().data.upload.id;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/uploads/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.upload.id).toBe(id);
  });

  it('GET /uploads/:id — Bob cannot read Alice (RLS isolation): 404', async () => {
    const csv = Buffer.from('a,b\n');
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });
    const post = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });
    const id = post.json().data.upload.id;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/uploads/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /uploads/:id/preview?limit=5 — works (returns stub while status=parsing)', async () => {
    const csv = Buffer.from('a,b\n');
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });
    const post = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });
    const id = post.json().data.upload.id;

    const res = await app.inject({
      method: 'GET', url: `/api/v1/uploads/${id}/preview?limit=5`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ rows: [], columns: [], total: 0, status: 'parsing' });
  });

  it('DELETE /uploads/:id — removes row and calls storage.deleteObject', async () => {
    const csv = Buffer.from('a,b\n');
    const { body, headers } = buildMultipart({
      file: { name: 'd.csv', content: csv, contentType: 'text/csv' },
      fields: { chatId },
    });
    const post = await app.inject({
      method: 'POST', url: '/api/v1/uploads',
      headers: { authorization: `Bearer ${tokenA}`, ...headers },
      payload: body,
    });
    const id = post.json().data.upload.id;
    const filePath = uploads[0]!.filePath;

    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/uploads/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(uploads).toHaveLength(0);
    expect(storageMock.deleteObject).toHaveBeenCalledWith(filePath);
  });
});
