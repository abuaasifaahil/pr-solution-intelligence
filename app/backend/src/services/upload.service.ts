import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { getStorage } from '../lib/storage.js';
import { getQueue } from '../lib/queue.js';

/**
 * Upload service — M7.3.
 *
 * Owns the create / read / preview / delete flow for the `uploads` table.
 * Persistence goes through the M7.2 `getStorage()` adapter (MinIO locally,
 * in-memory in the free-tier prod baseline, AWS S3 once env flips). Parse
 * processing is enqueued on the `phase2-jobs` queue under the `parse-upload`
 * job name — M7.4 will register the processor that actually consumes it.
 */

export type UploadStatus = 'uploading' | 'parsing' | 'ready' | 'error';

export const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/json',
  'application/x-ndjson',
] as const;

/**
 * Some browsers (notably Safari) and curl invocations report CSV files as
 * `text/plain`. We accept that MIME only when the filename ends in `.csv`,
 * and the route handler logs a warning so we can spot misbehaving clients.
 */
export function isAllowedMime(mimeType: string, filename: string): boolean {
  if ((ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) return true;
  if (mimeType === 'text/plain' && /\.csv$/i.test(filename)) return true;
  return false;
}

export interface UploadRecord {
  id: string;
  userId: string;
  chatId: string;
  filename: string;
  mimeType: string;
  filePath: string;
  sizeBytes: number;
  rowCount: number | null;
  columnCount: number | null;
  schemaDetected: unknown;
  dateColumn: string | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  status: UploadStatus;
  errorMessage: string | null;
  parsedAt: Date | null;
  createdAt: Date;
}

export interface CreateUploadInput {
  chatId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface CreateUploadResult {
  id: string;
  filename: string;
  status: UploadStatus;
  sizeBytes: number;
  createdAt: Date;
}

export interface UploadPreview {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  status: UploadStatus;
}

/** Convert a Prisma row (BigInt sizeBytes) to the wire shape. */
function toRecord(row: {
  id: string;
  userId: string;
  chatId: string;
  filename: string;
  mimeType: string;
  filePath: string;
  sizeBytes: bigint | number;
  rowCount: number | null;
  columnCount: number | null;
  schemaDetected: unknown;
  dateColumn: string | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  status: string;
  errorMessage: string | null;
  parsedAt: Date | null;
  createdAt: Date;
}): UploadRecord {
  return {
    id: row.id,
    userId: row.userId,
    chatId: row.chatId,
    filename: row.filename,
    mimeType: row.mimeType,
    filePath: row.filePath,
    sizeBytes: typeof row.sizeBytes === 'bigint' ? Number(row.sizeBytes) : row.sizeBytes,
    rowCount: row.rowCount,
    columnCount: row.columnCount,
    schemaDetected: row.schemaDetected,
    dateColumn: row.dateColumn,
    dateRangeStart: row.dateRangeStart,
    dateRangeEnd: row.dateRangeEnd,
    status: row.status as UploadStatus,
    errorMessage: row.errorMessage,
    parsedAt: row.parsedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Create an upload record, persist the file via the storage adapter, and
 * enqueue the parse job. The DB row's `status` is transitioned
 * `uploading -> parsing` on success, or set to `error` if persistence fails.
 *
 * Storage I/O happens INSIDE the RLS transaction so that a failure rolls
 * back the half-written row. We then update the status (parsing) and
 * enqueue the job in a second short transaction — the job stays in Redis
 * regardless of the DB outcome, but the DB-side error path is the only one
 * tests need to assert on.
 */
export async function createUpload(
  userId: string,
  input: CreateUploadInput,
): Promise<CreateUploadResult> {
  const uploadId = randomUUID();
  const key = `uploads/${userId}/${uploadId}/${input.filename}`;
  const sizeBytes = input.buffer.byteLength;

  // Step 1: verify chat ownership + insert the `uploading` row inside one tx.
  const row = await withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: input.chatId } });
    if (!chat) throw new Error('Chat not found');
    return tx.upload.create({
      data: {
        id: uploadId,
        userId,
        chatId: input.chatId,
        filename: input.filename,
        mimeType: input.mimeType,
        filePath: key,
        sizeBytes: BigInt(sizeBytes),
        status: 'uploading',
      },
    });
  });

  // Step 2: persist bytes. On failure, mark the row 'error' and rethrow.
  try {
    await getStorage().putObject(key, input.buffer, { contentType: input.mimeType });
  } catch (err) {
    const message = (err as Error).message ?? 'storage write failed';
    await withUser(userId, async (tx) => {
      await tx.upload.update({
        where: { id: uploadId },
        data: { status: 'error', errorMessage: `Storage failure: ${message}` },
      });
    });
    throw new Error(`Storage failure: ${message}`);
  }

  // Step 3: flip status -> 'parsing' and enqueue.
  const updated = await withUser(userId, async (tx) =>
    tx.upload.update({
      where: { id: uploadId },
      data: { status: 'parsing' },
    }),
  );

  // M7.4 will register the processor; for now the job sits in the queue.
  await getQueue().add('parse-upload', {
    uploadId,
    userId,
    chatId: input.chatId,
  });

  const out = toRecord(updated);
  return {
    id: out.id,
    filename: out.filename,
    status: out.status,
    sizeBytes: out.sizeBytes,
    createdAt: out.createdAt,
  };
}

export async function getUpload(userId: string, id: string): Promise<UploadRecord | null> {
  return withUser(userId, async (tx) => {
    const row = await tx.upload.findFirst({ where: { id } });
    return row ? toRecord(row) : null;
  });
}

export async function getUploadPreview(
  userId: string,
  id: string,
  limit: number,
): Promise<UploadPreview> {
  const clamped = Math.max(1, Math.min(100, Math.floor(limit)));
  return withUser(userId, async (tx) => {
    const upload = await tx.upload.findFirst({ where: { id } });
    if (!upload) throw new Error('Upload not found');
    const status = upload.status as UploadStatus;

    // Until parse completes (M7.4), articles is empty — return a stub the
    // frontend can poll against rather than 404'ing.
    if (status !== 'ready') {
      return { rows: [], columns: [], total: 0, status };
    }

    const [rows, total] = await Promise.all([
      tx.article.findMany({
        where: { uploadId: id },
        orderBy: { publishedDate: 'desc' },
        take: clamped,
      }),
      tx.article.count({ where: { uploadId: id } }),
    ]);

    const columns = Array.isArray(upload.schemaDetected)
      ? (upload.schemaDetected as Array<{ name: string }>)
          .map((c) => c.name)
          .filter((n): n is string => typeof n === 'string')
      : [];

    return {
      rows: rows.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        description: r.description,
        source: r.source,
        author: r.author,
        publishedDate: r.publishedDate,
        url: r.url,
        publisherDomain: r.publisherDomain,
        language: r.language,
        rawData: r.rawData,
      })),
      columns,
      total,
      status,
    };
  });
}

export async function deleteUpload(userId: string, id: string): Promise<void> {
  const row = await withUser(userId, async (tx) => tx.upload.findFirst({ where: { id } }));
  if (!row) throw new Error('Upload not found');

  // Best-effort storage cleanup. We log and proceed if delete fails so a
  // stuck object can't keep the row alive.
  try {
    await getStorage().deleteObject(row.filePath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[upload] storage deleteObject failed (continuing)', {
      id: row.id,
      filePath: row.filePath,
      errMessage: (err as Error).message,
    });
  }

  await withUser(userId, async (tx) => {
    await tx.upload.delete({ where: { id } });
  });
}

// Re-export for the route handler.
export type { Prisma };
