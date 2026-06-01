'use client';
import { useEffect, useState, type JSX } from 'react';
import { ChipUpExpanded } from './ChipUpExpanded';
import { ChipUpFullscreen } from './ChipUpFullscreen';
import { getEnrichJson, type DashboardJson } from '../../lib/enrichment';

/**
 * Phase 3 — ChipUp artifact controller (M8.9).
 *
 * The persistent, dashboard-ready JSON artifact that lives in the chat
 * thread forever. Three visual modes share one controller:
 *
 *   collapsed   → small pill button — the default, takes minimal space
 *   expanded    → inline tab UI (Preview / JSON Code)
 *   fullscreen  → modal overlay with download / share / email actions
 *
 * State transitions:
 *   collapsed → expanded → collapsed
 *   collapsed → expanded → fullscreen → expanded (back)
 *
 * Lazy-loads the dashboard JSON on the first transition out of the
 * collapsed state so unviewed artifacts don't pay the network cost.
 *
 * @file components/chat/ChipUpArtifact.tsx
 */

interface Props {
  chatId: string;
  /** Job id, used as the opaque artifact handle in share links. */
  artifactId: string;
  articleCount: number;
}

type Mode = 'collapsed' | 'expanded' | 'fullscreen';

export function ChipUpArtifact({
  chatId,
  artifactId,
  articleCount,
}: Props): JSX.Element {
  // M8.10 — deep-link auto-expand. When a recipient opens a share link
  // (`…/chat/<id>#artifact=<artifactId>`), the chip should mount already
  // expanded. Hash is read ONCE on mount; we don't reactivity-track later
  // hash changes — Phase 3 doesn't need that yet.
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'collapsed';
    const match = window.location.hash.match(/^#artifact=([^&]+)/);
    return match && match[1] === artifactId ? 'expanded' : 'collapsed';
  });
  const [data, setData] = useState<DashboardJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load on first expansion.
  useEffect(() => {
    if (mode === 'collapsed') return;
    if (data !== null || error !== null) return;
    let cancelled = false;
    void getEnrichJson(chatId)
      .then((envelope) => {
        if (!cancelled) setData(envelope.dashboard);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, data, error, chatId]);

  if (mode === 'collapsed') {
    return (
      <button
        type="button"
        onClick={() => setMode('expanded')}
        data-testid="chip-up-artifact"
        className="inline-flex items-center gap-2 px-3 py-2 bg-win-blue-50 text-win-blue-600 border border-win-blue-100 rounded-pill hover:bg-win-blue-100 transition text-sm font-medium self-start"
        aria-label="Open enriched dashboard JSON"
      >
        <span aria-hidden="true">📊</span>
        <span>Enriched dataset</span>
        <span className="text-text-tertiary text-xs">
          {articleCount.toLocaleString()} articles
        </span>
        <span aria-hidden="true" className="text-text-tertiary">
          ›
        </span>
      </button>
    );
  }

  if (mode === 'expanded') {
    return (
      <ChipUpExpanded
        chatId={chatId}
        artifactId={artifactId}
        data={data}
        error={error}
        onCollapse={() => setMode('collapsed')}
        onFullscreen={() => setMode('fullscreen')}
      />
    );
  }

  // fullscreen
  return (
    <ChipUpFullscreen
      chatId={chatId}
      artifactId={artifactId}
      data={data}
      error={error}
      onClose={() => setMode('expanded')}
    />
  );
}
