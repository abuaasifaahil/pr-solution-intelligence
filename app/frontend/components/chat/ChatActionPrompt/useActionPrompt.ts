'use client';
/**
 * ChatActionPrompt — State + keyboard logic.
 *
 * Owns: which row is highlighted, which (if any) option has its inline input
 * open, the input draft + validation state, and the final
 * resolved/cancelled lock. Splitting this out keeps the JSX in
 * `ChatActionPrompt.tsx` purely presentational and makes the keyboard
 * machine independently testable.
 *
 * SOLID notes:
 *   • Single-responsibility: this hook ONLY owns interaction state.
 *     Rendering, focus management, and a11y wiring live in the component.
 *   • Open/closed: new "option types" (date, free text, future select)
 *     extend via `ChatActionInputSpec`, never by editing the reducer.
 *
 * @file   ChatActionPrompt/useActionPrompt.ts
 * @author PR Solutions
 * @date   2026-05-30
 */

import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  CUSTOM_OPTION_ID,
  type ChatActionInputSpec,
  type ChatActionOption,
  type ChatActionResult,
} from './types';

// ─── Internal state model ────────────────────────────────────────────────

interface State {
  /** Index of the currently-highlighted row. */
  highlighted: number;
  /** When non-null, the option at this index is showing its input field. */
  openInputAt: number | null;
  /** Draft value for the open input. */
  inputDraft: string;
  /** Validation error for the open input. `null` = no error. */
  inputError: string | null;
  /** Once set, the prompt is locked into a read-only "you chose X" line. */
  resolved: ChatActionResult | null;
  /** True after Esc — also locks the prompt. */
  cancelled: boolean;
}

type Action =
  | { type: 'highlight'; index: number }
  | { type: 'open-input'; index: number }
  | { type: 'close-input' }
  | { type: 'set-draft'; value: string; error: string | null }
  | { type: 'resolve'; result: ChatActionResult }
  | { type: 'cancel' };

const INITIAL: State = {
  highlighted: 0,
  openInputAt: null,
  inputDraft: '',
  inputError: null,
  resolved: null,
  cancelled: false,
};

function reducer(s: State, a: Action): State {
  // Once resolved or cancelled, the prompt is frozen. Drop further actions
  // so a double-fire (e.g. Enter + click) can't corrupt the result.
  if (s.resolved || s.cancelled) return s;

  switch (a.type) {
    case 'highlight':
      // Moving the highlight ALSO collapses any open input — selecting a
      // different option means the user changed their mind about the
      // previous one. Keeps the input state coupled to a single row.
      return {
        ...s,
        highlighted: a.index,
        openInputAt: null,
        inputDraft: '',
        inputError: null,
      };
    case 'open-input':
      return { ...s, openInputAt: a.index, inputDraft: '', inputError: null };
    case 'close-input':
      return { ...s, openInputAt: null, inputDraft: '', inputError: null };
    case 'set-draft':
      return { ...s, inputDraft: a.value, inputError: a.error };
    case 'resolve':
      return { ...s, resolved: a.result, openInputAt: null };
    case 'cancel':
      return { ...s, cancelled: true, openInputAt: null };
    default:
      return s;
  }
}

// ─── Hook public API ─────────────────────────────────────────────────────

export interface UseActionPromptArgs {
  baseOptions: ChatActionOption[];
  allowCustom: boolean;
  customLabel: string;
  customHint?: import('react').ReactNode;
  customPlaceholder?: string;
  onSelect: (r: ChatActionResult) => void;
  onCancel?: () => void;
}

