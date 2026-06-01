'use client';

import type { JSX } from 'react';

/**
 * Phase 3 — Sub-card surfacing SimilarWebAgent's progress (M8.8).
 *
 * Only rendered when the chat's enrichmentType is 'reach'. The teal accent
 * is the deliberate visual cue that this is the SimilarWeb side of the
 * pipeline, distinct from the blue LLM-enrichment surface above.
 *
 * @file components/chat/ReachAgentCard.tsx
 */

export type ReachCardState = 'idle' | 'fetching' | 'done' | 'failed';

interface Props {
  state: ReachCardState;
  coverage: { resolved: number; total: number; percent: number } | null;
}

const LABELS: Record<ReachCardState, string> = {
  idle: 'Similar Web Agent — queued',
  fetching: 'Similar Web Agent — fetching domain reach',
  done: 'Similar Web Agent — complete',
  failed: 'Similar Web Agent — failed',
};

const DOT_COLOR: Record<ReachCardState, string> = {
  idle: 'bg-border-default',
  fetching: 'bg-win-teal animate-pulse',
  done: 'bg-status-success-text',
  failed: 'bg-status-error-text',
};

export function ReachAgentCard({ state, coverage }: Props): JSX.Element {
  return (
    <div
      data-testid="reach-agent-card"
      data-state={state}
      className={[
        'rounded-md p-3',
        'border border-win-teal/30 bg-win-teal/5',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={['w-2 h-2 rounded-full', DOT_COLOR[state]].join(' ')}
        />
        <span className="text-sm text-text-primary font-medium">
          {LABELS[state]}
        </span>
      </div>
      {coverage && (
        <div className="text-xs text-text-secondary mt-1.5 font-mono tabular-nums">
          {coverage.resolved} / {coverage.total} domains · {coverage.percent}% coverage
        </div>
      )}
    </div>
  );
}
