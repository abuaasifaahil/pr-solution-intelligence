'use client';
import type { UploadStatus } from '../../lib/uploads';

/**
 * Phase 2 — Upload progress / metadata card.
 *
 *   uploading / parsing → animated progress bar (percent from WS or
 *                         indeterminate fallback)
 *   ready               → metadata grid (rows / columns / date range)
 *   error               → red error text
 */

interface Props {
  upload: UploadStatus;
  /** 0-100, optional. Filled by WS `upload:progress` events. */
  progressPercent?: number;
  onRemove?: () => void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusPillClass(status: UploadStatus['status']): string {
  if (status === 'ready') return 'bg-status-success-bg text-status-success-text';
  if (status === 'error') return 'bg-status-error-bg text-status-error-text';
  return 'bg-status-info-bg text-status-info-text';
}

export function UploadProgressCard({ upload, progressPercent, onRemove }: Props) {
  const isFinal = upload.status === 'ready' || upload.status === 'error';
  const pct =
    upload.status === 'ready'
      ? 100
      : progressPercent != null
        ? Math.max(0, Math.min(100, progressPercent))
        : null;

  // sizeBytes can come back as a BigInt-serialized string from the API.
  const sizeNum = typeof upload.sizeBytes === 'string'
    ? Number(upload.sizeBytes)
    : upload.sizeBytes;

  return (
    <div
      className="border border-border-default rounded-md bg-surface-card p-3 max-w-2xl"
      data-status={upload.status}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="text-2xl">📄</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-text-primary truncate">{upload.filename}</div>
          <div className="text-text-tertiary text-xs">{formatSize(sizeNum)}</div>
        </div>
        <span
          className={[
            'text-xs px-2 py-0.5 rounded-full',
            statusPillClass(upload.status),
          ].join(' ')}
        >
          {upload.status}
        </span>
        {onRemove && upload.status !== 'parsing' && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove upload"
            className="text-text-tertiary text-xs hover:text-status-error-text"
          >
            ×
          </button>
        )}
      </div>

      {!isFinal && (
        <div
          className="mt-3 h-1.5 rounded-full bg-surface-base overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct == null ? upload.status : `${pct}%`}
        >
          <div
            className={[
              'h-full bg-win-blue-500 transition-all',
              pct == null ? 'animate-pulse' : '',
            ].join(' ')}
            style={{ width: pct != null ? `${pct}%` : '40%' }}
          />
        </div>
      )}

      {upload.status === 'ready' && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-text-secondary">
          <div>
            Rows:{' '}
            <span className="text-text-primary font-medium">
              {upload.rowCount?.toLocaleString() ?? '—'}
            </span>
          </div>
          <div>
            Columns:{' '}
            <span className="text-text-primary font-medium">
              {upload.columnCount ?? '—'}
            </span>
          </div>
          {upload.dateRangeStart && upload.dateRangeEnd && (
            <div className="col-span-2">
              Date range:{' '}
              <span className="text-text-primary font-medium">
                {upload.dateRangeStart.slice(0, 10)} → {upload.dateRangeEnd.slice(0, 10)}
              </span>
            </div>
          )}
          {upload.schemaDetected?.length > 0 && (
            <div className="col-span-2 text-text-tertiary">
              Schema: {upload.schemaDetected.length} field
              {upload.schemaDetected.length === 1 ? '' : 's'} detected
            </div>
          )}
        </div>
      )}

      {upload.status === 'error' && upload.errorMessage && (
        <div role="alert" className="mt-3 text-status-error-text text-xs">
          {upload.errorMessage}
        </div>
      )}
    </div>
  );
}
