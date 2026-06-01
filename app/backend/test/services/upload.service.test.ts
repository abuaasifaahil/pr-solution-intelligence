/**
 * M7.3 — upload.service unit tests.
 *
 * Pure-unit suite: storage adapter and BullMQ queue are stubbed with vi.mock,
 * Prisma is a per-test in-memory Map keyed by upload id (mirroring the
 * data-source.service pattern).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

interface UploadRow {
  id: string;
  userId: string;
  chatId: string;
  filename: string;
  mimeType: string;
  filePath: string;
  sizeBytes: bigint;
  rowCount: number | null;
  columnCount: number | null;
  schemaDetected: unknown;
  dateColumn: string | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  status: 'uploading' | 'parsing' | 'ready' | 'error';
  errorMessage: string | null;
  parsedAt: Date | null;
  createdAt: Date;
}

const uploadStore: UploadRow[] = [];
const chatStore: Array<{ id: string; userId: string }> = [];
const articleStore: Array<{
  id: string; uploadId: string | null; chatId: string; userId: string;
  title: string; content: string | null; description: string | null; source: string | null;
  author: string | null; publishedDate: Date | null; url: string | null;
  publisherDomain: string | null; language: string; rawData: unknown;
}> = [];

const mockUpload = {
  create: vi.fn(async ({ data }: { data: Partial<UploadRow> }) => {
    const row: UploadRow = {
      id: data.id ?? `up-${uploadStore.length + 1}`,
      userId: data.userId!,
      chatId: data.chatId!,
      filename: data.filename!,
      mimeType: data.mimeType!,
      filePath: data.filePath!,
      sizeBytes: BigInt(data.sizeBytes ?? 0n),
      rowCount: null, columnCount: null, schemaDetected: [],
      dateColumn: null, dateRangeStart: null, dateRangeEnd: null,
      status: data.status ?? 'uploading',
      errorMessage: null, parsedAt: null,
      createdAt: new Date(),
    };
    uploadStore.push(row);
    return row;
  }),
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    uploadStore.find((r) => r.id === where.id) ?? null,
  ),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UploadRow> }) => {
    const r = uploadStore.find((x) => x.id === where.id);
    if (!r) throw new Error('not found');
    Object.assign(r, data);
    return { ...r };
  }),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const i = uploadStore.findIndex((x) => x.id === where.id);
    if (i >= 0) uploadStore.splice(i, 1);
    return {};
  }),
};

const mockChat = {
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
    chatStore.find((c) => c.id === where.id) ?? null,
  ),
};

const mockArticle = {
  findMany: vi.fn(async ({ where, take }: { where: { uploadId: string }; take?: number }) =>
    articleStore.filter((a) => a.uploadId === where.uploadId).slice(0, take ?? 100),
  ),
  count: vi.fn(async ({ where }: { where: { uploadId: string } }) =>
    articleStore.filter((a) => a.uploadId === where.uploadId).length,
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    upload: mockUpload,
    chat: mockChat,
    article: mockArticle,
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ upload: mockUpload, chat: mockChat, article: mockArticle }),
  ),
  asAdmin: vi.fn(),
}));

const storageMock = {
  putObject: vi.fn(async (key: string, body: Buffer, _opts?: { contentType?: string }) => ({
    key, size: body.byteLength,
  })),
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

const { createUpload, getUpload, getUploadPreview, deleteUpload } = await import(
  '../../src/services/upload.service.js'
);

const TEST_UUID_USER = '00000000-0000-0000-0000-00000000aaaa';
const TEST_UUID_CHAT = '00000000-0000-0000-0000-00000000bbbb';

describe('upload.service', () => {
  beforeEach(() => {
    uploadStore.length = 0;
    chatStore.length = 0;
    articleStore.length = 0;
    Object.values(mockUpload).forEach((f) => (f as ReturnType<typeof vi.fn>).mockClear());
    Object.values(mockChat).forEach((f) => (f as ReturnType<typeof vi.fn>).mockClear());
    Object.values(mockArticle).forEach((f) => (f as ReturnType<typeof vi.fn>).mockClear());
    storageMock.putObject.mockClear();
    storageMock.deleteObject.mockClear();
    storageMock.putObject.mockImplementation(async (key: string, body: Buffer, _opts?: { contentType?: string }) => ({
      key,
      size: body.byteLength,
    }));
    queueMock.add.mockClear();
  });

  it('createUpload — happy path: inserts row, persists bytes, enqueues parse job', async () => {
    chatStore.push({ id: TEST_UUID_CHAT, userId: TEST_UUID_USER });
    const buf = Buffer.from('a,b,c\n1,2,3\n');

    const result = await createUpload(TEST_UUID_USER, {
      chatId: TEST_UUID_CHAT,
      filename: 'data.csv',
      mimeType: 'text/csv',
      buffer: buf,
    });

    // Row written with correct field values.
    expect(uploadStore).toHaveLength(1);
    const row = uploadStore[0]!;
    expect(row.userId).toBe(TEST_UUID_USER);
    expect(row.chatId).toBe(TEST_UUID_CHAT);
    expect(row.filename).toBe('data.csv');
    expect(row.mimeType).toBe('text/csv');
    expect(row.filePath).toBe(`uploads/${TEST_UUID_USER}/${row.id}/data.csv`);
    expect(Number(row.sizeBytes)).toBe(buf.byteLength);
    expect(row.status).toBe('parsing'); // flipped after putObject

    // Storage called with the same key + bytes.
    expect(storageMock.putObject).toHaveBeenCalledTimes(1);
    const [callKey, callBody, callOpts] = storageMock.putObject.mock.calls[0]!;
    expect(callKey).toBe(row.filePath);
    expect(Buffer.isBuffer(callBody) ? callBody.equals(buf) : false).toBe(true);
    expect(callOpts).toEqual({ contentType: 'text/csv' });

    // Job enqueued.
    expect(queueMock.add).toHaveBeenCalledWith('parse-upload', {
      uploadId: row.id,
      userId: TEST_UUID_USER,
      chatId: TEST_UUID_CHAT,
    });

    // Returned shape is the minimal response payload.
    expect(result).toEqual({
      id: row.id,
      filename: 'data.csv',
      status: 'parsing',
      sizeBytes: buf.byteLength,
      createdAt: row.createdAt,
    });
  });

  it('createUpload — throws when chat is not owned by the user', async () => {
    // chatStore intentionally empty -> findFirst returns null under RLS.
    await expect(
      createUpload(TEST_UUID_USER, {
        chatId: TEST_UUID_CHAT,
        filename: 'x.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('a'),
      }),
    ).rejects.toThrow('Chat not found');
    expect(uploadStore).toHaveLength(0);
    expect(storageMock.putObject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('createUpload — storage failure marks the row status=error and rethrows', async () => {
    chatStore.push({ id: TEST_UUID_CHAT, userId: TEST_UUID_USER });
    storageMock.putObject.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });

    await expect(
      createUpload(TEST_UUID_USER, {
        chatId: TEST_UUID_CHAT,
        filename: 'x.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('a,b'),
      }),
    ).rejects.toThrow('Storage failure: disk full');

    expect(uploadStore).toHaveLength(1);
    expect(uploadStore[0]!.status).toBe('error');
    expect(uploadStore[0]!.errorMessage).toMatch(/disk full/);
    // No queue.add on failure.
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('getUpload — returns own row', async () => {
    uploadStore.push({
      id: 'u1', userId: TEST_UUID_USER, chatId: TEST_UUID_CHAT,
      filename: 'a.csv', mimeType: 'text/csv', filePath: 'k', sizeBytes: BigInt(10),
      rowCount: null, columnCount: null, schemaDetected: [], dateColumn: null,
      dateRangeStart: null, dateRangeEnd: null, status: 'ready',
      errorMessage: null, parsedAt: null, createdAt: new Date(),
    });
    const out = await getUpload(TEST_UUID_USER, 'u1');
    expect(out).not.toBeNull();
    expect(out!.id).toBe('u1');
    expect(out!.sizeBytes).toBe(10);
    expect(out!.status).toBe('ready');
  });

  it('getUpload — returns null when the row is missing (RLS filter)', async () => {
    const out = await getUpload(TEST_UUID_USER, 'u-missing');
    expect(out).toBeNull();
  });

  it('getUploadPreview — returns articles joined when status=ready', async () => {
    uploadStore.push({
      id: 'u1', userId: TEST_UUID_USER, chatId: TEST_UUID_CHAT,
      filename: 'a.csv', mimeType: 'text/csv', filePath: 'k', sizeBytes: BigInt(10),
      rowCount: 2, columnCount: 2, schemaDetected: [{ name: 'title' }, { name: 'source' }],
      dateColumn: null, dateRangeStart: null, dateRangeEnd: null,
      status: 'ready', errorMessage: null, parsedAt: new Date(), createdAt: new Date(),
    });
    articleStore.push({
      id: 'a1', uploadId: 'u1', chatId: TEST_UUID_CHAT, userId: TEST_UUID_USER,
      title: 'Hi', content: null, description: null, source: 'S', author: null,
      publishedDate: null, url: null, publisherDomain: null, language: 'en', rawData: {},
    });
    const preview = await getUploadPreview(TEST_UUID_USER, 'u1', 5);
    expect(preview.status).toBe('ready');
    expect(preview.total).toBe(1);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.title).toBe('Hi');
    expect(preview.columns).toEqual(['title', 'source']);
  });

  it('getUploadPreview — returns empty stub (not 404) while status != ready', async () => {
    uploadStore.push({
      id: 'u1', userId: TEST_UUID_USER, chatId: TEST_UUID_CHAT,
      filename: 'a.csv', mimeType: 'text/csv', filePath: 'k', sizeBytes: BigInt(10),
      rowCount: null, columnCount: null, schemaDetected: [], dateColumn: null,
      dateRangeStart: null, dateRangeEnd: null, status: 'parsing',
      errorMessage: null, parsedAt: null, createdAt: new Date(),
    });
    const preview = await getUploadPreview(TEST_UUID_USER, 'u1', 5);
    expect(preview).toEqual({ rows: [], columns: [], total: 0, status: 'parsing' });
  });

  it('deleteUpload — removes the row and calls storage.deleteObject', async () => {
    uploadStore.push({
      id: 'u1', userId: TEST_UUID_USER, chatId: TEST_UUID_CHAT,
      filename: 'a.csv', mimeType: 'text/csv', filePath: 'uploads/u/u1/a.csv',
      sizeBytes: BigInt(10), rowCount: null, columnCount: null, schemaDetected: [],
      dateColumn: null, dateRangeStart: null, dateRangeEnd: null,
      status: 'ready', errorMessage: null, parsedAt: null, createdAt: new Date(),
    });
    await deleteUpload(TEST_UUID_USER, 'u1');
    expect(storageMock.deleteObject).toHaveBeenCalledWith('uploads/u/u1/a.csv');
    expect(uploadStore).toHaveLength(0);
  });

  it('deleteUpload — proceeds when storage.deleteObject throws (best-effort)', async () => {
    uploadStore.push({
      id: 'u1', userId: TEST_UUID_USER, chatId: TEST_UUID_CHAT,
      filename: 'a.csv', mimeType: 'text/csv', filePath: 'k',
      sizeBytes: BigInt(10), rowCount: null, columnCount: null, schemaDetected: [],
      dateColumn: null, dateRangeStart: null, dateRangeEnd: null,
      status: 'ready', errorMessage: null, parsedAt: null, createdAt: new Date(),
    });
    storageMock.deleteObject.mockImplementationOnce(async () => {
      throw new Error('s3 gone');
    });
    // Suppress noisy log inside the catch block.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deleteUpload(TEST_UUID_USER, 'u1');
    expect(uploadStore).toHaveLength(0);
    errSpy.mockRestore();
  });

  it('deleteUpload — 404 when row not owned (RLS filter)', async () => {
    await expect(deleteUpload(TEST_UUID_USER, 'missing')).rejects.toThrow('Upload not found');
  });
});
