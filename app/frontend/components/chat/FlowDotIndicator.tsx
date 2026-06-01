'use client';

/**
 * Phase 2 — Top-of-chat 9-dot progress indicator.
 *
 * Each dot represents one state in the conversational flow (M7.5). M7.9
 * promoted the literal union + labels into `lib/flow-states.ts`; this
 * component is now a thin presentational shell over that source of truth.
 *
 * `FlowStateLiteral` is re-exported for back-compat — existing callers that
 * imported it from this module keep working, but new code should import
 * from `lib/flow-states` directly.
 */

import {
  FLOW_STATES,
  STATE_LABELS,
  type FlowStateLiteral,
} from '../../lib/flow-states';

export type { FlowStateLiteral };

interface Props {
  currentState: FlowStateLiteral;
}

export function FlowDotIndicator({ currentState }: Props) {
  const currentIdx = FLOW_STATES.indexOf(currentState);

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-border-subtle bg-surface-card">
      {FLOW_STATES.map((s, i) => {
        const status: 'done' | 'active' | 'pending' =
          i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending';
        return (
          <div key={s} className="flex items-center gap-1" title={STATE_LABELS[s]}>
            <span
              className={[
                'w-2 h-2 rounded-full transition-colors',
                status === 'done'
                  ? 'bg-win-blue-500'
                  : status === 'active'
                    ? 'bg-win-blue-500 animate-pulse'
                    : 'bg-border-default',
              ].join(' ')}
              aria-label={`${STATE_LABELS[s]} ${status}`}
              data-state={status}
            />
            {i < FLOW_STATES.length - 1 && (
              <span
                aria-hidden
                className={[
                  'w-3 h-px',
                  status === 'done' ? 'bg-win-blue-500' : 'bg-border-default',
                ].join(' ')}
              />
            )}
          </div>
        );
      })}
      <span className="ml-3 text-text-tertiary text-xs">{STATE_LABELS[currentState] ?? '—'}</span>
    </div>
  );
}
