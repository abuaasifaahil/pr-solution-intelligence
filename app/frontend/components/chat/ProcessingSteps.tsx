'use client';

import type { JSX } from 'react';

/**
 * Generic per-step processing visualization.
 *
 * Intentionally NOT hardcoded to the Phase 2 DataExtractAgent — it takes a
 * `steps` array as a prop. The Phase 5.5 sandbox tooling will reuse this
 * component as-is by passing its own step list.
 *
 * Visual contract:
 *   - `pending` → empty circle
 *   - `running` → animated spinner
 *   - `done`    → solid green check
 *   - `failed`  → red ×, with error message rendered below the row
 *
 * @file components/chat/ProcessingSteps.tsx
 */

export type AgentStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AgentStep {
  key: string;
  name: string;
  status: AgentStepStatus;
  /** Server-reported step duration in ms. Only meaningful when `done`. */
  durationMs?: number;
  /** Failure detail — surfaced inline under the row when present. */
  error?: string;
}

interface Props {
  steps: AgentStep[];
  /** Optional agent label rendered at the top of the card. */
  agentName?: string;
}

export function ProcessingSteps({ steps, agentName }: Props): JSX.Element {
  return (
    <div
      className={[
        'flex flex-col w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      aria-label="Processing steps"
      data-testid="processing-steps"
    >
      {agentName && (
        <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle flex items-center justify-between">
          <span className="font-medium">{agentName}</span>
          <span className="text-text-tertiary text-xs">
            {summary(steps)}
          </span>
        </div>
      )}

      <ol className="px-4 py-3 flex flex-col gap-2">
        {steps.map((s) => (
          <li
            key={s.key}
            className="flex items-start gap-3"
            data-step-key={s.key}
            data-step-status={s.status}
          >
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center"
            >
              <StepIcon status={s.status} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={[
                    'text-sm',
                    s.status === 'done'
                      ? 'text-text-secondary'
                      : s.status === 'failed'
                        ? 'text-status-error-text'
                        : 'text-text-primary',
                  ].join(' ')}
                >
                  {s.name}
                </span>
                {s.status === 'done' && s.durationMs != null && (
                  <span className="text-text-tertiary text-xs tabular-nums">
                    {formatMs(s.durationMs)}
                  </span>
                )}
              </div>
              {s.status === 'failed' && s.error && (
                <div
                  role="alert"
                  className="mt-1 text-status-error-text text-xs"
                  title={s.error}
                >
                  {s.error}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function StepIcon({ status }: { status: AgentStepStatus }): JSX.Element {
  if (status === 'done') {
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 text-status-success-text" fill="currentColor">
        <path d="M6.173 11.42 3.5 8.73l.94-.94 1.733 1.74L11.06 5l.94.94z" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 text-status-error-text" fill="currentColor">
        <path d="M8 6.94 11.06 4 12 4.94 8.94 8 12 11.06 11.06 12 8 8.94 4.94 12 4 11.06 7.06 8 4 4.94 4.94 4z" />
      </svg>
    );
  }
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4 text-win-blue-500 animate-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="8" cy="8" r="6" strokeOpacity="0.25" />
        <path d="M14 8a6 6 0 0 0-6-6" strokeLinecap="round" />
      </svg>
    );
  }
  // pending
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 text-border-default" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

function summary(steps: AgentStep[]): string {
  const done = steps.filter((s) => s.status === 'done').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const total = steps.length;
  if (failed > 0) return `${done}/${total} done · ${failed} failed`;
  return `${done}/${total} steps`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
