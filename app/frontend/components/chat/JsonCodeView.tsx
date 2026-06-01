'use client';
import type { JSX } from 'react';

/**
 * Phase 3 — Syntax-highlighted JSON viewer (M8.9).
 *
 * Mirrors the spirit of M7.9's `BooleanQueryPreview` highlighter — a
 * regex-driven tokenizer with span colouring rather than pulling in a
 * full syntax engine. Token classes:
 *   - Keys (`"key":`)        → win-blue-600
 *   - String values          → status-success-text (Fluent green)
 *   - Numbers                → win-orange
 *   - Booleans               → win-purple
 *   - null + punctuation     → text-tertiary
 *
 * @file components/chat/JsonCodeView.tsx
 */

interface Props {
  value: unknown;
}

function highlight(json: string): JSX.Element[] {
  // Order matters: keys (`"key":`) must be matched before plain strings.
  const pattern =
    /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?|true|false|null|[{}[\],:])/g;
  const out: JSX.Element[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(json)) !== null) {
    if (m.index > last) {
      out.push(<span key={`s${i++}`}>{json.slice(last, m.index)}</span>);
    }
    const token = m[0]!;
    let cls = '';
    if (token.endsWith(':')) cls = 'text-win-blue-600';
    else if (token.startsWith('"')) cls = 'text-status-success-text';
    else if (/^[-+]?\d/.test(token)) cls = 'text-win-orange';
    else if (token === 'true' || token === 'false') cls = 'text-win-purple';
    else if (token === 'null') cls = 'text-text-tertiary';
    else cls = 'text-text-tertiary';
    out.push(
      <span key={`t${i++}`} className={cls}>
        {token}
      </span>,
    );
    last = m.index + token.length;
  }
  if (last < json.length) {
    out.push(<span key={`s${i++}`}>{json.slice(last)}</span>);
  }
  return out;
}

export function JsonCodeView({ value }: Props): JSX.Element {
  const text = JSON.stringify(value, null, 2);
  return (
    <pre
      data-testid="json-code-view"
      className="font-mono text-xs leading-snug whitespace-pre-wrap bg-surface-base p-3 rounded"
    >
      {highlight(text)}
    </pre>
  );
}
