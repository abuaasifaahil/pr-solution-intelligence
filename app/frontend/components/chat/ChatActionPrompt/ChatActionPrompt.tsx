'use client';
/**
 * ChatActionPrompt — Claude Code-style inline action prompt.
 *
 * Renders a bordered, monospace box that drops inline into the chat thread
 * (not a centered modal) with numbered choices, a leading "❯" on the
 * highlighted row, optional dimmed hints, a footer help line, and per-option
 * inline inputs (text/date) revealed on demand. After the user picks, the
 * box collapses into a read-only "you answered: …" line so the chat
 * transcript stays clean.
 *
 * All state + keyboard logic lives in `useActionPrompt`; this file is
 * presentational only. Style tokens come from the Tailwind theme — no
 * hard-coded hex — so the prompt adapts to light/dark themes.
 *
 * @file   ChatActionPrompt/ChatActionPrompt.tsx
 * @author PR Solutions
 * @date   2026-05-30
 */

import { useEffect, useRef, type JSX } from 'react';
import { type ChatActionPromptProps } from './types';
import { useActionPrompt } from './useActionPrompt';

export function ChatActionPrompt(props: ChatActionPromptProps): JSX.Element {
  const {
    question,
    options: baseOptions,
    allowCustom = true,
    customLabel = 'Other — tell me what to do differently',
    customHint,
    customPlaceholder,
    onSelect,
    onCancel,
    className,
  } = props;

  const {
    options,
    state,
    isHighlighted,
    isInputOpen,
    optionDomId,
    onContainerKeyDown,
    onInputKeyDown,
    onInputChange,
    onRowClick,
    submitInput,
  } = useActionPrompt({
    baseOptions,
    allowCustom,
    customLabel,
    customHint,
    customPlaceholder,
    onSelect,
    onCancel,
  });

  // ─── Refs + focus management ────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the container on mount so keyboard works without an extra
  // click — the prompt sits in the chat flow but acts as "the live thing".
  useEffect(() => {
    if (state.resolved || state.cancelled) return;
    if (state.openInputAt !== null) {
      inputRef.current?.focus();
    } else {
      containerRef.current?.focus();
    }
  }, [state.openInputAt, state.resolved, state.cancelled]);

  // Soft focus-trap: if focus escapes the box while we're still active,
  // pull it back. Inline (not modal) so we DON'T `inert` the rest of the
  // page — we just refuse to lose focus to it via Tab.
  useEffect(() => {
    if (state.resolved || state.cancelled) return;
    const root = containerRef.current;
    if (!root) return;
    const handler = (e: FocusEvent): void => {
      const target = e.target as Node | null;
      if (!target || root.contains(target)) return;
      if (state.openInputAt !== null && inputRef.current) {
        inputRef.current.focus();
      } else {
        root.focus();
      }
    };
    document.addEventListener('focusin', handler);
    return () => document.removeEventListener('focusin', handler);
  }, [state.resolved, state.cancelled, state.openInputAt]);

  // ─── Resolved (read-only) state ─────────────────────────────────────
  if (state.resolved) {
    const picked = options.find((o) => o.id === state.resolved!.id);
    return (
      <div
        className={[
          'inline-flex flex-col font-mono text-sm rounded-md',
          'border border-border-default bg-surface-card px-3 py-2',
          className ?? '',
        ].join(' ')}
        role="status"
        aria-live="polite"
      >
        <span className="text-text-tertiary text-xs mb-1">You answered</span>
        <span className="text-text-primary">
          <span aria-hidden="true" className="text-win-blue-500 mr-1.5">❯</span>
          {picked?.label ?? state.resolved.id}
          {state.resolved.customText && (
            <span className="text-text-secondary"> — {state.resolved.customText}</span>
          )}
        </span>
      </div>
    );
  }

  // ─── Cancelled (read-only) state ────────────────────────────────────
  if (state.cancelled) {
    return (
      <div
        className={[
          'inline-flex font-mono text-sm rounded-md italic',
          'border border-border-subtle bg-surface-card px-3 py-2 text-text-tertiary',
          className ?? '',
        ].join(' ')}
        role="status"
        aria-live="polite"
      >
        Cancelled
      </div>
    );
  }

  // ─── Active prompt ──────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={question}
      aria-activedescendant={optionDomId(state.highlighted)}
      tabIndex={0}
      onKeyDown={onContainerKeyDown}
      className={[
        // Sits in the chat flow — flex-col, mono, theme-token surface.
        'flex flex-col font-mono text-sm w-full max-w-2xl',
        'rounded-md border border-border-default bg-surface-card',
        'shadow-win-2',
        // Visible focus ring — required for keyboard a11y.
        'focus:outline-none focus:ring-2 focus:ring-win-blue-500',
        'overflow-hidden',
        className ?? '',
      ].join(' ')}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 text-text-primary border-b border-border-subtle">
        {question}
      </div>

      {/* Options list */}
      <ul className="py-1" role="presentation">
        {options.map((opt, idx) => {
          const hl = isHighlighted(idx);
          const open = isInputOpen(idx);
          const numLabel = `${idx + 1}.`;
          return (
            <li key={opt.id} role="presentation">
              <button
                type="button"
                role="option"
                id={optionDomId(idx)}
                aria-selected={hl}
                tabIndex={-1}
                onClick={onRowClick(idx)}
                className={[
                  'w-full text-left flex items-center gap-2 px-3 py-1.5',
                  'transition-colors',
                  hl
                    ? 'bg-win-blue-50 text-win-blue-700'
                    : 'text-text-primary hover:bg-surface-hover',
                ].join(' ')}
              >
                {/*
                 * Arrow slot — width is RESERVED on every row so toggling
                 * visibility doesn't shift the label horizontally. Uses
                 * opacity-0 (not display:none) for stable layout.
                 */}
                <span
                  aria-hidden="true"
                  className={[
                    'inline-block w-3 text-win-blue-500',
                    hl ? 'opacity-100' : 'opacity-0',
                  ].join(' ')}
                >
                  ❯
                </span>
                <span className="inline-block w-5 text-text-tertiary tabular-nums">{numLabel}</span>
                <span className="flex-1">
                  {opt.label}
                  {opt.hint != null && (
                    <span className="ml-2 text-text-tertiary text-xs">{opt.hint}</span>
                  )}
                </span>
              </button>

              {/*
               * Inline input — only rendered when this row is "open".
               * Lives below the row so non-open rows stay compact and
               * the user keeps spatial context (which row they typed for).
               */}
              {open && opt.input && (
                <>
                  <div className="px-3 pb-2 pl-12 flex items-center gap-2">
                    <input
                      ref={inputRef}
                      type={opt.input.type ?? 'text'}
                      placeholder={opt.input.placeholder}
                      value={state.inputDraft}
                      onChange={onInputChange}
                      onKeyDown={onInputKeyDown}
                      aria-invalid={state.inputError !== null}
                      aria-describedby={
                        state.inputError ? `${optionDomId(idx)}-err` : undefined
                      }
                      className={[
                        'flex-1 font-mono text-sm bg-surface-base px-2 py-1 rounded-sm',
                        'border focus:outline-none focus:ring-2 focus:ring-win-blue-500',
                        state.inputError
                          ? 'border-status-error-text'
                          : 'border-border-default',
                      ].join(' ')}
                    />
                    <button
                      type="button"
                      onClick={() => submitInput(idx)}
                      disabled={state.inputDraft.trim() === ''}
                      className={[
                        'px-2.5 py-1 text-xs rounded-sm font-sans',
                        'bg-win-blue-500 text-text-inverse',
                        'hover:bg-win-blue-600',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                        'focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:ring-offset-1',
                      ].join(' ')}
                    >
                      Submit
                    </button>
                  </div>
                  {state.inputError && (
                    <div
                      id={`${optionDomId(idx)}-err`}
                      className="px-3 pb-2 pl-12 text-status-error-text text-xs"
                      role="alert"
                    >
                      {state.inputError}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-border-subtle text-text-tertiary text-xs flex flex-wrap gap-x-2">
        <span>
          Use <kbd className="text-text-secondary">↑↓</kbd> to navigate
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <kbd className="text-text-secondary">1–9</kbd> jump
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <kbd className="text-text-secondary">enter</kbd> to select
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <kbd className="text-text-secondary">esc</kbd> to cancel
        </span>
      </div>
    </div>
  );
}
