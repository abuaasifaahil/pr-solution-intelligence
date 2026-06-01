'use client';
import { useState, type JSX } from 'react';
import { BrandInput } from './BrandInput';
import { CompetitorTags } from './CompetitorTags';
import { CustomDatePicker } from './CustomDatePicker';
import type {
  ChipOption,
  ProbableField,
  Probe,
  ProbeResolution,
} from '../../lib/probe';

/**
 * M9.8 — per-field renderers for the ProbingResultCard. Each field has
 * its own input style:
 *
 *   - brand            → BrandInput (re-used from Phase 2 wizard)
 *   - competitors      → CompetitorTags (re-used; "custom" mode)
 *   - dateRange        → CustomDatePicker (re-used)
 *   - enrichmentType   → 2 chip buttons ("Enrichment" / "Enrichment + reach")
 *   - intention        → 2 chip buttons ("Intention-based" / "Comment-based")
 *   - mediaTypes       → chip-multi-select (free-text disabled)
 *   - language         → chip selector + free-text input
 *
 * Each renderer calls `onResolve(resolution)` which the parent uses to
 * POST /probe/resolve. The card itself owns the loading + remaining-probe
 * state.
 *
 * @file components/chat/ProbingResultCard.fields.tsx
 */

interface FieldEditorProps {
  probe: Probe;
  /** Single resolution payload to submit. */
  onResolve: (resolution: ProbeResolution) => void;
  onCancel?: () => void;
  busy?: boolean;
}

export function FieldEditor({ probe, onResolve, onCancel, busy }: FieldEditorProps): JSX.Element {
  switch (probe.field) {
    case 'brand':
      return <BrandFieldEditor probe={probe} onResolve={onResolve} busy={busy} />;
    case 'competitors':
      return <CompetitorsFieldEditor probe={probe} onResolve={onResolve} busy={busy} />;
    case 'dateRange':
      return (
        <DateRangeFieldEditor
          probe={probe}
          onResolve={onResolve}
          onCancel={onCancel}
          busy={busy}
        />
      );
    case 'mediaTypes':
      return <MediaTypesFieldEditor probe={probe} onResolve={onResolve} busy={busy} />;
    case 'enrichmentType':
    case 'intention':
    case 'language':
      return (
        <ChipChoiceEditor probe={probe} onResolve={onResolve} busy={busy} />
      );
  }
}

function BrandFieldEditor({ probe, onResolve, busy }: FieldEditorProps): JSX.Element {
  // If we have chip suggestions, surface them above the input so the
  // user can pick without typing.
  return (
    <div className="flex flex-col gap-2">
      {probe.chips.length > 0 && (
        <ChipRow
          chips={probe.chips}
          onPick={(c) => onResolve({ field: 'brand', value: c.value })}
          disabled={busy}
          testIdPrefix="brand-chip"
        />
      )}
      <BrandInput onSubmit={(v) => onResolve({ field: 'brand', value: v })} />
    </div>
  );
}

function CompetitorsFieldEditor({ probe, onResolve, busy }: FieldEditorProps): JSX.Element {
  // CompetitorTags takes a `brand` for prompt copy — we don't always
  // have one here so fall back to a generic placeholder.
  return (
    <div className="flex flex-col gap-2">
      {probe.chips.length > 0 && (
        <div className="text-xs text-text-tertiary">
          Pick one or more to set the list, or add your own below.
        </div>
      )}
      <CompetitorTags
        brand={'the brand'}
        suggestions={null}
        defaultCompetitors={probe.chips.map((c) => c.value)}
        defaultSet="custom"
        onSubmit={(competitors) =>
          onResolve({ field: 'competitors', value: competitors })
        }
      />
    </div>
  );
}

function DateRangeFieldEditor({
  onResolve,
  onCancel,
  busy: _busy,
}: FieldEditorProps): JSX.Element {
  return (
    <CustomDatePicker
      onSubmit={(start, end) =>
        onResolve({
          field: 'dateRange',
          value: {
            start: start.toISOString(),
            end: end.toISOString(),
          },
        })
      }
      onCancel={onCancel}
    />
  );
}

const MEDIA_TYPE_CHIPS: ChipOption[] = [
  { value: 'print', label: 'Print' },
  { value: 'online', label: 'Online' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'social_facebook', label: 'Facebook' },
  { value: 'x_twitter', label: 'X (Twitter)' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
];

function MediaTypesFieldEditor({ probe, onResolve, busy }: FieldEditorProps): JSX.Element {
  const baseChips = probe.chips.length > 0 ? probe.chips : MEDIA_TYPE_CHIPS;
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function toggle(v: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {baseChips.map((c) => {
          const active = picked.has(c.value);
          return (
            <button
              key={c.value}
              type="button"
              onClick={() => toggle(c.value)}
              disabled={busy}
              data-testid={`media-chip-${c.value}`}
              className={[
                'px-2.5 py-1 text-xs rounded-full font-sans transition-colors',
                active
                  ? 'bg-win-blue-500 text-text-inverse'
                  : 'bg-surface-hover text-text-secondary hover:bg-surface-active',
                'disabled:opacity-50',
              ].join(' ')}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() =>
            onResolve({
              field: 'mediaTypes',
              value: Array.from(picked),
            })
          }
          disabled={busy || picked.size === 0}
          className="px-3 py-1.5 text-xs font-sans rounded-sm bg-win-blue-500 text-text-inverse
                     hover:bg-win-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** Chip group rendered as a single-pick (enum) input — used for
 *  enrichmentType / intention / language. */
function ChipChoiceEditor({ probe, onResolve, busy }: FieldEditorProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <ChipRow
        chips={probe.chips}
        onPick={(c) =>
          onResolve({
            field: probe.field,
            value: c.value,
          })
        }
        disabled={busy}
        testIdPrefix={`${probe.field}-chip`}
      />
      {probe.allowFreeText && (
        <FreeTextResolve
          field={probe.field}
          onResolve={onResolve}
          disabled={busy}
        />
      )}
    </div>
  );
}

interface ChipRowProps {
  chips: ChipOption[];
  onPick: (c: ChipOption) => void;
  disabled?: boolean;
  testIdPrefix: string;
}

function ChipRow({ chips, onPick, disabled, testIdPrefix }: ChipRowProps): JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onPick(c)}
          disabled={disabled}
          data-testid={`${testIdPrefix}-${c.value}`}
          className="px-2.5 py-1 text-xs rounded-full font-sans transition-colors
                     bg-surface-hover text-text-secondary hover:bg-win-blue-50 hover:text-win-blue-600
                     disabled:opacity-50"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

interface FreeTextResolveProps {
  field: ProbableField;
  onResolve: (resolution: ProbeResolution) => void;
  disabled?: boolean;
}

function FreeTextResolve({ field, onResolve, disabled }: FreeTextResolveProps): JSX.Element {
  const [v, setV] = useState('');
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Or type your own"
        disabled={disabled}
        className="flex-1 text-xs px-2 py-1 rounded-sm border border-border-default bg-surface-base
                   focus:outline-none focus:ring-2 focus:ring-win-blue-500 disabled:opacity-50"
        aria-label={`${field} free-text value`}
      />
      <button
        type="button"
        onClick={() => {
          const trimmed = v.trim();
          if (trimmed.length === 0) return;
          onResolve({ field, value: trimmed });
        }}
        disabled={disabled || v.trim().length === 0}
        className="px-2.5 py-1 text-xs rounded-sm bg-surface-hover text-text-primary
                   hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Set
      </button>
    </div>
  );
}
