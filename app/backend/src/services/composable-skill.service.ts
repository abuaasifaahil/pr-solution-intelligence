/**
 * M9.6c (Phase 3.5) — composable_skills thin CRUD service.
 *
 * Backs ADR-0003 Decision 4 / ADR-0002 Part 2. The `composable_skills`
 * table stores per-user + workspace + first-party + community skills
 * that the Phase 5.5 SkillComposer will read from. This service is the
 * thin write-and-read surface; the route layer (M9.7) wraps it.
 *
 * Naming deviation from ADR-0003: the ADR sketches `skills` as the
 * table name, but a `skills` table already exists from M5 (capability
 * flags). To avoid breaking M5 the new table is mapped to
 * `composable_skills` in Postgres / Prisma model `ComposableSkill`.
 * See migration file header + schema.prisma comment for context.
 *
 * Everything runs inside `withUser` so RLS policies enforce visibility:
 * - first_party rows: readable by everyone, only writable by seed
 *   (which runs as the superuser → bypasses RLS).
 * - user_private rows: owner-only read + write.
 * - community rows (enabled=true): readable by everyone, not writable
 *   in M9.7 (Phase 7 marketplace ships the upload path).
 * - workspace rows: deferred to Phase 6.
 *
 * The service ENFORCES write-scope at the application layer too — it
 * rejects createSkill calls for scope=first_party / scope=community /
 * scope=workspace so callers can't try to slip past RLS by guessing
 * the right (user_id, scope) combination.
 */
import { z } from 'zod';
import { withUser } from '../lib/prisma-rls.js';
import type {
  ComposableSkill,
  Prisma,
  SkillKind,
  SkillScope,
} from '@prsi/shared/db';

// ─── Zod validators (exported for M9.7 route reuse) ─────────────────────

export const SkillKindSchema = z.enum([
  'analysis_skill',
  'source_skill',
  'enrichment_skill',
  'tool_skill',
  'alert_skill',
  'external_skill',
]);

export const SkillScopeSchema = z.enum([
  'first_party',
  'workspace',
  'user_private',
  'community',
]);

/**
 * Manifest shape is intentionally loose at the Zod layer — the JSONSchema
 * validator that M10.5 ships will enforce the canonical ADR-0002 shape.
 * Until then we accept any object (must be a record, NOT a primitive or
 * array, so JSONB column always stores a tagged object).
 */
export const SkillManifestSchema = z.record(z.unknown());

export const CreateSkillInputSchema = z.object({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(50).optional(),
  kind: SkillKindSchema,
  manifest: SkillManifestSchema,
  // Service-level: only `user_private` is acceptable from the user-write
  // path. The route layer + service layer reject everything else here.
  scope: SkillScopeSchema,
});

export const UpdateSkillInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  version: z.string().min(1).max(50).optional(),
  kind: SkillKindSchema.optional(),
  manifest: SkillManifestSchema.optional(),
  // scope intentionally not editable post-create — promoting a skill
  // from user_private → workspace requires admin path (Phase 6).
});

export const ListSkillsOptionsSchema = z.object({
  kind: SkillKindSchema.optional(),
  scope: SkillScopeSchema.optional(),
  enabledOnly: z.boolean().optional(),
});

export type CreateSkillInput = z.infer<typeof CreateSkillInputSchema>;
export type UpdateSkillInput = z.infer<typeof UpdateSkillInputSchema>;
export type ListSkillsOptions = z.infer<typeof ListSkillsOptionsSchema>;

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

// ─── CRUD operations ────────────────────────────────────────────────────

/**
 * List the skills visible to the caller. RLS handles visibility
 * (first_party + community-enabled + own user_private). Optional
 * filters narrow the result set further.
 */
export async function listSkills(
  userId: string,
  options: ListSkillsOptions = {},
): Promise<ComposableSkill[]> {
  const parsed = ListSkillsOptionsSchema.parse(options);
  return withUser(userId, async (tx) => {
    const where: Prisma.ComposableSkillWhereInput = {};
    if (parsed.kind !== undefined) where.kind = parsed.kind as SkillKind;
    if (parsed.scope !== undefined) where.scope = parsed.scope as SkillScope;
    if (parsed.enabledOnly) where.enabled = true;
    return tx.composableSkill.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { name: 'asc' }, { version: 'asc' }],
    });
  });
}

/**
 * Fetch one skill by id IF RLS lets the caller see it. Otherwise
 * returns null (RLS hides the row → findFirst → null).
 */
export async function getSkill(
  userId: string,
  skillId: string,
): Promise<ComposableSkill | null> {
  return withUser(userId, async (tx) => {
    return tx.composableSkill.findFirst({ where: { id: skillId } });
  });
}

/**
 * Create a new user_private skill. Service-level enforcement: scope
 * MUST be `user_private` — first_party / community / workspace are all
 * rejected here. The seed function uses prisma directly (bypassing RLS)
 * for first_party inserts; Phase 6 admin code will use a separate
 * service for workspace inserts.
 *
 * The user_id is always set to the calling user — there's no path for
 * Alice to create a skill owned by Bob.
 */
export async function createSkill(
  userId: string,
  input: CreateSkillInput,
): Promise<ComposableSkill> {
  const parsed = CreateSkillInputSchema.parse(input);
  if (parsed.scope !== 'user_private') {
    // Application-layer guard. RLS will ALSO reject this, but we throw
    // a meaningful error before the DB round-trip so the route layer
    // can return 403 cleanly.
    throw new Error(
      `createSkill: only scope='user_private' allowed via this path (got '${parsed.scope}'). ` +
        `first_party rows are seeded; workspace rows go through the Phase 6 admin path.`,
    );
  }
  return withUser(userId, async (tx) => {
    return tx.composableSkill.create({
      data: {
        name: parsed.name,
        version: parsed.version ?? '1.0.0',
        kind: parsed.kind as SkillKind,
        manifest: toJson(parsed.manifest),
        scope: 'user_private' as SkillScope,
        userId,
        // trust_level + enabled fall to defaults (first_party / true)
      },
    });
  });
}

/**
 * Patch a user_private skill the caller owns. RLS prevents updating
 * first_party rows + other users' rows — the update simply matches
 * zero rows and Prisma raises P2025 (RecordNotFound).
 */
export async function updateSkill(
  userId: string,
  skillId: string,
  patch: UpdateSkillInput,
): Promise<ComposableSkill> {
  const parsed = UpdateSkillInputSchema.parse(patch);
  return withUser(userId, async (tx) => {
    const data: Prisma.ComposableSkillUpdateInput = {};
    if (parsed.name !== undefined) data.name = parsed.name;
    if (parsed.version !== undefined) data.version = parsed.version;
    if (parsed.kind !== undefined) data.kind = parsed.kind as SkillKind;
    if (parsed.manifest !== undefined) {
      data.manifest = toJson(parsed.manifest);
    }
    return tx.composableSkill.update({
      where: { id: skillId },
      data,
    });
  });
}

/**
 * Delete a user_private skill the caller owns. CASCADE on users(id)
 * cleans up at account deletion; this method is for explicit "remove
 * this skill" UI actions.
 */
export async function deleteSkill(
  userId: string,
  skillId: string,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.composableSkill.delete({ where: { id: skillId } });
  });
}
