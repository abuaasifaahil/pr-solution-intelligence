'use client';

/**
 * Phase 2 — Top-of-chat 9-dot progress indicator.
 *
 * Each dot represents one state in the conversational flow (M7.5). For
 * M7.8 the page just keeps the state at 'init'; M7.9 will hook it up to
 * the `flow:state-change` WS event.
 *
 * The string-union here mirrors `@prsi/shared/types/phase2`
 * `FlowStateLiteral`, kept locally so the frontend doesn't need to import
 * `@prisma/client` indirectly.
 */

export type FlowStateLiteral =
  | 'init'
  | 'collect_dates'
  | 'collect_enrichment'
  | 'collect_brand'
  | 'collect_competitors'
  | 'collect_intention'
  | 'generate_query'
  | 'processing'
  | 'complete';

const STATES: FlowStateLiteral[] = [
  'init',
  'collect_dates',
  'collect_enrichment',
  'collect_brand',
  'collect_competitors',
  'collect_intention',
  'generate_query',
  'processing',
  'complete',
];

const LABELS: Record<FlowStateLiteral, string> = {
  init: 'Start',
  collect_dates: 'Dates',
  collect_enrichment: 'Enrichment',
  collect_brand: 'Brand',
  collect_competitors: 'Competitors',
  collect_intention: 'Intention',
  generate_query: 'Query',
  processing: 'Process',
  complete: 'Done',
};

interface Props {
  currentState: FlowStateLiteral;
}

export function FlowDotIndicator({ currentState }: Props) {
  const currentIdx = STATES.indexOf(currentState);

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-border-subtle bg-surface-card">
      {STATES.map((s, i) => {
        const status: 'done' | 'active' | 'pending' =
          i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending';
        return (
          <div key={s} className="flex items-center gap-1" title={LABELS[s]}>
            <span
              className={[
                'w-2 h-2 rounded-full transition-colors',
                status === 'done'
                  ? 'bg-win-blue-500'
                  : status === 'active'
                    ? 'bg-win-blue-500 animate-pulse'
                    : 'bg-border-default',
              ].join(' ')}
              aria-label={`${LABELS[s]} ${status}`}
              data-state={status}
            />
            {i < STATES.length - 1 && (
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
      <span className="ml-3 text-text-tertiary text-xs">{LABELS[currentState] ?? '—'}</span>
    </div>
  );
}
