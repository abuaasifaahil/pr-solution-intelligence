'use client';

import type { JSX } from 'react';
import type { EnrichmentBatchView } from '../../lib/enrichment';

/**
 * Phase 3 — Per-batch status grid (M8.8).
 *
 * Renders one square tile per batch. Each tile carries its batch number,
 * status color, and an in-browser title-tooltip with either the error (on
 * failure) or `{status} · {duration}ms` (otherwise). Tiles are intentionally
 * dumb DOM — no popovers, no menus — so the component stays cheap as the
 * grid re-renders on every batch event.
 *
 * @file components/chat/BatchGrid.tsx
 */

const STATUS_COLOR: Record<EnrichmentBatchView['status'], string> = {
  pending: 'bg-surface-base text-text-tertiary border border-border-default',
  processing: 'bg-status-info-bg text-status-info-text animate-pulse',
  retrying: 'bg-status-warn-bg text-status-warn-text',
  completed: 'bg-status-success-bg text-status-success-text',
  failed: 'bg-status-error-bg text-status-error-text',
};

interface Props {
  batches: EnrichmentBatchView[];
}

export function BatchGrid({ batches }: Props): JSX.Element {
  const completed = batches.filter((b) => b.status === 'completed').length;
  const failed = batches.filter((b) => b.status === 'failed').length;
  return (
    <div data-testid="batch-grid" className="flex flex-col gap-1.5">
      <div className="text-xs text-text-tertiary font-mono">
        Batches ({completed} / {batches.length} completed
        {failed > 0 ? ` · ${failed} failed` : ''})
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-12 gap-1">
        {batches.map((b) => (
          <div
            key={b.batchNumber}
            title={
              b.error
                ? `Batch ${b.batchNumber}: ${b.error}`
                : `Batch ${b.batchNumber}: ${b.status}${
                    b.processingMs != null ? ` · ${b.processingMs}ms` : ''
                  }${b.retryCount > 0 ? ` · retry ${b.retryCount}` : ''}`
            }
            data-batch-number={b.batchNumber}
            data-status={b.status}
            className={[
              'aspect-square rounded text-xs font-mono',
              'flex items-center justify-center cursor-default tabular-nums',
              STATUS_COLOR[b.status],
            ].join(' ')}
          >
            {b.batchNumber}
          </div>
        ))}
      </div>
    </div>
  );
}
