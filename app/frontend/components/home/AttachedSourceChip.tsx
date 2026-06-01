'use client';
import type { JSX } from 'react';

/**
 * M9.8 — small inline chip surfaced under the chat-creation form when
 * the user has attached one or more data sources. The × clears the
 * attachment. Backend doesn't yet persist multi-source attachments
 * (that's M9.11); for M9.8 we just carry the intent forward in the
 * URL via `buildChatUrl()`.
 *
 * @file components/home/AttachedSourceChip.tsx
 */

export interface AttachedSource {
  kind: 'csv_upload' | 'opensearch' | 'crawler';
  /** Display label — usually the file name (csv) or the OS index name. */
  label: string;
  /** Optional reference id (upload id, override id). Encoded into the
   *  chat URL by `buildChatUrl()`. */
  ref?: string;
  /** For CSV: the file selected by the user. Pre-upload — the actual
   *  upload happens after chat creation. Not persisted in URL. */
  pendingFile?: File;
}

const KIND_ICON: Record<AttachedSource['kind'], string> = {
  csv_upload: '📄',
  opensearch: '🔎',
  crawler: '🕸️',
};

const KIND_LABEL: Record<AttachedSource['kind'], string> = {
  csv_upload: 'CSV',
  opensearch: 'OpenSearch',
  crawler: 'Crawl',
};

interface Props {
  source: AttachedSource;
  onRemove: () => void;
}

export function AttachedSourceChip({ source, onRemove }: Props): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                 bg-status-info-bg text-status-info-text border border-status-info-border"
      data-testid={`attached-source-${source.kind}`}
    >
      <span aria-hidden="true">{KIND_ICON[source.kind]}</span>
      <span>
        {KIND_LABEL[source.kind]}: {source.label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${KIND_LABEL[source.kind]} source`}
        className="text-status-info-text/70 hover:text-status-error-text ml-0.5"
      >
        ×
      </button>
    </span>
  );
}
