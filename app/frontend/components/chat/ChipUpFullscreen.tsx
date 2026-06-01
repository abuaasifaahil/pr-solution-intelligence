'use client';
import { useEffect, useState, type JSX } from 'react';
import { ArticleEnrichmentCard } from './ArticleEnrichmentCard';
import { JsonCodeView } from './JsonCodeView';
import { copyToClipboard } from '../../lib/clipboard';
import type { DashboardJson } from '../../lib/enrichment';

/**
 * Phase 3 — Fullscreen modal view of the ChipUp artifact (M8.9).
 *
 * Covers the page with a centered card. Same Preview / JSON Code tabs
 * as the inline expansion, plus footer actions:
 *   - Download JSON  — synthesises a Blob and clicks an `<a download>`
 *   - Share link     — copies a chat#artifact deep link to the clipboard
 *   - Email          — opens the OS mail client via `mailto:`
 *
 * Dismiss surfaces: Esc key, backdrop click, Close button.
 *
 * @file components/chat/ChipUpFullscreen.tsx
 */

interface Props {
  chatId: string;
  artifactId: string;
  data: DashboardJson | null;
  error: string | null;
  onClose: () => void;
}

type Tab = 'preview' | 'json';

function downloadJson(data: DashboardJson, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ChipUpFullscreen({
  chatId,
  artifactId,
  data,
  error,
  onClose,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('preview');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleShare(): Promise<void> {
    if (!data) return;
    const shareUrl = `${window.location.origin}/chat/${chatId}#artifact=${artifactId}`;
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
    }
  }

  function handleEmail(): void {
    if (!data) return;
    const subject = encodeURIComponent(
      `PR Solutions enriched dataset (${data.articles.length} articles)`,
    );
    const body = encodeURIComponent(
      `View at: ${window.location.origin}/chat/${chatId}#artifact=${artifactId}`,
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  return (
    <div
      data-testid="chip-up-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Enriched dataset"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface-card rounded-lg shadow-win-16 max-w-6xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="text-xl">
              📊
            </span>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">
                Enriched dataset
              </h2>
              {data && (
                <p className="text-xs text-text-tertiary">
                  {data.articles.length.toLocaleString()} articles ·{' '}
                  {data.analysisContext.brand ?? 'no brand'} ·{' '}
                  {data.analysisContext.modelUsed}
                </p>
              )}
            </div>
          </div>
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
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div role="alert" className="text-status-error-text text-sm">
              Failed to load: {error}
            </div>
          )}
          {!error && !data && (
            <div className="text-text-tertiary">Loading…</div>
          )}
          {!error && data && tab === 'preview' && (
            <div className="flex flex-col gap-2">
              {data.articles.map((article) => (
                <ArticleEnrichmentCard key={article.id} article={article} />
              ))}
            </div>
          )}
          {!error && data && tab === 'json' && <JsonCodeView value={data} />}
        </div>

        {/* Footer */}
        <div className="border-t border-border-subtle px-4 py-3 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover rounded-md"
          >
            Close (Esc)
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="chip-up-download-btn"
              onClick={() =>
                data &&
                downloadJson(
                  data,
                  `enrichment-${artifactId.slice(0, 8)}.json`,
                )
              }
              disabled={!data}
              className="px-3 py-1.5 text-xs bg-win-blue-500 text-text-inverse rounded-md disabled:opacity-40 hover:bg-win-blue-600 transition"
            >
              Download JSON
            </button>
            <button
              type="button"
              data-testid="chip-up-share-btn"
              onClick={() => void handleShare()}
              disabled={!data}
              className="px-3 py-1.5 text-xs border border-border-default rounded-md hover:bg-surface-hover disabled:opacity-40 transition"
            >
              {copyStatus === 'copied' ? '✓ Copied' : 'Share link'}
            </button>
            <button
              type="button"
              data-testid="chip-up-email-btn"
              onClick={handleEmail}
              disabled={!data}
              className="px-3 py-1.5 text-xs border border-border-default rounded-md hover:bg-surface-hover disabled:opacity-40 transition"
            >
              Email
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
