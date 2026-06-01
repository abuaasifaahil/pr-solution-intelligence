'use client';
import { useState } from 'react';
import {
  createUserAgent,
  updateUserAgent,
  type AgentKind,
  type CreateUserAgentInput,
  type UpdateUserAgentInput,
  type UserAgent,
} from '../../lib/user-agents';

/**
 * M9.9 — modal for creating or editing a per-user `user_agent` row
 * (ADR-0003 Decision 4). The "customization" JSONB bag is constrained
 * here to a known shape: { description, defaults?: {brand, mediaTypes,
 * intention, enrichmentType} } — matches the M9.9 spec wireframe.
 *
 * Edits a row when `existing` is supplied; creates one otherwise. The
 * caller (`AgentListSection`) controls open/close.
 *
 * @file components/settings/NewUserAgentModal.tsx
 */

const BASE_AGENT_OPTIONS: { value: AgentKind; label: string; description: string }[] = [
  { value: 'pr_impact', label: 'PR Impact', description: 'Sentiment + reach for a brand' },
  {
    value: 'brand_sentinel',
    label: 'Brand Sentinel',
    description: 'Watch brand mentions across sources',
  },
  {
    value: 'crisis_watch',
    label: 'Crisis Watch',
    description: 'Spike detection + crisis cues',
  },
  {
    value: 'competitor_tracker',
    label: 'Competitor Tracker',
    description: 'Comparative coverage by competitor',
  },
];

const MEDIA_TYPE_CHIPS: { value: string; label: string }[] = [
  { value: 'print', label: 'Print' },
  { value: 'online', label: 'Online' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'social_facebook', label: 'Facebook' },
  { value: 'x_twitter', label: 'X (Twitter)' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'reddit', label: 'Reddit' },
];

interface UserAgentCustomization {
  description: string;
  defaults?: {
    brand?: string;
    mediaTypes?: string[];
    intention?: 'intention_based' | 'comment_based';
    enrichmentType?: 'standard' | 'reach';
  };
}

function readCustomization(
  existing: UserAgent | null,
): UserAgentCustomization {
  if (!existing) return { description: '' };
  const c = existing.customization as unknown as
    | Partial<UserAgentCustomization>
    | undefined;
  return {
    description: typeof c?.description === 'string' ? c.description : '',
    defaults: c?.defaults,
  };
}

export function NewUserAgentModal({
  existing,
  onClose,
  onSaved,
}: {
  /** When supplied → edit mode. Else → create. */
  existing: UserAgent | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}): JSX.Element {
  const initialCustomization = readCustomization(existing);

  const [name, setName] = useState(existing?.name ?? '');
  const [baseAgentKind, setBaseAgentKind] = useState<AgentKind>(
    existing?.baseAgentKind ?? 'pr_impact',
  );
  const [description, setDescription] = useState(initialCustomization.description);
  const [brand, setBrand] = useState(initialCustomization.defaults?.brand ?? '');
  const [mediaTypes, setMediaTypes] = useState<Set<string>>(
    new Set(initialCustomization.defaults?.mediaTypes ?? []),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleMedia(v: string): void {
    setMediaTypes((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!description.trim()) {
      setError('Description is required.');
      return;
    }
    const customization: UserAgentCustomization = {
      description: description.trim(),
      defaults: {
        ...(brand.trim() ? { brand: brand.trim() } : {}),
        ...(mediaTypes.size > 0 ? { mediaTypes: Array.from(mediaTypes) } : {}),
      },
    };
    // Strip empty `defaults` to keep the JSONB compact.
    if (
      customization.defaults &&
      Object.keys(customization.defaults).length === 0
    ) {
      delete customization.defaults;
    }

    setBusy(true);
    try {
      if (existing) {
        const patch: UpdateUserAgentInput = {
          name: name.trim(),
          baseAgentKind,
          customization: customization as unknown as Record<string, unknown>,
        };
        await updateUserAgent(existing.id, patch);
      } else {
        const input: CreateUserAgentInput = {
          name: name.trim(),
          baseAgentKind,
          customization: customization as unknown as Record<string, unknown>,
        };
        await createUserAgent(input);
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
      data-testid="new-user-agent-modal"
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
    >
      <div className="bg-white rounded-lg p-5 w-[520px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-bold mb-3">
          {existing ? 'Edit private agent' : 'New private agent'}
        </h2>

        <label className="block text-xs font-semibold mb-1">Name</label>
        <input
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="ua-name-input"
          placeholder="My Beverage Tracker"
        />

        <span className="block text-xs font-semibold mb-1">Based on</span>
        <div className="grid gap-1.5 mb-3">
          {BASE_AGENT_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex items-start gap-2 p-2 border rounded cursor-pointer
                ${baseAgentKind === o.value
                  ? 'border-win-blue-500 bg-win-blue-50'
                  : 'border-border-default hover:bg-surface-hover'}`}
            >
              <input
                type="radio"
                name="ua-base"
                value={o.value}
                checked={baseAgentKind === o.value}
                onChange={() => setBaseAgentKind(o.value)}
                className="mt-0.5"
                data-testid={`ua-base-${o.value}`}
              />
              <div>
                <div className="text-sm font-semibold">{o.label}</div>
                <div className="text-[0.7rem] text-text-secondary">
                  {o.description}
                </div>
              </div>
            </label>
          ))}
        </div>

        <label className="block text-xs font-semibold mb-1">Description</label>
        <textarea
          rows={2}
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="ua-description-input"
          placeholder="Customized PR Impact for beverage SKUs"
        />

        <label className="block text-xs font-semibold mb-1">
          Default brand (optional)
        </label>
        <input
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          data-testid="ua-brand-input"
          placeholder="e.g. FreshSip"
        />

        <span className="block text-xs font-semibold mb-1">
          Default media types (optional)
        </span>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {MEDIA_TYPE_CHIPS.map((c) => {
            const active = mediaTypes.has(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggleMedia(c.value)}
                data-testid={`ua-media-${c.value}`}
                className={`px-2.5 py-1 text-xs rounded-full font-sans transition-colors
                  ${active
                    ? 'bg-win-blue-500 text-text-inverse'
                    : 'bg-surface-hover text-text-secondary hover:bg-surface-active'}`}
              >
                {c.label}
              </button>
            );
          })}
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
            data-testid="ua-submit"
            className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded
                       hover:bg-win-blue-600 disabled:opacity-50"
          >
            {existing ? 'Save changes' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
