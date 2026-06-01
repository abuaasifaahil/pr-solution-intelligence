'use client';
import { useRef, type JSX } from 'react';
import type { AttachedSource } from './AttachedSourceChip';

/**
 * M9.8 — `[+ Source]` popover for the chat-creation form. Surfaces the
 * three data-source kinds defined in ADR-0001:
 *
 *   - csv_upload  → opens a file picker; the File is carried forward as
 *                   `pendingFile` and uploaded after chat creation
 *   - opensearch  → "Use platform default" (default OS index) — a more
 *                   complete OS-config UI ships in M9.9 (Settings)
 *   - crawler     → `[Coming soon]` per ADR-0001 §Migration plan. The
 *                   M9.6a adapter registry throws on `crawler`; we
 *                   surface the option (so it's discoverable) but
 *                   disable the click.
 *
 * @file components/home/AttachSourcePopover.tsx
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (source: AttachedSource) => void;
}

export function AttachSourcePopover({ open, onClose, onPick }: Props): JSX.Element | null {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    onPick({
      kind: 'csv_upload',
      label: file.name,
      pendingFile: file,
    });
    onClose();
  }

  function pickOpenSearch(): void {
    onPick({
      kind: 'opensearch',
      label: 'Platform default',
    });
    onClose();
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Attach a data source"
        data-testid="attach-source-popover"
        className="absolute z-50 mt-2 w-[360px]
                   bg-surface-card border border-border-default rounded-lg shadow-win-8 p-3"
      >
        <div className="flex items-center justify-between mb-2 px-1">
          <h3 className="text-sm font-semibold text-text-primary">Attach a data source</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close source picker"
            className="text-text-tertiary hover:text-text-primary text-sm"
          >
            ×
          </button>
        </div>

        <ul className="flex flex-col gap-1">
          {/* CSV — hidden file input triggered by the row click. */}
          <li>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              data-testid="source-pick-csv"
              className="w-full text-left px-2.5 py-2 rounded-md hover:bg-surface-hover
                         border border-transparent hover:border-border-subtle transition"
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true">📄</span>
                <span className="text-sm font-semibold text-text-primary">CSV upload</span>
              </div>
              <p className="text-xs text-text-secondary mt-0.5">
                Upload a press-clipping CSV (Phase 2 ingestion pipeline).
              </p>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvFile}
              className="hidden"
              aria-label="CSV file"
            />
          </li>

          {/* OpenSearch */}
          <li>
            <button
              type="button"
              onClick={pickOpenSearch}
              data-testid="source-pick-opensearch"
              className="w-full text-left px-2.5 py-2 rounded-md hover:bg-surface-hover
                         border border-transparent hover:border-border-subtle transition"
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true">🔎</span>
                <span className="text-sm font-semibold text-text-primary">OpenSearch</span>
              </div>
              <p className="text-xs text-text-secondary mt-0.5">
                Use the platform default cluster. Configure a per-user override in
                Settings → Data Sources (M9.9).
              </p>
            </button>
          </li>

          {/* Crawler — disabled per ADR-0001 (M9.6a registry throws). */}
          <li>
            <div
              data-testid="source-pick-crawler-disabled"
              aria-disabled="true"
              className="w-full text-left px-2.5 py-2 rounded-md
                         border border-transparent opacity-50 cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true">🕸️</span>
                <span className="text-sm font-semibold text-text-primary">Crawl</span>
                <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-surface-tertiary text-text-tertiary">
                  Coming soon
                </span>
              </div>
              <p className="text-xs text-text-secondary mt-0.5">
                Web-crawl ingestion ships when the adapter registry adds the crawler
                kind (post-M9.11).
              </p>
            </div>
          </li>
        </ul>
      </div>
    </>
  );
}
