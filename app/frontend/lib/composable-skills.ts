'use client';
import { apiFetch } from './api-client';

/**
 * M9.8 (Phase 3.5) — Frontend typed client for the composable_skills
 * endpoints shipped by M9.7. Mirrors the backend Zod schemas in
 * `backend/src/services/composable-skill.service.ts`.
 *
 *   GET    /api/v1/composable-skills              — list visible skills
 *   POST   /api/v1/composable-skills              — create (scope=user_private)
 *   PATCH  /api/v1/composable-skills/:skillId     — partial update
 *   DELETE /api/v1/composable-skills/:skillId     — hard delete
 *
 * RLS guarantees visibility on the read side; the route layer enforces
 * scope rules on writes. The Phase 5.5 SkillComposer + the M9.8 chat-
 * entry attach popover both consume this client.
 *
 * @file lib/composable-skills.ts
 */

export type SkillKind =
  | 'analysis_skill'
  | 'source_skill'
  | 'enrichment_skill'
  | 'tool_skill'
  | 'alert_skill'
  | 'external_skill';

export type SkillScope =
  | 'first_party'
  | 'workspace'
  | 'user_private'
  | 'community';

export type TrustLevel = 'first_party' | 'verified' | 'community';

export interface ComposableSkill {
  id: string;
  name: string;
  version: string;
  kind: SkillKind;
  /** Free-form JSONB. The Phase 5.5 SkillComposer reads this; the UI
   *  surfaces a `description` / `displayName` when present. */
  manifest: Record<string, unknown>;
  scope: SkillScope;
  /** Null for first_party + community rows. */
  userId: string | null;
  workspaceId: string | null;
  trustLevel: TrustLevel;
  enabled: boolean;
  createdAt: string;
}

export interface CreateSkillInput {
  name: string;
  version?: string;
  kind: SkillKind;
  manifest: Record<string, unknown>;
  /** Service-layer guard: only `user_private` is accepted on create. */
  scope: SkillScope;
}

export interface UpdateSkillInput {
  name?: string;
  version?: string;
  kind?: SkillKind;
  manifest?: Record<string, unknown>;
}

export interface ListSkillsOpts {
  scope?: SkillScope;
  kind?: SkillKind;
  enabledOnly?: boolean;
}

export async function listComposableSkills(
  opts: ListSkillsOpts = {},
): Promise<ComposableSkill[]> {
  const params = new URLSearchParams();
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.enabledOnly !== undefined) {
    params.set('enabledOnly', opts.enabledOnly ? 'true' : 'false');
  }
  const qs = params.toString();
  return apiFetch<ComposableSkill[]>(
    `/api/v1/composable-skills${qs ? `?${qs}` : ''}`,
  );
}

export async function createComposableSkill(
  input: CreateSkillInput,
): Promise<ComposableSkill> {
  return apiFetch<ComposableSkill>('/api/v1/composable-skills', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateComposableSkill(
  skillId: string,
  patch: UpdateSkillInput,
): Promise<ComposableSkill> {
  return apiFetch<ComposableSkill>(
    `/api/v1/composable-skills/${encodeURIComponent(skillId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteComposableSkill(skillId: string): Promise<void> {
  await apiFetch(`/api/v1/composable-skills/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
  });
}

/**
 * Convenience accessor — many UIs (M9.8 AttachSkillPopover, M9.9 settings
 * tab) want a quick "human-readable label" for a skill without re-deriving
 * it from `manifest.displayName` everywhere. Falls back to the row name
 * when no display name is set in the manifest.
 */
export function skillDisplayName(skill: ComposableSkill): string {
  const dn = (skill.manifest as { displayName?: unknown }).displayName;
  return typeof dn === 'string' && dn.length > 0 ? dn : skill.name;
}

export function skillDescription(skill: ComposableSkill): string | null {
  const desc = (skill.manifest as { description?: unknown }).description;
  return typeof desc === 'string' && desc.length > 0 ? desc : null;
}
