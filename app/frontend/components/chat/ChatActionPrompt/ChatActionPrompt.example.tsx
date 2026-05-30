'use client';
/**
 * ChatActionPrompt — Usage examples.
 *
 * Two scenarios driven by pure data (no component subclassing) prove the
 * options are fully situation-driven:
 *
 *   1. Confirm action — closed yes/no/no-custom, simple resolve.
 *   2. Date range picker — a caller-supplied option ("Custom date range")
 *      declares its own `input` spec (date), and the auto-added "Other"
 *      row is text. Same code path, different input types per option.
 *
 * Mount this anywhere (e.g. a Storybook story, a /dev route) to see the
 * component standalone. The real integration point is the orchestrator's
 * assistant turn — when the orchestrator needs a choice, it includes a
 * `chatActionPrompt` payload in the message metadata and the MessageThread
 * renders this component inline.
 *
 * @file   ChatActionPrompt/ChatActionPrompt.example.tsx
 * @author PR Solutions
 * @date   2026-05-30
 */

import { useState, type JSX } from 'react';
import { ChatActionPrompt } from './ChatActionPrompt';
import type { ChatActionOption, ChatActionResult } from './types';

// ─── Scenario 1: confirm action ───────────────────────────────────────────
const CONFIRM_OPTIONS: ChatActionOption[] = [
  { id: 'yes', label: 'Yes, proceed' },
  { id: 'no', label: 'No, abort', hint: '(safe)' },
];

// ─── Scenario 2: date range with a caller-owned typed input ───────────────
const DATE_OPTIONS: ChatActionOption[] = [
  { id: 'weekly', label: 'Weekly' },
  { id: '10days', label: '10 Days' },
  { id: '20days', label: '20 Days' },
  {
    id: 'custom_date',
    label: 'Custom date range',
    input: {
      type: 'date',
      placeholder: 'YYYY-MM-DD',
      // Block obvious garbage — orchestrator will re-validate on the wire.
      validate: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'Use YYYY-MM-DD'),
    },
  },
];

export function ChatActionPromptExamples(): JSX.Element {
  const [confirm, setConfirm] = useState<ChatActionResult | null>(null);
  const [date, setDate] = useState<ChatActionResult | null>(null);

  return (
    <div className="flex flex-col gap-8 p-6 bg-surface-base min-h-screen">
      <section>
        <h3 className="text-sm font-semibold text-text-secondary mb-3">
          1. Confirm action (closed set, no custom)
        </h3>
        <ChatActionPrompt
          question="Do you want to proceed with deleting this chat?"
          options={CONFIRM_OPTIONS}
          allowCustom={false}
          onSelect={setConfirm}
          onCancel={() => setConfirm({ id: '__cancelled__' })}
        />
        {confirm && (
          <pre className="mt-3 text-xs text-text-tertiary font-mono">
            onSelect → {JSON.stringify(confirm)}
          </pre>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-secondary mb-3">
          2. Date range — caller-owned date input + auto-added "Other"
        </h3>
        <ChatActionPrompt
          question="Which date range should I analyze?"
          options={DATE_OPTIONS}
          customLabel="Other — describe the range in words"
          customPlaceholder="e.g. since the Q3 product launch"
          onSelect={setDate}
        />
        {date && (
          <pre className="mt-3 text-xs text-text-tertiary font-mono">
            onSelect → {JSON.stringify(date)}
          </pre>
        )}
      </section>
    </div>
  );
}
