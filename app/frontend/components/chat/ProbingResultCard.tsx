'use client';
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  getProbe,
  resolveProbes,
  type ProbableField,
  type Probe,
  type ProbeResolution,
  type ProbingResult,
} from '../../lib/probe';
import type { ChatParams } from '../../lib/chat-params';
import { FieldEditor } from './ProbingResultCard.fields';

/**
 * M9.8 — ProbingResultCard. Renders inline in the chat thread when:
 *
 *   - the WS emits `intent:extracted` (M9.4 IntentExtractor, optional —
 *     this card supersedes the legacy IntentExtractedCard sketch in
 *     ADR-0003 §M9.8) OR
 *   - the WS emits `reach:absent` (M9.5.5 reach-probe path) OR
 *   - the caller passes a seed `initialResult`
 *
 * Behavior: shows what the prober inferred (✓ filled fields), shows
 * the probes for unfilled fields, and lets the user resolve via
 * per-field editors (re-uses the wizard inputs BrandInput,
 * CompetitorTags, CustomDatePicker).
 *
 * Resolutions POST to `/chats/:id/probe/resolve`; the server returns
 * the new params + remaining probes and we re-render.
 *
 * "Looks good" closes the card; "Start over" re-runs `GET /probe` to
 * pull a fresh classifier result.
 *
 * @file components/chat/ProbingResultCard.tsx
 */

interface Props {
  chatId: string;
  /** When provided, the card mounts pre-populated and skips the initial
   *  GET — useful when the WS event already carries the result. */
  initialResult?: ProbingResult | null;
  /** Called when the user clicks "Looks good — continue" or when every
   *  probe has been resolved. */
  onDone?: (params: Partial<ChatParams> | null) => void;
  /** Called when the user dismisses the card. */
  onDismiss?: () => void;
}

const FIELD_LABELS: Record<ProbableField, string> = {
  brand: 'Brand',
  competitors: 'Competitors',
  dateRange: 'Date range',
  mediaTypes: 'Media types',
  language: 'Language',
  intention: 'Intention',
  enrichmentType: 'Enrichment level',
};

function formatInferredValue(
  field: ProbableField,
  inferred: Partial<ChatParams>,
): string | null {
  switch (field) {
    case 'brand':
      return inferred.brand ?? null;
    case 'competitors':
      return inferred.competitors && inferred.competitors.length > 0
        ? inferred.competitors.join(', ')
        : null;
    case 'dateRange':
      if (!inferred.dateStart || !inferred.dateEnd) return null;
      return `${inferred.dateStart.slice(0, 10)} → ${inferred.dateEnd.slice(0, 10)}`;
    case 'intention':
      return inferred.intention === 'intention_based'
        ? 'Intention-based'
        : inferred.intention === 'comment_based'
          ? 'Comment-based'
          : null;
    case 'enrichmentType':
      return inferred.enrichmentType === 'reach'
        ? 'Enrichment + reach'
        : inferred.enrichmentType === 'standard'
          ? 'Enrichment'
          : null;
    case 'mediaTypes':
      // `mediaTypes` lives on the chat_params row but isn't typed here;
      // we don't display it as an inferred row in this surface (the
      // wizard handles media types separately). Future M9.8.x can wire.
      return null;
    case 'language':
      return null;
  }
}