export interface UseActionPromptApi {
  /** Effective list = caller options + (optional) auto-added custom row. */
  options: ChatActionOption[];
  state: State;
  /** True iff `idx` is the highlighted row. */
  isHighlighted: (idx: number) => boolean;
  /** True iff `idx`'s inline input is currently open. */
  isInputOpen: (idx: number) => boolean;
  /** Stable DOM id for option N — used by `aria-activedescendant`. */
  optionDomId: (idx: number) => string;
  /** Bind to the listbox container's `onKeyDown`. */
  onContainerKeyDown: (e: ReactKeyboardEvent) => void;
  /** Bind to the inline input's `onKeyDown`. */
  onInputKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** Bind to the inline input's `onChange`. */
  onInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Click handler factory for an option row. */
  onRowClick: (idx: number) => () => void;
  /** Programmatic submit for an option's inline input. */
  submitInput: (idx: number) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useActionPrompt(args: UseActionPromptArgs): UseActionPromptApi {
  // ─── Build effective option list ────────────────────────────────────
  // Stable identity unless the inputs actually change — keeps option DOM
  // ids stable (and aria-activedescendant happy) across renders.
  const options = useMemo<ChatActionOption[]>(() => {
    if (!args.allowCustom) return args.baseOptions;
    return [
      ...args.baseOptions,
      {
        id: CUSTOM_OPTION_ID,
        label: args.customLabel,
        hint: args.customHint,
        input: {
          type: 'text',
          placeholder: args.customPlaceholder ?? 'Tell me what to do…',
        },
      },
    ];
  }, [args.baseOptions, args.allowCustom, args.customLabel, args.customHint, args.customPlaceholder]);

  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Component instance prefix for option DOM ids. Stable across renders —
  // we don't want ids changing or aria-activedescendant points at nothing.
  // Note: Math.random in render would re-roll; useRef pins it.
  const idPrefix = useRef<string>(`cap-${Math.random().toString(36).slice(2, 9)}`).current;

  // ─── Helpers ────────────────────────────────────────────────────────
  const clamp = useCallback(
    (i: number): number => {
      const n = options.length;
      if (n === 0) return 0;
      // Wrap-around — matches Claude Code terminal nav.
      return ((i % n) + n) % n;
    },
    [options.length],
  );

  const validateInput = useCallback(
    (spec: ChatActionInputSpec | undefined, value: string): string | null => {
      if (!spec) return null;
      if (spec.validate) return spec.validate(value);
      // Default: non-empty trim.
      return value.trim() === '' ? 'Please enter a value.' : null;
    },
    [],
  );

  const commitSelection = useCallback(
    (idx: number): void => {
      const opt = options[idx];
      if (!opt) return;
      if (opt.input) {
        // Input-requiring option: don't resolve yet — reveal the editor.
        dispatch({ type: 'open-input', index: idx });
        return;
      }
      const result: ChatActionResult = { id: opt.id };
      dispatch({ type: 'resolve', result });
      args.onSelect(result);
    },
    [options, args],
  );

  const submitInput = useCallback(
    (idx: number): void => {
      const opt = options[idx];
      if (!opt || !opt.input) return;
      const trimmed = state.inputDraft.trim();
      const err = validateInput(opt.input, trimmed);
      if (err) {
        // Surface the error and keep the prompt open.
        dispatch({ type: 'set-draft', value: state.inputDraft, error: err });
        return;
      }
      const result: ChatActionResult = { id: opt.id, customText: trimmed };
      dispatch({ type: 'resolve', result });
      args.onSelect(result);
    },
    [options, state.inputDraft, validateInput, args],
  );

  // ─── Event handlers ─────────────────────────────────────────────────

  const onContainerKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      if (state.resolved || state.cancelled) return;
      // If the inline input has focus, its own handler (`onInputKeyDown`)
      // owns the keypress — bail out so we don't double-process Enter/Esc.
      if (state.openInputAt !== null && e.target instanceof HTMLInputElement) return;

      const key = e.key;
      if (key === 'ArrowDown' || key === 'j') {
        e.preventDefault();
        dispatch({ type: 'highlight', index: clamp(state.highlighted + 1) });
      } else if (key === 'ArrowUp' || key === 'k') {
        e.preventDefault();
        dispatch({ type: 'highlight', index: clamp(state.highlighted - 1) });
      } else if (key === 'Home') {
        e.preventDefault();
        dispatch({ type: 'highlight', index: 0 });
      } else if (key === 'End') {
        e.preventDefault();
        dispatch({ type: 'highlight', index: options.length - 1 });
      } else if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        commitSelection(state.highlighted);
      } else if (key === 'Escape') {
        e.preventDefault();
        dispatch({ type: 'cancel' });
        args.onCancel?.();
      } else if (/^[1-9]$/.test(key)) {
        // Number keys jump to the Nth row (1-indexed). Highlight only —
        // selection still requires Enter, matching the explicit spec.
        const idx = Number.parseInt(key, 10) - 1;
        if (idx < options.length) {
          e.preventDefault();
          dispatch({ type: 'highlight', index: idx });
        }
      } else if (key === 'Tab') {
        // Focus-trap: when only the container is focusable and there's
        // no open input, eat Tab so focus doesn't escape into the chat
        // window behind us. When the input IS open, the browser's default
        // tab behaviour cycles input ↔ submit-button correctly.
        if (state.openInputAt === null) e.preventDefault();
      }
    },
    [state, clamp, commitSelection, options.length, args],
  );

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = e.target.value;
      const idx = state.openInputAt;
      const opt = idx !== null ? options[idx] : undefined;
      // Re-run validation on every keystroke, but only SURFACE the error
      // if the user has already tried to submit once (state.inputError
      // is non-null then). Avoids yelling the moment the input opens.
      const err = opt?.input ? validateInput(opt.input, value.trim()) : null;
      dispatch({
        type: 'set-draft',
        value,
        error: state.inputError !== null ? err : null,
      });
    },
    [state.openInputAt, state.inputError, options, validateInput],
  );

  const onInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (state.openInputAt !== null) submitInput(state.openInputAt);
      } else if (e.key === 'Escape') {
        // Escape from a typed-in field closes the field but keeps the
        // prompt active (user can pick a different option). Two-step Esc
        // (close input, then close prompt) matches typical terminal UX.
        e.preventDefault();
        dispatch({ type: 'close-input' });
      }
    },
    [state.openInputAt, submitInput],
  );

  const onRowClick = useCallback(
    (idx: number) => (): void => {
      // Click = highlight + commit, both in one gesture. Mouse users
      // shouldn't have to "select then Enter".
      dispatch({ type: 'highlight', index: idx });
      commitSelection(idx);
    },
    [commitSelection],
  );

  const isHighlighted = useCallback((idx: number) => state.highlighted === idx, [state.highlighted]);
  const isInputOpen = useCallback((idx: number) => state.openInputAt === idx, [state.openInputAt]);
  const optionDomId = useCallback((idx: number) => `${idPrefix}-opt-${idx}`, [idPrefix]);

  return {
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
  };
}
