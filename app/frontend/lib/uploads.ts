'use client';
import { apiFetch } from './api-client';

/**
 * Phase 2 — Frontend typed client for the upload REST endpoints (M7.3).
 *
 *   POST   /api/v1/uploads               multipart {file, chatId}
 *   GET    /api/v1/uploads/:id           full status row
 *   GET    /api/v1/uploads/:id/preview   first N parsed rows
 *   DELETE /api/v1/uploads/:id           cleanup
 *
 * Mirrors `lib/chats.ts` style — apiFetch unwraps the success envelope and
 * surfaces errors as `ApiError`. For multipart we deliberately DO NOT set
 * `content-type`; the browser fills in the boundary itself (see api-client.ts).
 */

export type UploadStatusValue = 'uploading' | 'parsing' | 'ready' | 'error';

export interface UploadSchemaField {
  name: string;
  type: string;
  sample: unknown;
}

export interface UploadStatus {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | string;
  rowCount: number | null;
  columnCount: number | null;
  schemaDetected: UploadSchemaField[];
  dateColumn: string | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  status: UploadStatusValue;
  errorMessage: string | null;
  parsedAt: string | null;
  createdAt: string;
}

export interface UploadPreview {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  status?: string;
}

export async function createUpload(
  file: File,
  chatId: string,
): Promise<{ upload: UploadStatus }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('chatId', chatId);
  // Don't set content-type — the browser fills in the multipart boundary.
  return apiFetch<{ upload: UploadStatus }>('/api/v1/uploads', {
    method: 'POST',
    body: fd,
  });
}

export async function getUpload(id: string): Promise<{ upload: UploadStatus }> {
  return apiFetch<{ upload: UploadStatus }>(`/api/v1/uploads/${encodeURIComponent(id)}`);
}

export async function getUploadPreview(
  id: string,
  limit = 10,
): Promise<UploadPreview> {
  return apiFetch<UploadPreview>(
    `/api/v1/uploads/${encodeURIComponent(id)}/preview?limit=${limit}`,
  );
}

export async function deleteUpload(id: string): Promise<void> {
  await apiFetch(`/api/v1/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
