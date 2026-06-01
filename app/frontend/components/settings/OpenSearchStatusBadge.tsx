'use client';

/**
 * M9.9 (Phase 3.5) — chip-style status indicator for the
 * OpenSearchOverridePanel.
 *
 * Three visual states:
 *  - "org-default" — green chip, "Using organization OpenSearch"
 *  - "override"    — blue chip,  "Using your override"
 *  - "unconfigured" — grey chip, "OpenSearch is not configured"
 *
 * Renders as a small pill aligned inline with the panel title.
 *
 * @file components/settings/OpenSearchStatusBadge.tsx
 */
export type OpenSearchStatus = 'org-default' | 'override' | 'unconfigured';

const STATUS_STYLES: Record<
  OpenSearchStatus,
  { className: string; label: string }
> = {
  'org-default': {
    className: 'bg-status-success-bg text-status-success-text',
    label: 'Using organization OpenSearch',
  },
  override: {
    className: 'bg-win-blue-50 text-win-blue-600',
    label: 'Using your override',
  },
  unconfigured: {
    className: 'bg-surface-tertiary text-text-secondary',
    label: 'OpenSearch is not configured',
  },
};

export function OpenSearchStatusBadge({
  status,
  detail,
}: {
  status: OpenSearchStatus;
  /** Optional secondary line shown below the badge (e.g. cluster name). */
  detail?: string | null;
}): JSX.Element {
  const s = STATUS_STYLES[status];
  return (
    <div className="flex flex-col gap-0.5">
      <span
        data-testid={`opensearch-status-${status}`}
        className={`inline-flex w-fit items-center gap-1.5 px-2 py-0.5 rounded-full
                    text-[0.7rem] font-semibold ${s.className}`}
      >
        <span
          aria-hidden
          className={`w-1.5 h-1.5 rounded-full ${
            status === 'org-default'
              ? 'bg-status-success-text'
              : status === 'override'
                ? 'bg-win-blue-500'
                : 'bg-text-tertiary'
          }`}
        />
        {s.label}
      </span>
      {detail && (
        <span className="text-[0.7rem] text-text-tertiary">{detail}</span>
      )}
    </div>
  );
}
