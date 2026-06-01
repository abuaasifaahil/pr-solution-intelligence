'use client';

import { useState, type JSX } from 'react';

/**
 * Generic agent-completion summary card.
 *
 * Used as the "after" view inside AgentActionPanel — once a run finishes,
 * the panel swaps from ProcessingSteps to this summary. Renders a
 * stat grid plus a chevron toggle that collapses to a one-line summary
 * (`summaryText`) so the transcript stays compact when the user scrolls back.
 *
 * NOT hardcoded to Phase 2 — callers provide their own agentName + stats.
 *
 * @file components/chat/CompletionSummary.tsx
 */

interface Props {
  agentName: string;
  stats: Record<string, string | number>;
  defaultOpen?: boolean;
  /** One-line summary shown while collapsed. Falls back to a join of stats. */
  summaryText?: string;
}

export function CompletionSummary({
  agentName,
  stats,
  defaultOpen = true,
  summaryText,
}: Props): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const entries = Object.entries(stats);
  const fallbackSummary = entries.map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ');

  return (
    <div
      className={[
        'flex flex-col w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      data-testid="completion-summary"
      data-open={open}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`agent-summary-body-${agentName.replace(/\s+/g, '-')}`}
        className={[
          'flex items-center justify-between gap-3 px-4 py-2.5',
          'text-left border-b border-border-subtle',
          'hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:ring-inset',
        ].join(' ')}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={[
              'inline-flex h-5 w-5 items-center justify-center rounded-full',
              'bg-status-success-bg text-status-success-text',
            ].join(' ')}
          >
            ✓
          </span>
          <span className="text-text-primary font-medium">
            {agentName} — complete
          </span>
        </span>
        <span className="flex items-center gap-2 text-text-tertiary text-xs">
          {!open && (
            <span aria-label="summary">
              {summaryText ?? fallbackSummary}
            </span>
          )}
          <span aria-hidden className="transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
            ▾
          </span>
        </span>
      </button>

      {open && (
        <div
          id={`agent-summary-body-${agentName.replace(/\s+/g, '-')}`}
          className="px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-3"
        >
          {entries.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <span className="text-text-tertiary text-xs uppercase tracking-wide">{k}</span>
              <span className="text-text-primary text-sm font-medium tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
