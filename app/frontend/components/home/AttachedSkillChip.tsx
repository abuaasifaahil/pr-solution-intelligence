'use client';
import type { JSX } from 'react';
import type { ComposableSkill } from '../../lib/composable-skills';
import { skillDisplayName } from '../../lib/composable-skills';

/**
 * M9.8 — small inline chip surfaced under the chat-creation form when the
 * user has pinned a composable-skill via `[+ Skill]`. The × button clears
 * the pin. Matches the design language of the wizard-chip group
 * (`ChatActionPrompt` chips) so the home page reads visually consistent
 * with the chat thread.
 *
 * @file components/home/AttachedSkillChip.tsx
 */

interface Props {
  skill: ComposableSkill;
  onRemove: () => void;
}

export function AttachedSkillChip({ skill, onRemove }: Props): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                 bg-win-blue-50 text-win-blue-600 border border-win-blue-100"
      data-testid={`attached-skill-${skill.id}`}
    >
      <span aria-hidden="true">🧩</span>
      <span>Skill: {skillDisplayName(skill)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${skillDisplayName(skill)} skill`}
        className="text-win-blue-600/70 hover:text-status-error-text ml-0.5"
      >
        ×
      </button>
    </span>
  );
}
