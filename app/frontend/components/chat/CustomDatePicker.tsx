'use client';

import { useState, type FormEvent, type JSX } from 'react';

/**
 * Phase 2 — Custom date range picker.
 *
 * Renders a pair of `<input type="date">` fields and submits both as Date
 * objects when the user confirms. Used for the "custom" branch of the
 * `collect_dates` step; the four preset options (weekly / 10 / 20 / custom)
 * are handled by ChatActionPrompt in FlowStepPrompt.
 *
 * @file components/chat/CustomDatePicker.tsx
 */

interface Props {
  defaultStart?: Date | null;
  defaultEnd?: Date | null;
  onSubmit: (start: Date, end: Date) => void;
  onCancel?: () => void;
}

function toIsoDate(d: Date | null | undefined): string {
  if (!d) return '';
  // YYYY-MM-DD for <input type=date>.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function CustomDatePicker({
  defaultStart,
  defaultEnd,
  onSubmit,
  onCancel,
}: Props): JSX.Element {
  const [start, setStart] = useState(toIsoDate(defaultStart));
  const [end, setEnd] = useState(toIsoDate(defaultEnd));
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!start || !end) {
      setError('Pick both a start and end date.');
      return;
    }
    const s = new Date(`${start}T00:00:00`);
    const ee = new Date(`${end}T23:59:59`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(ee.getTime())) {
      setError('Invalid date.');
      return;
    }
    if (s > ee) {
      setError('Start must be before end.');
      return;
    }
    setError(null);
    onSubmit(s, ee);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={[
        'flex flex-col font-mono text-sm w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      aria-label="Custom date range"
    >
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle">
        Pick a custom date range
      </div>
      <div className="px-3 py-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          Start
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-label="Start date"
            className={[
              'font-mono text-sm bg-surface-base px-2 py-1 rounded-sm',
              'border border-border-default',
              'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
            ].join(' ')}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          End
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="End date"
            className={[
              'font-mono text-sm bg-surface-base px-2 py-1 rounded-sm',
              'border border-border-default',
              'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
            ].join(' ')}
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="px-4 pb-2 text-status-error-text text-xs">
          {error}
        </div>
      )}
      <div className="px-3 py-3 flex justify-end gap-2 border-t border-border-subtle">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 text-xs font-sans text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className={[
            'px-3 py-1.5 text-xs rounded-sm font-sans',
            'bg-win-blue-500 text-text-inverse',
            'hover:bg-win-blue-600',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:ring-offset-1',
          ].join(' ')}
        >
          Apply range
        </button>
      </div>
    </form>
  );
}
