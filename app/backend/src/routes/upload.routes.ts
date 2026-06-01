import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createUpload,
  getUpload,
  getUploadPreview,
  deleteUpload,
  isAllowedMime,
  ALLOWED_MIME_TYPES,
} from '../services/upload.service.js';

/**
 * Phase 2 upload REST endpoints — M7.3.
 *
 *   POST   /api/v1/uploads               multipart {file, chatId}; ≤50 MB
 *   GET    /api/v1/uploads/:id           status + schema + dateRange + rowCount
 *   GET    /api/v1/uploads/:id/preview   first N parsed rows
 *   DELETE /api/v1/uploads/:id           cleanup row + storage object
 *
 * All endpoints are guarded by `app.auth`. Owning-user enforcement happens
 * inside the service via `withUser(...)` (RLS).
 */

const PreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/v1/uploads ──────────────────────────────────────────────
  app.post('/api/v1/uploads', { preHandler: app.auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isMultipart()) {
      reply.code(400);
      return { success: false, error: 'multipart/form-data required' };
    }

    // Drain the multipart stream. `parts()` interleaves files and fields in
    // the order they appear; we capture both into local state.
    let fileBuffer: Buffer | undefined;
    let filename = '';
    let mimeType = '';
    let chatId = '';

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          if (fileBuffer) {
            // limits.files=1 should prevent this, but be defensive.
            reply.code(400);
            return { success: false, error: 'Only one file is allowed per upload' };
          }
          // Stream-buffer up to the 50 MB cap. @fastify/multipart emits a
          // `truncated` flag on the file stream once the cap is hit; we
          // bail with 413 in that case.
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of part.file) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.byteLength;
            chunks.push(buf);
          }
          if (part.file.truncated) {
            reply.code(413);
            return { success: false, error: 'File exceeds 50 MB limit' };
          }
          fileBuffer = Buffer.concat(chunks, total);
          filename = part.filename;
          mimeType = part.mimetype;
        } else {
          // field
          if (part.fieldname === 'chatId' && typeof part.value === 'string') {
            chatId = part.value;
          }
        }
      }
    } catch (err) {
      // @fastify/multipart raises a `RequestFileTooLargeError` with code
      // 'FST_REQ_FILE_TOO_LARGE' when the body exceeds limits.fileSize.
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.code(413);
        return { success: false, error: 'File exceeds 50 MB limit' };
      }
      req.log.error({ err }, 'multipart parse failure');
      reply.code(400);
      return { success: false, error: 'Invalid multipart payload' };
    }

    if (!fileBuffer || !filename) {
      reply.code(400);
      return { success: false, error: 'Missing "file" field' };
    }
    if (!chatId || !UUID_RE.test(chatId)) {
      reply.code(400);
      return { success: false, error: 'Missing or invalid "chatId" field' };
    }
    if (!isAllowedMime(mimeType, filename)) {
      reply.code(415);
      return {
        success: false,
        error: `Unsupported MIME type "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')} (or text/plain for .csv).`,
      };
    }
    // CSVs uploaded as text/plain — accept but log so we can spot broken clients.
    if (mimeType === 'text/plain') {
      req.log.warn(
        { filename, mimeType },
        'accepting upload with text/plain MIME based on .csv extension',
      );
    }

    try {
      const upload = await createUpload(req.user!.userId, {
        chatId,
        filename,
        mimeType,
        buffer: fileBuffer,
      });
      return { success: true, data: { upload } };
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Chat not found') {
        reply.code(404);
        return { success: false, error: 'Chat not found' };
      }
      if (message.startsWith('Storage failure')) {
        reply.code(500);
        return { success: false, error: message };
      }
      req.log.error({ err }, 'createUpload failed');
      reply.code(500);
      return { success: false, error: 'Upload failed' };
    }
  });

  // ─── GET /api/v1/uploads/:id ───────────────────────────────────────────
  app.get('/api/v1/uploads/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const upload = await getUpload(req.user!.userId, id);
    if (!upload) {
      reply.code(404);
      return { success: false, error: 'Upload not found' };
    }
    return { success: true, data: { upload } };
  });

  // ─── GET /api/v1/uploads/:id/preview?limit=10 ─────────────────────────
  app.get('/api/v1/uploads/:id/preview', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PreviewQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid query', meta: parsed.error.flatten() };
    }
    try {
      const preview = await getUploadPreview(req.user!.userId, id, parsed.data.limit);
      return { success: true, data: preview };
    } catch (err) {
      if ((err as Error).message === 'Upload not found') {
        reply.code(404);
        return { success: false, error: 'Upload not found' };
      }
      throw err;
    }
  });

  // ─── DELETE /api/v1/uploads/:id ────────────────────────────────────────
  app.delete('/api/v1/uploads/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteUpload(req.user!.userId, id);
      return { success: true, data: { message: 'Deleted' } };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });
}
