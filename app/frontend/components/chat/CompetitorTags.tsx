'use client';

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { CompetitorSet, CompetitorSuggestions } from '../../lib/chat-params';

/**
 * Phase 2 — Competitor tags input.
 *
 * Renders the LLM-suggested competitor lists (top5 / top3 / top2) as
 * tappable chip sets, plus a "custom" mode that lets the user build the
 * list by typing comma-separated names or pressing enter to commit a tag.
 *
 * The component owns the visual editing state. On submit, it calls
 * `onSubmit(competitors, set)` once. Callers PATCH chat_params with that
 * pair to advance the flow.
 *
 * @file components/chat/CompetitorTags.tsx
 */

interface Props {
  /** Brand name — surfaced in the prompt copy so the user has context. */
  brand: string;
  /** Suggested lists from `/params/brand-suggest`. Null while loading. */
  suggestions: CompetitorSuggestions | null;
  /** Loading flag for the suggestions request. */
  loading?: boolean;
  /** Pre-fill — restore the user's custom set on reload. */
  defaultCompetitors?: string[];
  defaultSet?: CompetitorSet;
  onSubmit: (competitors: string[], set: CompetitorSet) => void;
}

export function CompetitorTags({
  brand,
  suggestions,
  loading,
  defaultCompetitors,
  defaultSet,
  onSubmit,
}: Props): JSX.Element {
  const [activeSet, setActiveSet] = useState<CompetitorSet>(defaultSet ?? 'top5');
  const [customTags, setCustomTags] = useState<string[]>(defaultCompetitors ?? []);
  const [draft, setDraft] = useState('');

  // When suggestions land, keep defaults in sync.
  useEffect(() => {
    if (activeSet === 'custom' || !suggestions) return;
    // Nothing else to sync — render uses suggestions directly.
  }, [suggestions, activeSet]);

  const currentList = useMemo<string[]>(() => {
    if (activeSet === 'custom') return customTags;
    if (!suggestions) return [];
    if (activeSet === 'top5') return suggestions.top5;
    if (activeSet === 'top3') return suggestions.top3;
    return suggestions.top2;
  }, [activeSet, customTags, suggestions]);

  function commitDraft(): void {
    const tag = draft.trim();
    if (!tag) return;
    setCustomTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
    setDraft('');
  }

  function onDraftKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (
      e.key === 'Backspace' &&
      draft === '' &&
      customTags.length > 0
    ) {
      // Backspace on empty field pops the last tag.
      setCustomTags((prev) => prev.slice(0, -1));
    }
  }

  function removeTag(tag: string): void {
    setCustomTags((prev) => prev.filter((t) => t !== tag));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (currentList.length === 0) return;
    onSubmit(currentList, activeSet);
  }

  const canSubmit = currentList.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className={[
        'flex flex-col font-mono text-sm w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      aria-label="Competitor selection"
    >
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle">
        Who are <span className="font-medium">{brand}</span>'s competitors?
      </div>

      {/* Set picker */}
      <div className="px-3 pt-3 flex flex-wrap gap-1.5" role="tablist">
        {(['top5', 'top3', 'top2', 'custom'] as const).map((s) => {
          const active = s === activeSet;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveSet(s)}
              className={[
                'px-2.5 py-1 text-xs rounded-full font-sans transition-colors',
                active
                  ? 'bg-win-blue-500 text-text-inverse'
                  : 'bg-surface-hover text-text-secondary hover:bg-surface-active',
              ].join(' ')}
            >
              {s === 'custom' ? 'Custom' : `Top ${s.slice(3)}`}
            </button>
          );
        })}
      </div>

      {/* Current tag list */}
      <div className="px-3 pt-3 min-h-[2rem] flex flex-wrap gap-1.5">
        {loading && activeSet !== 'custom' ? (
          <span className="text-text-tertiary text-xs animate-pulse">
            Loading suggestions…
          </span>
        ) : currentList.length === 0 ? (
          <span className="text-text-tertiary text-xs">
            {activeSet === 'custom'
              ? 'Type a competitor and press enter or comma.'
              : 'No suggestions available — try Custom.'}
          </span>
        ) : (
          currentList.map((tag) => (
            <span
              key={tag}
              className={[
                'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full',
                'bg-status-info-bg text-status-info-text',
              ].join(' ')}
            >
              {tag}
              {activeSet === 'custom' && (
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove ${tag}`}
                  className="text-status-info-text/70 hover:text-status-error-text"
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>

      {/* Custom-mode input */}
      {activeSet === 'custom' && (
        <div className="px-3 pt-3 flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            placeholder="Add competitor — enter or comma to commit"
            aria-label="Add competitor"
            className={[
              'flex-1 font-mono text-sm bg-surface-base px-2 py-1 rounded-sm',
              'border border-border-default',
              'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
            ].join(' ')}
          />
          <button
            type="button"
            onClick={commitDraft}
            disabled={draft.trim() === ''}
            className={[
              'px-2.5 py-1 text-xs rounded-sm font-sans',
              'bg-surface-hover text-text-primary hover:bg-surface-active',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            Add
          </button>
        </div>
      )}

      <div className="px-3 py-3 mt-1 flex justify-end gap-2 border-t border-border-subtle">
        <button
          type="submit"
          disabled={!canSubmit}
          className={[
            'px-3 py-1.5 text-xs rounded-sm font-sans',
            'bg-win-blue-500 text-text-inverse',
            'hover:bg-win-blue-600',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:ring-offset-1',
          ].join(' ')}
        >
          Continue
        </button>
      </div>
    </form>
  );
}
