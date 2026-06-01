'use client';
import { apiFetch } from './api-client';

/**
 * M9.8 (Phase 3.5) — Frontend typed client for the per-user agent CRUD
 * endpoints shipped by M9.7 (ADR-0003 Decision 4).
 *
 *   GET    /api/v1/me/agents               — list the caller's user_agents
 *   POST   /api/v1/me/agents               — create
 *   PATCH  /api/v1/me/agents/:agentId      — partial update
 *   DELETE /api/v1/me/agents/:agentId      — hard delete
 *
 * The `/me/...` URL pattern means the route always derives the owner
 * userId from the JWT — there is no path-vs-auth mismatch surface.
 *
 * M9.8 itself doesn't yet surface these in the chat-entry form (the home
 * page hardcodes the 4 first-party agent kinds for "Recently used"
 * until Phase 5 memory-rank lands). M9.9's Settings → My Agents tab is
 * the first consumer; this client lives in M9.8 so M9.9 can drop in
 * without re-validating the wire shape.
 *
 * @file lib/user-agents.ts
 */

export type AgentKind =
  | 'pr_impact'
  | 'brand_sentinel'
  | 'crisis_watch'
  | 'competitor_tracker';

export type AgentScope = 'user_private' | 'workspace_shared';

export interface UserAgent {
  id: string;
  userId: string;
  name: string;
  baseAgentKind: AgentKind;
  /** Free-form JSONB bag — prompt overrides, default chat_params, etc. */
  customization: Record<string, unknown>;
  scope: AgentScope;
  createdAt: string;
}

export interface CreateUserAgentInput {
  name: string;
  baseAgentKind: AgentKind;
  customization: Record<string, unknown>;
  /** Defaults to `user_private` server-side; only admins can promote to
   *  `workspace_shared` per Phase 6 (not yet enforced in M9.7). */
  scope?: AgentScope;
}

export interface UpdateUserAgentInput {
  name?: string;
  baseAgentKind?: AgentKind;
  customization?: Record<string, unknown>;
  scope?: AgentScope;
}

export async function listUserAgents(): Promise<UserAgent[]> {
  return apiFetch<UserAgent[]>('/api/v1/me/agents');
}

export async function createUserAgent(
  input: CreateUserAgentInput,
): Promise<UserAgent> {
  return apiFetch<UserAgent>('/api/v1/me/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateUserAgent(
  agentId: string,
  patch: UpdateUserAgentInput,
): Promise<UserAgent> {
  return apiFetch<UserAgent>(
    `/api/v1/me/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteUserAgent(agentId: string): Promise<void> {
  await apiFetch(`/api/v1/me/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
}
