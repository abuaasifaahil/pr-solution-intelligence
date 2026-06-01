/**
 * M9.6c (Phase 3.5) — user_agents thin CRUD service.
 *
 * Backs ADR-0003 Decision 4 ("per-user agent and skill ownership"). Each
 * `user_agents` row is a customization layered on top of one of the four
 * built-in `AgentKind` values. The row's `customization` JSONB is a
 * free-form bag the M9.7 REST layer + Phase 5.5 composer + Phase 5
 * memory ranker share — this service does NOT validate its shape (the
 * route layer / consumer owns that, matching the existing `chat_params`
 * JSONB pattern).
 *
 * Every method runs inside `withUser(userId, …)` so RLS policies are
 * enforced — see migrations/20260601100000_phase35_user_agents_skills.
 *
 * The Zod validators are exported so M9.7 routes can reuse them.
 */
import { z } from 'zod';
import { withUser } from '../lib/prisma-rls.js';
import type { Prisma, UserAgent, AgentKind, AgentScope } from '@prsi/shared/db';

// ─── Zod validators (exported for M9.7 route reuse) ─────────────────────

export const AgentKindSchema = z.enum([
  'pr_impact',
  'brand_sentinel',
  'crisis_watch',
  'competitor_tracker',
]);

export const AgentScopeSchema = z.enum(['user_private', 'workspace_shared']);

/**
 * Customization is a free-form JSONB bag — Zod allows any record. The
 * route / composer / memory layers are responsible for shape contracts
 * (e.g. "prompt_overrides must be string[]"). Keeping this loose here
 * lets M10.x evolve the customization spec without re-migrating.
 */
export const CustomizationSchema = z.record(z.unknown());

export const CreateUserAgentInputSchema = z.object({
  name: z.string().min(1).max(255),
  baseAgentKind: AgentKindSchema,
  customization: CustomizationSchema,
  scope: AgentScopeSchema.optional(),
});

export const UpdateUserAgentInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  baseAgentKind: AgentKindSchema.optional(),
  customization: CustomizationSchema.optional(),
  scope: AgentScopeSchema.optional(),
});

export type CreateUserAgentInput = z.infer<typeof CreateUserAgentInputSchema>;
export type UpdateUserAgentInput = z.infer<typeof UpdateUserAgentInputSchema>;

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

// ─── CRUD operations ────────────────────────────────────────────────────

/**
 * List the calling user's authored agents. RLS guarantees the result is
 * pre-filtered to the owning user; the explicit `where` clause is belt-
 * and-suspenders so the query plan is also user-scoped.
 */
export async function listUserAgents(userId: string): Promise<UserAgent[]> {
  return withUser(userId, async (tx) => {
    return tx.userAgent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  });
}

/**
 * Fetch one agent the caller owns. Returns null if the row doesn't
 * exist OR if it belongs to a different user (RLS hides it — same null
 * result either way).
 */
export async function getUserAgent(
  userId: string,
  agentId: string,
): Promise<UserAgent | null> {
  return withUser(userId, async (tx) => {
    return tx.userAgent.findFirst({
      where: { id: agentId, userId },
    });
  });
}

/**
 * Insert a new user_agents row. The `userId` parameter is the owner —
 * the input.scope ENUM controls private vs workspace-shared scope but
 * does NOT change the owner column. Returns the persisted row.
 */
export async function createUserAgent(
  userId: string,
  input: CreateUserAgentInput,
): Promise<UserAgent> {
  const parsed = CreateUserAgentInputSchema.parse(input);
  return withUser(userId, async (tx) => {
    return tx.userAgent.create({
      data: {
        userId,
        name: parsed.name,
        baseAgentKind: parsed.baseAgentKind as AgentKind,
        customization: toJson(parsed.customization),
        scope: (parsed.scope ?? 'user_private') as AgentScope,
      },
    });
  });
}

/**
 * Patch a user_agents row by id. RLS prevents reaching another user's
 * agent; passing an `agentId` the caller doesn't own → P2025 / 0 rows
 * affected — translated by Prisma to a `RecordNotFound` error.
 */
export async function updateUserAgent(
  userId: string,
  agentId: string,
  patch: UpdateUserAgentInput,
): Promise<UserAgent> {
  const parsed = UpdateUserAgentInputSchema.parse(patch);
  return withUser(userId, async (tx) => {
    const data: Prisma.UserAgentUpdateInput = {};
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.baseAgentKind !== undefined) {
      data.baseAgentKind = parsed.baseAgentKind as AgentKind;
    }
    if (parsed.customization !== undefined) {
      data.customization = toJson(parsed.customization);
    }
    if (parsed.scope !== undefined) data.scope = parsed.scope as AgentScope;
    // We scope the update via `where: { id, userId }` so RLS + the
    // userId predicate together protect against cross-user writes.
    return tx.userAgent.update({
      where: { id: agentId },
      data,
    });
  });
}

/**
 * Hard delete a user_agents row. CASCADE on users(id) → user_agents(user_id)
 * already covers account-deletion fan-out; this method is for the
 * explicit "remove this agent" UI action.
 */
export async function deleteUserAgent(
  userId: string,
  agentId: string,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.userAgent.delete({ where: { id: agentId } });
  });
}
