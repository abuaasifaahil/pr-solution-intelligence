'use client';
import { useEffect, useState } from 'react';
import {
  listComposableSkills,
  deleteComposableSkill,
  skillDisplayName,
  skillDescription,
  type ComposableSkill,
} from '../../lib/composable-skills';
import { NewComposableSkillModal } from './NewComposableSkillModal';

/**
 * M9.9 — Skills section inside the "My Agents & Skills" tab.
 *
 * Lists `composable_skills` visible to the user (first-party rows are
 * read-only; `user_private` rows are full-CRUD). The list is fetched
 * once and partitioned client-side by `scope`.
 *
 * Workspace + community scopes are pass-through read-only — workspace
 * sharing UI is a Phase 6 deliverable.
 *
 * @file components/settings/SkillListSection.tsx
 */
export function SkillListSection(): JSX.Element {
  const [skills, setSkills] = useState<ComposableSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; skill: ComposableSkill } | null
  >(null);

  useEffect(() => {
    void listComposableSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, []);

  async function reload(): Promise<void> {
    const next = await listComposableSkills();
    setSkills(next);
  }

  async function remove(skill: ComposableSkill): Promise<void> {
    if (!confirm(`Delete "${skillDisplayName(skill)}"? This cannot be undone.`)) {
      return;
    }
    await deleteComposableSkill(skill.id);
    await reload();
  }

  const firstParty = skills.filter((s) => s.scope === 'first_party');
  const mine = skills.filter((s) => s.scope === 'user_private');
  const other = skills.filter(
    (s) => s.scope !== 'first_party' && s.scope !== 'user_private',
  );

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold">
          Skills{' '}
          <span className="text-xs font-normal text-text-tertiary">
            ({firstParty.length} first-party{mine.length > 0 ? ` + ${mine.length} yours` : ''})
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setModal({ mode: 'create' })}
          data-testid="new-composable-skill-button"
          className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                     hover:bg-win-blue-600"
        >
          + New skill
        </button>
      </div>

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}

      <div className="grid gap-2">
        {firstParty.map((s) => (
          <SkillRow key={s.id} skill={s} editable={false} />
        ))}
        {mine.map((s) => (
          <SkillRow
            key={s.id}
            skill={s}
            editable
            onEdit={() => setModal({ mode: 'edit', skill: s })}
            onDelete={() => void remove(s)}
          />
        ))}
        {other.map((s) => (
          <SkillRow key={s.id} skill={s} editable={false} />
        ))}
        {!loading && skills.length === 0 && (
          <div className="text-sm text-text-tertiary border border-dashed border-border-default
                          rounded-md p-6 text-center">
            No skills available yet. Click <strong>+ New skill</strong> to author one.
          </div>
        )}
      </div>

      {modal && (
        <NewComposableSkillModal
          existing={modal.mode === 'edit' ? modal.skill : null}
          onClose={() => setModal(null)}
          onSaved={reload}
        />
      )}
    </section>
  );
}

function SkillRow({
  skill,
  editable,
  onEdit,
  onDelete,
}: {
  skill: ComposableSkill;
  editable: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const display = skillDisplayName(skill);
  const desc = skillDescription(skill);
  const badgeClass =
    skill.scope === 'first_party'
      ? 'bg-surface-tertiary text-text-secondary'
      : skill.scope === 'user_private'
        ? 'bg-win-blue-50 text-win-blue-600'
        : 'bg-surface-hover text-text-secondary';
  const badgeLabel =
    skill.scope === 'first_party'
      ? 'first-party'
      : skill.scope === 'user_private'
        ? 'yours'
        : skill.scope;

  return (
    <div className="flex items-center gap-3 border border-border-default rounded-lg p-3 bg-white">
      <div className="w-8 h-8 rounded-md bg-win-blue-50 text-win-blue-600 font-bold
                      flex items-center justify-center uppercase text-sm">
        {display[0] ?? '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate font-mono">{skill.name}</div>
        <div className="text-xs text-text-secondary truncate">
          {skill.kind}
          {desc ? ` — ${desc}` : ''}
        </div>
      </div>
      <span
        className={`text-[0.65rem] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${badgeClass}`}
      >
        {badgeLabel}
      </span>
      {editable && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid={`cs-edit-${skill.id}`}
            onClick={onEdit}
            className="px-2 py-1 text-xs rounded hover:bg-surface-hover"
            aria-label={`Edit ${display}`}
          >
            edit
          </button>
          <button
            type="button"
            data-testid={`cs-delete-${skill.id}`}
            onClick={onDelete}
            className="px-2 py-1 text-xs rounded text-status-error-text hover:bg-status-error-bg"
            aria-label={`Delete ${display}`}
          >
            delete
          </button>
          <button
            type="button"
            disabled
            title="Sharing to workspace is coming in Phase 6"
            className="px-2 py-1 text-xs rounded text-text-tertiary opacity-60 cursor-not-allowed"
            aria-label="Share to workspace (coming in Phase 6)"
          >
            share
          </button>
        </div>
      )}
    </div>
  );
}
