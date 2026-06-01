'use client';
import { useState } from 'react';
import {
  createComposableSkill,
  updateComposableSkill,
  type SkillKind,
  type ComposableSkill,
} from '../../lib/composable-skills';

/**
 * M9.9 — minimal create/edit form for a `composable_skill` row scoped
 * to the caller (ADR-0003 Decision 4 + ADR-0002).
 *
 * The full skill-manifest editor (with JSONSchema validation for each
 * `kind`) is a Phase 5.5 / M10.5 deliverable. This M9.9 surface ships
 * the lowest-friction authoring path:
 *   - name (snake_case enforced by backend Zod)
 *   - kind (analysis | source | enrichment | tool | alert | external)
 *   - description
 *   - raw manifest as JSON in a textarea, validated as JSON-parseable
 *     before submit; backend Zod rejects malformed manifests with 400.
 *
 * @file components/settings/NewComposableSkillModal.tsx
 */

const KIND_OPTIONS: { value: SkillKind; label: string }[] = [
  { value: 'analysis_skill', label: 'analysis_skill' },
  { value: 'source_skill', label: 'source_skill' },
  { value: 'enrichment_skill', label: 'enrichment_skill' },
  { value: 'tool_skill', label: 'tool_skill' },
  { value: 'alert_skill', label: 'alert_skill' },
  { value: 'external_skill', label: 'external_skill' },
];

const DEFAULT_MANIFEST = `{
  "description": "What this skill does",
  "model_family": "gpt-4-tier"
}`;

export function NewComposableSkillModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: ComposableSkill | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}): JSX.Element {
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<SkillKind>(existing?.kind ?? 'analysis_skill');
  const [description, setDescription] = useState(
    typeof (existing?.manifest as { description?: unknown })?.description ===
      'string'
      ? ((existing?.manifest as { description?: string }).description ?? '')
      : '',
  );
  const [manifestText, setManifestText] = useState(
    existing ? JSON.stringify(existing.manifest, null, 2) : DEFAULT_MANIFEST,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(manifestText) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error('Manifest must be a JSON object.');
      }
      manifest = parsed as Record<string, unknown>;
    } catch (err) {
      setError(`Manifest is not valid JSON: ${(err as Error).message}`);
      return;
    }
    // Merge the visible "description" field into the manifest under the
    // ADR-0002 conventional key — keeps the M9.8 attach popover etc.
    // surfaces consistent.
    if (description.trim()) {
      manifest.description = description.trim();
    }

    setBusy(true);
    try {
      if (existing) {
        await updateComposableSkill(existing.id, {
          name: name.trim(),
          kind,
          manifest,
        });
      } else {
        await createComposableSkill({
          name: name.trim(),
          kind,
          manifest,
          scope: 'user_private',
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="new-composable-skill-modal"
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
    >
      <div className="bg-white rounded-lg p-5 w-[520px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-bold mb-3">
          {existing ? 'Edit private skill' : 'New private skill'}
        </h2>

        <label className="block text-xs font-semibold mb-1">Name (snake_case)</label>
        <input
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="cs-name-input"
          placeholder="my_csv_cleanup"
        />

        <label className="block text-xs font-semibold mb-1">Kind</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SkillKind)}
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          data-testid="cs-kind-select"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="block text-xs font-semibold mb-1">Description</label>
        <textarea
          rows={2}
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="cs-description-input"
          placeholder="What this skill does (merged into manifest.description)"
        />

        <label className="block text-xs font-semibold mb-1">
          Manifest (JSON object)
        </label>
        <textarea
          rows={8}
          spellCheck={false}
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-xs font-mono"
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
          data-testid="cs-manifest-input"
        />
        <div className="text-[0.7rem] text-text-tertiary mb-3">
          Full JSONSchema-validated authoring ships in Phase 5.5 (M10.5).
          For now: any well-formed JSON object is accepted.
        </div>

        {error && (
          <div className="text-xs text-status-error-text mb-2" role="alert">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            data-testid="cs-submit"
            className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded
                       hover:bg-win-blue-600 disabled:opacity-50"
          >
            {existing ? 'Save changes' : 'Create skill'}
          </button>
        </div>
      </div>
    </div>
  );
}
