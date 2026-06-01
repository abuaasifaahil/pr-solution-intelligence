'use client';
import { useState, type JSX } from 'react';
import { ArticleEnrichmentCard } from './ArticleEnrichmentCard';
import { JsonCodeView } from './JsonCodeView';
import type { DashboardJson } from '../../lib/enrichment';

/**
 * Phase 3 — Inline expansion of the ChipUp artifact (M8.9).
 *
 * Sits between the collapsed chip and the fullscreen modal. Hosts a
 * `Preview` / `JSON Code` tab bar plus ⤢ (promote to fullscreen) and
 * × (collapse) controls.
 *
 * Preview cap: first 20 articles render inline; the rest are visible
 * via the fullscreen view.
 *
 * @file components/chat/ChipUpExpanded.tsx
 */

interface Props {
  chatId: string;
  artifactId: string;
  data: DashboardJson | null;
  error: string | null;
  onCollapse: () => void;
  onFullscreen: () => void;
}

type Tab = 'preview' | 'json';

const PREVIEW_CAP = 20;

export function ChipUpExpanded({
  data,
  error,
  onCollapse,
  onFullscreen,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('preview');

  return (
    <div
      data-testid="chip-up-expanded"
      className="border border-border-default rounded-md bg-surface-card overflow-hidden max-w-3xl"
    >
      {/* Header — tab bar + actions */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div role="tablist" className="flex items-center gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preview'}
            onClick={() => setTab('preview')}
            className={[
              'px-3 py-1 text-xs rounded-md transition',
              tab === 'preview'
                ? 'bg-win-blue-50 text-win-blue-600'
                : 'text-text-secondary hover:bg-surface-hover',
            ].join(' ')}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'json'}
            onClick={() => setTab('json')}
            className={[
              'px-3 py-1 text-xs rounded-md transition',
              tab === 'json'
                ? 'bg-win-blue-50 text-win-blue-600'
                : 'text-text-secondary hover:bg-surface-hover',
            ].join(' ')}
          >
            JSON Code
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onFullscreen}
            title="Open in fullscreen"
            aria-label="Open in fullscreen"
            data-testid="chip-up-fullscreen-btn"
            className="px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover rounded-md"
          >
            <span aria-hidden="true">⤢</span>
          </button>
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse"
            aria-label="Collapse"
            data-testid="chip-up-collapse-btn"
            className="px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover rounded-md"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-96 overflow-y-auto p-3">
        {error && (
          <div role="alert" className="text-status-error-text text-sm">
            Failed to load: {error}
          </div>
        )}
        {!error && !data && (
          <div className="text-text-tertiary text-sm">Loading…</div>
        )}
        {!error && data && tab === 'preview' && (
          <div className="flex flex-col gap-2">
            {data.articles.slice(0, PREVIEW_CAP).map((article) => (
              <ArticleEnrichmentCard key={article.id} article={article} />
            ))}
            {data.articles.length > PREVIEW_CAP && (
              <div className="text-text-tertiary text-xs text-center py-2">
                Showing first {PREVIEW_CAP} of{' '}
                {data.articles.length.toLocaleString()} articles. Open
                fullscreen for the full set.
              </div>
            )}
          </div>
        )}
        {!error && data && tab === 'json' && <JsonCodeView value={data} />}
      </div>
    </div>
  );
}
