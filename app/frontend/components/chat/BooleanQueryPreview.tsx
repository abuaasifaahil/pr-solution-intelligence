'use client';

import { useEffect, useState, type JSX } from 'react';
import type { BooleanQuery } from '../../lib/boolean-query';

/**
 * Phase 2 — Boolean query preview card.
 *
 * Renders the engine-generated Boolean expression in a syntax-highlighted
 * `<pre>` block with three actions: Edit (swap to a textarea), Copy (push to
 * clipboard), Confirm (locks the query + triggers DataExtractAgent).
 *
 * Highlighting is intentionally simple — span-based tokenization rather
 * than pulling in a syntax engine. Tokens:
 *   - Keywords `AND`, `OR`, `NOT`     → win-orange (status-warn-text)
 *   - Fields `name:`                   → win-blue-500
 *   - Quoted strings `"value"`         → win-green (status-success-text)
 *   - Parentheses                      → text-text-tertiary
 *
 * Once `isConfirmed` is true, the buttons collapse to a `✓ Confirmed v{n}`
 * pill — editing post-confirm requires a new query generate.
 *
 * @file components/chat/BooleanQueryPreview.tsx
 */

interface Props {
  query: BooleanQuery | null;
  onEdit: (text: string) => void;
  onConfirm: () => void;
  /** Optional override for the copy handler — defaults to navigator.clipboard. */
  onCopy?: () => void;
  /** When true, surface a small spinner next to the Confirm button. */
  busy?: boolean;
}

export function BooleanQueryPreview({
  query,
  onEdit,
  onConfirm,
  onCopy,
  busy,
}: Props): JSX.Element | null {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset the draft each time a new query lands.
  useEffect(() => {
    if (!editing && query) setDraft(query.text);
  }, [query, editing]);

  if (!query) return null;

  function defaultCopy(): void {
    if (onCopy) {
      onCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && query) {
      void navigator.clipboard.writeText(query.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }

  function handleApplyEdit(): void {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setEditing(false);
    onEdit(trimmed);
  }

  return (
    <div
      className={[
        'flex flex-col w-full max-w-3xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2 overflow-hidden',
      ].join(' ')}
      data-confirmed={query.isConfirmed}
      aria-label="Boolean query preview"
    >
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle flex items-center justify-between">
        <span>Boolean query</span>
        <span className="text-text-tertiary text-xs">v{query.version}</span>
      </div>

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          aria-label="Edit Boolean query"
          className={[
            'font-mono text-sm m-3 p-3 rounded-sm',
            'bg-text-primary text-text-inverse',
            'border border-border-default',
            'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
          ].join(' ')}
        />
      ) : (
        <pre
          className={[
            'font-mono text-sm m-3 p-3 rounded-sm whitespace-pre-wrap break-words',
            'bg-text-primary text-text-inverse',
          ].join(' ')}
          aria-label="Boolean query text"
          data-testid="boolean-query-pre"
        >
          {highlight(query.text)}
        </pre>
      )}

      <div className="px-3 pb-3 flex items-center justify-between gap-2">
        <div className="text-xs">
          {query.isConfirmed ? (
            <span
              className={[
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
                'bg-status-success-bg text-status-success-text',
              ].join(' ')}
              aria-label="Confirmed"
            >
              <span aria-hidden>✓</span> Confirmed v{query.version}
            </span>
          ) : (
            <span className="text-text-tertiary">
              {editing ? 'Editing — apply to save' : 'Review before processing'}
            </span>
          )}
        </div>

        {!query.isConfirmed && (
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(query.text);
                  }}
                  className="px-2.5 py-1 text-xs font-sans text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyEdit}
                  disabled={draft.trim() === ''}
                  className={[
                    'px-2.5 py-1 text-xs rounded-sm font-sans',
                    'bg-surface-hover text-text-primary hover:bg-surface-active',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  ].join(' ')}
                >
                  Apply edit
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setDraft(query.text);
                  }}
                  className={[
                    'px-2.5 py-1 text-xs rounded-sm font-sans',
                    'bg-surface-hover text-text-primary hover:bg-surface-active',
                  ].join(' ')}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={defaultCopy}
                  className={[
                    'px-2.5 py-1 text-xs rounded-sm font-sans',
                    'bg-surface-hover text-text-primary hover:bg-surface-active',
                  ].join(' ')}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={busy}
                  className={[
                    'px-3 py-1 text-xs rounded-sm font-sans',
                    'bg-win-blue-500 text-text-inverse hover:bg-win-blue-600',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  ].join(' ')}
                >
                  {busy ? 'Confirming…' : 'Confirm & Process'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Highlighter ────────────────────────────────────────────────────────────

const TOKEN_RE = /(\s+|AND|OR|NOT|[()]|"(?:\\"|[^"])*"|[A-Za-z_][A-Za-z0-9_]*:)/g;

/**
 * Splits the query text into typed tokens and wraps each in a span with the
 * theme-token color. Returns a fragment array — React renders each span on
 * its own. Keeps whitespace verbatim so multi-line layout survives.
 */
function highlight(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let lastIndex = 0;
  let i = 0;
  // RegExp.exec keeps `lastIndex` across calls — reset to 0 every call.
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push(
        <span key={`t-${i++}`} className="text-text-inverse">
          {text.slice(lastIndex, m.index)}
        </span>,
      );
    }
    const tok = m[0];
    out.push(<span key={`t-${i++}`} className={classifyToken(tok)}>{tok}</span>);
    lastIndex = m.index + tok.length;
  }
  if (lastIndex < text.length) {
    out.push(
      <span key={`t-${i++}`} className="text-text-inverse">
        {text.slice(lastIndex)}
      </span>,
    );
  }
  return out;
}

function classifyToken(tok: string): string {
  if (/^\s+$/.test(tok)) return 'text-text-inverse';
  if (tok === 'AND' || tok === 'OR' || tok === 'NOT') {
    return 'text-status-warn-text font-medium';
  }
  if (tok === '(' || tok === ')') return 'text-text-tertiary';
  if (/^"/.test(tok)) return 'text-status-success-text';
  if (/:$/.test(tok)) return 'text-win-blue-400';
  return 'text-text-inverse';
}
