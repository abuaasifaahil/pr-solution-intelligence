/**
 * BullMQ processor for `parse-upload` jobs — M7.4.
 *
 * Pipeline:
 *   1. Read uploads row (status is already 'parsing' from M7.3)
 *   2. Download file from storage
 *   3. Parse via PapaParse (CSV) or JSON.parse (JSON)
 *   4. Detect schema + date column + date range
 *   5. Normalize each row via ArticleNormalizer
 *   6. Bulk insert into articles (createMany, batches of 500)
 *   7. Update uploads row: status='ready', rowCount, columnCount,
 *      schemaDetected, dateColumn, dateRangeStart/End, parsedAt
 *   8. Emit upload:parsed WS event via the existing event-bus
 *
 * Errors during any step → update uploads.status='error' + errorMessage,
 * emit upload:error WS event, and rethrow so BullMQ marks the job failed
 * (retry policy is configured at queue-add time).
 */
import type { Processor } from 'bullmq';
import Papa from 'papaparse';
import { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { getStorage } from '../lib/storage.js';
import { publishChatEvent } from '../lib/event-bus.js';
import {
  detectDateColumn,
  detectSchema,
  normalize,
  type NormalizedArticle,
} from '../lib/article-normalizer.js';

/** Coerce an arbitrary value into Prisma's JSON input shape. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export interface ParseUploadJobData {
  uploadId: string;
  userId: string;
  chatId: string;
}

/**
 * Read the entire stream into a UTF-8 string. Acceptable for ≤50 MB; the
 * REST route already caps file size at 50 MB.
 */
async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseCsv(text: string): Record<string, unknown>[] {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // keep strings; ArticleNormalizer coerces
  });
  return result.data;
}

function parseJson(text: string): Record<string, unknown>[] {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if ('articles' in obj && Array.isArray(obj.articles)) {
      return obj.articles as Record<string, unknown>[];
    }
    // Treat a single object as a one-row dataset (some upload patterns).
    return [obj];
  }
  return [];
}

/**
 * Constant used for batch-size in bulk insert. 500 keeps each createMany
 * payload well below Postgres' parameter limit (≈32k) while still
 * amortising round-trip cost across the file.
 */
const BATCH_SIZE = 500;

export const parseUploadProcessor: Processor<ParseUploadJobData> = async (job) => {
  const { uploadId, userId, chatId } = job.data;

  try {
    // ─── 1. Read upload row ───────────────────────────────────────────────
    const upload = await withUser(userId, async (tx) =>
      tx.upload.findFirst({ where: { id: uploadId } }),
    );
    if (!upload) throw new Error(`upload ${uploadId} not found (or not owned)`);

    // ─── 2. Download bytes ────────────────────────────────────────────────
    const stream = await getStorage().getObject(upload.filePath);
    const text = await readStreamToString(stream);

    // ─── 3. Parse ─────────────────────────────────────────────────────────
    const rows = upload.mimeType.includes('json') ? parseJson(text) : parseCsv(text);
    if (rows.length === 0) {
      throw new Error('parse yielded 0 rows');
    }

    // ─── 4. Detect schema + date column + date range ──────────────────────
    const firstRow = rows[0];
    if (!firstRow) throw new Error('parse yielded 0 rows');
    const columns = Object.keys(firstRow);
    const schema = detectSchema(rows);
    const dateColumn = detectDateColumn(columns);

    let dateRangeStart: Date | null = null;
    let dateRangeEnd: Date | null = null;
    if (dateColumn) {
      const dates: Date[] = [];
      for (const row of rows) {
        const raw = row[dateColumn];
        if (raw == null) continue;
        const d = new Date(String(raw));
        if (!Number.isNaN(d.getTime())) dates.push(d);
      }
      if (dates.length > 0) {
        const times = dates.map((d) => d.getTime());
        dateRangeStart = new Date(Math.min(...times));
        dateRangeEnd = new Date(Math.max(...times));
      }
    }

    // ─── 5. Normalize each row ────────────────────────────────────────────
    const normalized: NormalizedArticle[] = rows.map((r) => normalize(r));

    // ─── 6 + 7. Bulk insert articles + update upload row ──────────────────
    await withUser(userId, async (tx) => {
      for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
        const slice = normalized.slice(i, i + BATCH_SIZE);
        await tx.article.createMany({
          data: slice.map((a) => ({
            uploadId,
            chatId,
            userId,
            title: a.title,
            content: a.content,
            description: a.description,
            source: a.source,
            author: a.author,
            publishedDate: a.publishedDate,
            url: a.url,
            publisherDomain: a.publisherDomain,
            language: a.language,
            rawData: toJson(a.rawData),
          })),
          skipDuplicates: true,
        });
      }

      await tx.upload.update({
        where: { id: uploadId },
        data: {
          status: 'ready',
          rowCount: normalized.length,
          columnCount: columns.length,
          schemaDetected: toJson(schema),
          dateColumn,
          dateRangeStart,
          dateRangeEnd,
          parsedAt: new Date(),
        },
      });
    });

    // ─── 8. Emit upload:parsed WS event ───────────────────────────────────
    await publishChatEvent(chatId, 'upload:parsed', {
      uploadId,
      rowCount: normalized.length,
      columns,
      dateRange:
        dateRangeStart && dateRangeEnd
          ? { start: dateRangeStart.toISOString(), end: dateRangeEnd.toISOString() }
          : null,
      schema,
    });

    return { uploadId, rowCount: normalized.length };
  } catch (err) {
    const message = (err as Error).message ?? 'parse failed';
    // Best-effort row update + WS error event. We rethrow so BullMQ marks
    // the job failed (allowing retry per queue config).
    try {
      await withUser(userId, async (tx) => {
        await tx.upload.update({
          where: { id: uploadId },
          data: { status: 'error', errorMessage: message.slice(0, 1000) },
        });
      });
      await publishChatEvent(chatId, 'upload:error', { uploadId, error: message });
    } catch {
      /* swallow secondary errors so the original failure is preserved */
    }
    throw err;
  }
};