export function ProbingResultCard({
  chatId,
  initialResult,
  onDone,
  onDismiss,
}: Props): JSX.Element {
  const [result, setResult] = useState<ProbingResult | null>(initialResult ?? null);
  const [loading, setLoading] = useState(initialResult == null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<ProbableField | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Initial fetch when we don't have a seed result.
  useEffect(() => {
    if (initialResult !== undefined && initialResult !== null) return;
    if (initialResult === null && result !== null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProbe(chatId)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load probe');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const inferredEntries = useMemo<Array<{ field: ProbableField; value: string }>>(() => {
    if (!result) return [];
    const fields: ProbableField[] = [
      'brand',
      'dateRange',
      'intention',
      'competitors',
      'enrichmentType',
    ];
    return fields
      .map((field) => ({
        field,
        value: formatInferredValue(field, result.inferred) ?? '',
      }))
      .filter((e) => e.value.length > 0);
  }, [result]);

  async function applyResolution(resolution: ProbeResolution): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await resolveProbes(chatId, [resolution]);
      // Re-shape into a ProbingResult-like seed; the next render will
      // show the remaining probes + the new inferred bag derived from
      // updatedParams.
      setResult((prev) => ({
        inferred: extractInferredFromParams(next.updatedParams),
        confidence: prev?.confidence ?? {},
        probes: next.remainingProbes,
        rationale: prev?.rationale ?? '',
        perSourceStats: prev?.perSourceStats ?? [],
      }));
      setEditingField(null);
      if (next.remainingProbes.length === 0 && onDone) {
        onDone(extractInferredFromParams(next.updatedParams));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply resolution');
    } finally {
      setBusy(false);
    }
  }

  function handleStartOver(): void {
    setEditingField(null);
    setLoading(true);
    setError(null);
    getProbe(chatId)
      .then((r) => {
        setResult(r);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to reload');
        setLoading(false);
      });
  }

  function handleLooksGood(): void {
    setDismissed(true);
    if (onDone) onDone(result?.inferred ?? null);
  }

  if (dismissed) return <></>;

  return (
    <div
      data-testid="probing-result-card"
      className="w-full max-w-2xl bg-surface-card border border-border-default rounded-lg
                 shadow-win-2 overflow-hidden"
    >
      <header className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">⚡</span>
          <h3 className="text-sm font-semibold text-text-primary">
            Detected from your message
          </h3>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              onDismiss();
            }}
            aria-label="Dismiss probe card"
            className="text-text-tertiary hover:text-text-primary text-sm"
          >
            ×
          </button>
        )}
      </header>

      <div className="px-4 py-3 flex flex-col gap-2.5">
        {loading && (
          <div className="text-xs text-text-tertiary">Classifying attached sources…</div>
        )}
        {error && (
          <div role="alert" className="text-xs text-status-error-text">
            {error}
          </div>
        )}

        {result && result.rationale.length > 0 && (
          <p className="text-xs text-text-secondary italic">{result.rationale}</p>
        )}

        {/* Inferred / filled rows */}
        {inferredEntries.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {inferredEntries.map((entry) => (
              <li
                key={entry.field}
                className="flex items-center justify-between text-sm"
                data-testid={`inferred-${entry.field}`}
              >
                <span className="text-text-primary">
                  <span className="text-status-success-text mr-1.5" aria-hidden="true">✓</span>
                  <span className="font-medium">{FIELD_LABELS[entry.field]}:</span>{' '}
                  <span className="text-text-secondary">{entry.value}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditingField(entry.field)}
                  disabled={busy}
                  data-testid={`edit-${entry.field}`}
                  className="text-xs text-win-blue-600 hover:text-win-blue-700 disabled:opacity-50"
                >
                  edit ✎
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Probes for unfilled fields */}
        {result && result.probes.length > 0 && (
          <div className="flex flex-col gap-3 mt-1">
            <div className="text-xs font-semibold text-status-warning-text">
              ⚠ Still need: {result.probes.map((p) => FIELD_LABELS[p.field]).join(', ')}
            </div>
            {result.probes.map((p) => (
              <ProbeSection
                key={p.field}
                probe={p}
                onResolve={(r) => void applyResolution(r)}
                busy={busy}
              />
            ))}
          </div>
        )}

        {/* Inline editor for a "filled" field the user clicked edit on */}
        {editingField && (
          <div
            className="border-t border-border-subtle pt-3 mt-2"
            data-testid={`field-editor-${editingField}`}
          >
            <div className="text-xs font-semibold text-text-primary mb-2">
              Edit {FIELD_LABELS[editingField]}
            </div>
            <FieldEditor
              probe={syntheticProbeFor(editingField, result)}
              onResolve={(r) => void applyResolution(r)}
              onCancel={() => setEditingField(null)}
              busy={busy}
            />
          </div>
        )}
      </div>

      <footer className="px-4 py-2.5 border-t border-border-subtle flex justify-end gap-2">
        <button
          type="button"
          onClick={handleStartOver}
          disabled={busy || loading}
          data-testid="start-over-btn"
          className="px-3 py-1.5 text-xs rounded-sm font-sans text-text-secondary
                     hover:text-text-primary disabled:opacity-50"
        >
          Start over
        </button>
        <button
          type="button"
          onClick={handleLooksGood}
          disabled={busy || loading}
          data-testid="looks-good-btn"
          className="px-3 py-1.5 text-xs rounded-sm font-sans bg-win-blue-500 text-text-inverse
                     hover:bg-win-blue-600 disabled:opacity-50"
        >
          Looks good — continue
        </button>
      </footer>
    </div>
  );
}

interface ProbeSectionProps {
  probe: Probe;
  onResolve: (resolution: ProbeResolution) => void;
  busy?: boolean;
}

function ProbeSection({ probe, onResolve, busy }: ProbeSectionProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`probe-section-${probe.field}`}
    >
      <div className="text-sm text-text-primary">{probe.question}</div>
      {probe.rationale.length > 0 && (
        <div className="text-xs text-text-tertiary italic">{probe.rationale}</div>
      )}
      <FieldEditor probe={probe} onResolve={onResolve} busy={busy} />
    </div>
  );
}

/** When the user clicks `edit ✎` on an already-filled row, we synthesize
 *  a Probe shape so the same FieldEditor handles both surfaces. The
 *  synthetic probe uses no chips + free-text on (so the user can fully
 *  override). */
function syntheticProbeFor(
  field: ProbableField,
  result: ProbingResult | null,
): Probe {
  const inferred = result?.inferred;
  const chips = field === 'brand' && inferred?.brand
    ? [{ value: inferred.brand, label: inferred.brand }]
    : [];
  return {
    field,
    question: `Edit ${FIELD_LABELS[field]}`,
    chips,
    allowFreeText: true,
    rationale: '',
  };
}

/** Best-effort projection from a full ChatParams onto the ProbableField
 *  subset the card cares about. Used after a successful resolve. */
function extractInferredFromParams(
  params: ChatParams,
): Partial<ChatParams> {
  const out: Partial<ChatParams> = {};
  if (params.brand) out.brand = params.brand;
  if (params.competitors && params.competitors.length > 0) {
    out.competitors = params.competitors;
  }
  if (params.dateStart) out.dateStart = params.dateStart;
  if (params.dateEnd) out.dateEnd = params.dateEnd;
  if (params.intention) out.intention = params.intention;
  if (params.enrichmentType) out.enrichmentType = params.enrichmentType;
  return out;
}
