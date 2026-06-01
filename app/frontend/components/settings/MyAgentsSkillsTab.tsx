'use client';
import { AgentListSection } from './AgentListSection';
import { SkillListSection } from './SkillListSection';

/**
 * M9.9 (Phase 3.5) — "My Agents & Skills" settings tab.
 *
 * Surfaces ADR-0003 Decision 4 (per-user authoring) in the UI:
 *   - Agents section combines first-party (`/api/v1/agents`) with the
 *     caller's `user_agents` rows (`/api/v1/me/agents`).
 *   - Skills section combines first-party + user-private
 *     `composable_skills`.
 *   - Both sections own their own state, fetch, and modals.
 *
 * Phase 6 will add the [⤴ Share to workspace] CTA — buttons exist but
 * are disabled today (tooltip explains).
 *
 * @file components/settings/MyAgentsSkillsTab.tsx
 */
export function MyAgentsSkillsTab(): JSX.Element {
  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-xl font-bold">My Agents &amp; Skills</h1>
        <p className="text-sm text-text-secondary">
          First-party agents and skills are read-only. Anything you author
          stays private to you until an admin promotes it to your workspace
          (Phase 6).
        </p>
      </div>

      <AgentListSection />
      <SkillListSection />
    </div>
  );
}
