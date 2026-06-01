'use client';
import { useState, useRef, type ReactNode, type KeyboardEvent } from 'react';

/**
 * Phase 2 — Drag-and-drop file picker for the chat thread.
 *
 *   - Accepts CSV / JSON / NDJSON / text-plain-named-as-.csv (mirrors backend)
 *   - Client-side max-size guard at 50 MB (backend enforces the hard limit
 *     and may still reject anything that slips through, e.g. via paste).
 *   - Clicking the zone opens a native file picker.
 *
 * The component is purely presentational — it does NOT initiate the upload
 * itself. Wiring to `lib/uploads.createUpload(...)` happens in the page.
 */

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Optional override for the default body copy. */
  children?: ReactNode;
}

export const ALLOWED_MIME = [
  'text/csv',
  'application/json',
  'application/x-ndjson',
  'text/plain',
];

export const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

function isAllowedFile(file: File): boolean {
  if (file.type && ALLOWED_MIME.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.json') || name.endsWith('.ndjson');
}

function validate(file: File): string | null {
  if (!isAllowedFile(file)) return 'Only CSV or JSON files are supported.';
  if (file.size > MAX_SIZE) return 'File too large — max 50 MB.';
  return null;
}

export function FileDropZone({ onFile, disabled, children }: Props) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File): void {
    const err = validate(file);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    onFile(file);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (disabled) return;
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      }}
      onClick={() => {
        if (!disabled) inputRef.current?.click();
      }}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Upload a CSV or JSON file"
      aria-disabled={disabled || undefined}
      data-active={active || undefined}
      className={[
        'border-2 border-dashed rounded-md p-8 text-center transition outline-none',
        'focus-visible:ring-2 focus-visible:ring-win-blue-500 focus-visible:ring-offset-2',
        active
          ? 'border-win-blue-500 bg-win-blue-50'
          : 'border-border-default bg-surface-card',
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-pointer hover:border-win-blue-500',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.json,.ndjson,application/json,text/csv"
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Reset so re-picking the same file fires onChange again.
          e.target.value = '';
        }}
      />
      {children ?? (
        <>
          <div className="text-text-secondary text-sm">Drop your data file here</div>
          <div className="text-text-tertiary text-xs mt-1">
            or click to browse · CSV or JSON · ≤50 MB
          </div>
        </>
      )}
      {error && (
        <div role="alert" className="mt-2 text-status-error-text text-xs">
          {error}
        </div>
      )}
    </div>
  );
}
