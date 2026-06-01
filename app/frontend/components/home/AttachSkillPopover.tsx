'use client';
import { useEffect, useState, type JSX } from 'react';
import {
  listComposableSkills,
  skillDescription,
  skillDisplayName,
  type ComposableSkill,
} from '../../lib/composable-skills';

/**
 * M9.8 — `[+ Skill]` popover for the chat-creation form. Lists every
 * composable-skill the caller can see (RLS handles visibility); groups
 * by scope so first-party platform defaults are visually distinct from
 * user-private skills the analyst has authored.
 *
 * Click → calls `onPick(skill)` and the parent closes the popover. The
 * popover lazy-loads on mount; future M10.5/M10.7 work can swap in a
 * ranked candidate list once the SkillComposer is online.
 *
 * @file components/home/AttachSkillPopover.tsx
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (skill: ComposableSkill) => void;
}

const SCOPE_LABEL: Record<ComposableSkill['scope'], string> = {
  first_party: 'Platform default',
  user_private: 'Your skills',
  workspace: 'Workspace',
  community: 'Community',
};

const SCOPE_ORDER: ComposableSkill['scope'][] = [
  'first_party',
  'user_private',
  'workspace',
  'community',
];

export function AttachSkillPopover({ open, onClose, onPick }: Props): JSX.Element | null {
  const [skills, setSkills] = useState<ComposableSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    listComposableSkills({ enabledOnly: true })
      .then((rows) => {
        setSkills(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load skills');
        setLoading(false);
      });
  }, [open]);

  if (!open) return null;

  // Group by scope, keeping a stable visual order.
  const grouped = SCOPE_ORDER.map((scope) => ({
    scope,
    rows: skills.filter((s) => s.scope === scope),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      {/* Click-outside scrim */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Attach a skill"
        data-testid="attach-skill-popover"
        className="absolute z-50 mt-2 w-[420px] max-h-[420px] overflow-auto
                   bg-surface-card border border-border-default rounded-lg shadow-win-8 p-3"
      >
        <div className="flex items-center justify-between mb-2 px-1">
          <h3 className="text-sm font-semibold text-text-primary">Attach a skill</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close skill picker"
            className="text-text-tertiary hover:text-text-primary text-sm"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="text-xs text-text-tertiary p-2">Loading skills…</div>
        )}
        {error && (
          <div role="alert" className="text-xs text-status-error-text p-2">
            {error}
          </div>
        )}
        {!loading && !error && skills.length === 0 && (
          <div className="text-xs text-text-tertiary p-2">
            No skills available. The platform's first-party skills will appear here once
            the seed runs.
          </div>
        )}

        {grouped.map(({ scope, rows }) => (
          <div key={scope} className="mb-3 last:mb-0">
            <div className="text-[0.65rem] uppercase tracking-wide font-semibold text-text-tertiary px-1 mb-1">
              {SCOPE_LABEL[scope]} ({rows.length})
            </div>
            <ul className="flex flex-col gap-1">
              {rows.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(s);
                      onClose();
                    }}
                    data-testid={`skill-pick-${s.id}`}
                    className="w-full text-left px-2.5 py-2 rounded-md hover:bg-surface-hover
                               border border-transparent hover:border-border-subtle transition"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {skillDisplayName(s)}
                      </span>
                      <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-surface-tertiary text-text-tertiary">
                        {s.kind.replace('_skill', '')}
                      </span>
                    </div>
                    {skillDescription(s) && (
                      <p className="text-xs text-text-secondary line-clamp-2 mt-0.5">
                        {skillDescription(s)}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
