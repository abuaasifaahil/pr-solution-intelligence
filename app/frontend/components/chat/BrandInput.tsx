'use client';

import { useState, type FormEvent, type JSX } from 'react';

/**
 * Phase 2 — Brand input.
 *
 * Single-line text entry for the `collect_brand` step. Submits on Enter or
 * via the inline button. Empty submissions are blocked so the backend never
 * sees an empty brand string. Long names are visually truncated but kept
 * intact in the form state.
 *
 * @file components/chat/BrandInput.tsx
 */

interface Props {
  /** Pre-fill — used when the chat reloads with a brand already saved. */
  defaultValue?: string;
  /** Called with the trimmed value. The caller decides whether to PATCH. */
  onSubmit: (brand: string) => void;
  /** Optional: render the input as read-only after submit. */
  readOnly?: boolean;
}

export function BrandInput({ defaultValue, onSubmit, readOnly }: Props): JSX.Element {
  const [value, setValue] = useState(defaultValue ?? '');
  const trimmed = value.trim();
  const canSubmit = !readOnly && trimmed.length > 0;

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={[
        'flex flex-col font-mono text-sm w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      aria-label="Brand name input"
    >
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle">
        Which brand should I focus on?
      </div>
      <div className="px-3 py-3 flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. Acme Corp"
          readOnly={readOnly}
          maxLength={255}
          aria-label="Brand name"
          className={[
            'flex-1 font-mono text-sm bg-surface-base px-2 py-1.5 rounded-sm',
            'border border-border-default',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
            readOnly ? 'cursor-not-allowed opacity-60' : '',
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
          Continue
        </button>
      </div>
      <div className="px-4 pb-2 text-text-tertiary text-xs">
        Press <kbd className="text-text-secondary">enter</kbd> to submit
      </div>
    </form>
  );
}
