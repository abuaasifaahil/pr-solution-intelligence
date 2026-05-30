/**
 * ChatActionPrompt — Public type surface.
 *
 * Every option that needs the user to type something (custom text, custom
 * date, free-form question, etc.) declares its own `input` spec instead of
 * the component hard-coding "Other". The auto-added "tell me differently"
 * row is just one preset of that same `input` mechanism — same code path,
 * same result shape.
 *
 * @file   ChatActionPrompt/types.ts
 * @author PR Solutions
 * @date   2026-05-30
 */

import type { ReactNode } from 'react';

// ─── Option model ────────────────────────────────────────────────────────

export interface ChatActionInputSpec {
  /** HTML input type. `'text'` for free-form replies, `'date'` for a
   *  custom date range, etc. Default: `'text'`. */
  type?: 'text' | 'date';
  /** Empty-state placeholder. */
  placeholder?: string;
  /** Synchronous validator. Returns an error string to block submit, or
   *  `null` when the value is acceptable. Defaults to a non-empty-trim
   *  check; callers override for stricter rules (date format, etc.). */
  validate?: (value: string) => string | null;
}

export interface ChatActionOption {
  id: string;
  label: string;
  /** Dimmed text rendered inline after the label — Claude Code's `(esc)`
   *  hint, "recommended", "default", etc. */
  hint?: ReactNode;
  /** When present, picking this option reveals an inline input instead of
   *  resolving. The submitted value comes back as `result.customText`. */
  input?: ChatActionInputSpec;
}

// ─── Result + internal constants ─────────────────────────────────────────

/** Id reserved for the auto-added "tell me differently" row when
 *  `allowCustom` is true. Callers can compare against this constant
 *  instead of typing the literal everywhere. */
export const CUSTOM_OPTION_ID = '__custom__';

export interface ChatActionResult {
  /** The id of the chosen option. For the auto-added custom row this is
   *  `CUSTOM_OPTION_ID`; otherwise it's whatever the caller supplied. */
  id: string;
  /** Trimmed input value. Present iff the chosen option had an `input`
   *  spec (whether caller-supplied or the auto-added custom row). */
  customText?: string;
}

// ─── Component props ─────────────────────────────────────────────────────

export interface ChatActionPromptProps {
  question: string;
  options: ChatActionOption[];
  /** When `true` (default), appends a final row with id `CUSTOM_OPTION_ID`
   *  and a free-text input. Set to `false` for closed choice sets. */
  allowCustom?: boolean;
  /** Label for the auto-added custom row. */
  customLabel?: string;
  /** Optional dimmed hint shown after the custom row label. */
  customHint?: ReactNode;
  /** Override the placeholder shown inside the auto-added custom input. */
  customPlaceholder?: string;
  onSelect: (result: ChatActionResult) => void;
  onCancel?: () => void;
  /** Outer container className — for placement tweaks inside the chat
   *  thread without altering the prompt's internal layout. */
  className?: string;
}
