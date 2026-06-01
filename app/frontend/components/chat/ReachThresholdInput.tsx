'use client';

import { useState, type FormEvent, type JSX } from 'react';

/**
 * Phase 2 — Reach-threshold numeric input.
 *
 * Used in the enrichment branch when the user picks "reach" — they need to
 * supply a minimum reach value (positive integer). The picker is wrapped
 * the same way as BrandInput / CompetitorTags for visual consistency.
 *
 * @file components/chat/ReachThresholdInput.tsx
 */

interface Props {
  defaultValue?: number | null;
  onSubmit: (threshold: number) => void;
}

export function ReachThresholdInput({ defaultValue, onSubmit }: Props): JSX.Element {
  const [raw, setRaw] = useState<string>(
    defaultValue != null ? String(defaultValue) : '',
  );
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      setError('Threshold must be a positive integer.');
      return;
    }
    setError(null);
    onSubmit(n);
  }

  const trimmed = raw.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className={[
        'flex flex-col font-mono text-sm w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      aria-label="Reach threshold"
    >
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle">
        Minimum reach threshold
      </div>
      <div className="px-3 py-3 flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="e.g. 10000"
          aria-label="Reach threshold"
          className={[
            'flex-1 font-mono text-sm bg-surface-base px-2 py-1.5 rounded-sm',
            'border border-border-default',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
          ].join(' ')}
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className={[
            'px-3 py-1.5 text-xs rounded-sm font-sans',
            'bg-win-blue-500 text-text-inverse',
            'hover:bg-win-blue-600',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:ring-offset-1',
          ].join(' ')}
        >
          Apply
        </button>
      </div>
      {error && (
        <div role="alert" className="px-4 pb-2 text-status-error-text text-xs">
          {error}
        </div>
      )}
    </form>
  );
}
