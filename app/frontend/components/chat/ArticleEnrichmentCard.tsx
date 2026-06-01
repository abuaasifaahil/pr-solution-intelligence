'use client';
import type { JSX } from 'react';

/**
 * Phase 3 — Per-article preview card (M8.9).
 *
 * Renders one article plus the enrichment dimensions the EnrichmentAgent
 * emitted for it: sentiment pill, themes, entities, signals, and reach
 * stats when present.
 *
 * The enrichment blob is `unknown` at the TS layer (the dashboard JSON
 * shape lives backend-side), so this component narrows defensively at
 * the point of use.
 *
 * @file components/chat/ArticleEnrichmentCard.tsx
 */

interface ArticlePreview {
  id: string;
  title: string;
  source: string | null;
  author: string | null;
  publishedDate: string | null;
  url?: string | null;
  publisherDomain: string | null;
  language?: string;
  mediaType?: string;
  location?: string | null;
  thumbnailUrl?: string | null;
  socialEngagement?: unknown | null;
  enrichment: unknown | null;
}

interface Props {
  article: ArticlePreview;
}

// ── Defensive narrowers ───────────────────────────────────────────────
function pickEnrichment(e: unknown): Record<string, unknown> | null {
  return e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
}
function pickSentimentLabel(e: unknown): string | null {
  const r = pickEnrichment(e);
  const s = r?.sentiment;
  if (s && typeof s === 'object' && 'label' in s) {
    return String((s as { label: unknown }).label);
  }
  return null;
}
function pickThemes(e: unknown): Array<{ level?: string; name?: string }> {
  const r = pickEnrichment(e);
  const themes = r?.themes;
  return Array.isArray(themes) ? (themes as Array<{ level?: string; name?: string }>) : [];
}
function pickEntities(e: unknown): Array<{ name?: string; type?: string }> {
  const r = pickEnrichment(e);
  const entities = r?.entities;
  return Array.isArray(entities) ? (entities as Array<{ name?: string; type?: string }>) : [];
}
function pickSignals(e: unknown): Array<{ type?: string; description?: string }> {
  const r = pickEnrichment(e);
  const signals = r?.signals;
  return Array.isArray(signals) ? (signals as Array<{ type?: string; description?: string }>) : [];
}
function pickReach(e: unknown): { monthly_visitors?: number; score?: number } | null {
  const r = pickEnrichment(e);
  const reach = r?.reach;
  if (reach && typeof reach === 'object') {
    return reach as { monthly_visitors?: number; score?: number };
  }
  return null;
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: 'bg-status-success-bg text-status-success-text',
  neutral: 'bg-surface-base text-text-secondary',
  negative: 'bg-status-error-bg text-status-error-text',
};

export function ArticleEnrichmentCard({ article }: Props): JSX.Element {
  const sentimentLabel = pickSentimentLabel(article.enrichment);
  const themes = pickThemes(article.enrichment);
  const entities = pickEntities(article.enrichment).slice(0, 6);
  const signals = pickSignals(article.enrichment);
  const reach = pickReach(article.enrichment);

  const headerMeta = [
    article.source,
    article.author,
    article.publishedDate ? article.publishedDate.slice(0, 10) : null,
    article.publisherDomain,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ');

  return (
    <div
      data-testid="article-enrichment-card"
      className="border border-border-subtle rounded-md p-3 bg-surface-card"
    >
      <div className="flex items-start gap-3">
        {article.thumbnailUrl && (
          // Plain <img> — the dashboard JSON sourced this URL from upstream
          // publisher domains, so we don't go through next/image's allow-list.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={article.thumbnailUrl}
            alt=""
            className="w-16 h-16 object-cover rounded flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-text-primary text-sm truncate">
              {article.title}
            </h3>
            {sentimentLabel && (
              <span
                data-testid="sentiment-pill"
                className={[
                  'text-xs px-2 py-0.5 rounded-pill whitespace-nowrap',
                  SENTIMENT_COLOR[sentimentLabel] ?? SENTIMENT_COLOR.neutral!,
                ].join(' ')}
              >
                {sentimentLabel}
              </span>
            )}
          </div>
          {headerMeta && (
            <div className="text-xs text-text-tertiary mt-0.5">{headerMeta}</div>
          )}
        </div>
      </div>

      {/* Themes */}
      {themes.length > 0 && (
        <div data-testid="themes-row" className="mt-2 text-xs">
          <span className="text-text-tertiary">Themes: </span>
          {themes.map((t, i) => (
            <span key={i} className="text-text-secondary">
              {i > 0 && ' · '}
              {t.level && <span className="text-text-tertiary">{t.level}:</span>}{' '}
              {t.name}
            </span>
          ))}
        </div>
      )}

      {/* Entities */}
      {entities.length > 0 && (
        <div data-testid="entities-row" className="mt-1.5 text-xs flex flex-wrap gap-1">
          {entities.map((e, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 bg-surface-base text-text-secondary rounded"
            >
              {e.name} <span className="text-text-tertiary">({e.type})</span>
            </span>
          ))}
        </div>
      )}

      {/* Signals + reach */}
      {(signals.length > 0 || reach) && (
        <div className="mt-1.5 text-xs flex flex-wrap items-center gap-2">
          {signals.map((s, i) => (
            <span
              key={i}
              data-testid="signal-chip"
              className="px-1.5 py-0.5 bg-status-warn-bg text-status-warn-text rounded"
            >
              <span aria-hidden="true">⚡</span> {s.type}
            </span>
          ))}
          {reach?.monthly_visitors != null && (
            <span data-testid="reach-row" className="text-text-tertiary">
              Reach: {reach.monthly_visitors.toLocaleString()} mo. visitors
              {reach.score != null ? ` (score ${reach.score})` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
