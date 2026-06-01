/**
 * M9.7 (Phase 3.5) — composable_skills CRUD (ADR-0003 Decision 4 /
 * ADR-0002 Part 2).
 *
 *   GET    /api/v1/composable-skills              — list visible skills
 *   POST   /api/v1/composable-skills              — create (scope='user_private' only)
 *   PATCH  /api/v1/composable-skills/:skillId     — partial update
 *   DELETE /api/v1/composable-skills/:skillId     — hard delete
 *
 * RLS handles visibility (first_party + community-enabled + own
 * user_private). The service-layer guard in `composable-skill.service.ts`
 * rejects non-user_private scope on create — we map that thrown error
 * to 403.
 *
 * First-party rows have `userId=null` — the M9.8/M9.9 frontend treats
 * them as "platform default" (read-only). Trying to PATCH/DELETE them
 * fails through RLS as P2025 → 404.
 *
 * Error mapping:
 *   - Zod parse fail               → 400
 *   - Service "createSkill: only scope='user_private'" → 403
 *   - P2025 (RLS-hidden / not found) → 404
 *   - Anything else                → 500
 *
 * @file backend/src/routes/composable-skill.routes.ts
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  CreateSkillInputSchema,
  UpdateSkillInputSchema,
  SkillKindSchema,
  SkillScopeSchema,
} from '../services/composable-skill.service.js';

const PRISMA_RECORD_NOT_FOUND = 'P2025';

function prismaCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

const ListQuerySchema = z.object({
  scope: SkillScopeSchema.optional(),
  kind: SkillKindSchema.optional(),
  /** Stringly-typed because Fastify parses query strings as strings.
   *  'true' (case-insensitive) becomes true; everything else (including
   *  omission) is false / undefined. */
  enabledOnly: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

export async function composableSkillRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/composable-skills ────────────────────────────────────
  app.get('/api/v1/composable-skills', { preHandler: app.auth }, async (req, reply) => {
    const parsedQuery = ListQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      reply.code(400);
      return {
        success: false,
        error: 'Invalid query',
        meta: parsedQuery.error.flatten(),
      };
    }
    const rows = await listSkills(req.user!.userId, {
      ...(parsedQuery.data.scope !== undefined ? { scope: parsedQuery.data.scope } : {}),
      ...(parsedQuery.data.kind !== undefined ? { kind: parsedQuery.data.kind } : {}),
      ...(parsedQuery.data.enabledOnly !== undefined
        ? { enabledOnly: parsedQuery.data.enabledOnly }
        : {}),
    });
    return { success: true, data: rows };
  });

  // ─── POST /api/v1/composable-skills ───────────────────────────────────
  app.post('/api/v1/composable-skills', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateSkillInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const created = await createSkill(req.user!.userId, parsed.data);
      reply.code(201);
      return { success: true, data: created };
    } catch (err) {
      const message = (err as Error).message;
      // Service-level scope guard → 403. The thrown error string starts
      // with "createSkill: only scope='user_private' allowed".
      if (message.startsWith('createSkill:')) {
        reply.code(403);
        return { success: false, error: message };
      }
      reply.code(500);
      app.log.error({ err }, 'createSkill failed');
      return { success: false, error: message };
    }
  });

  // ─── PATCH /api/v1/composable-skills/:skillId ─────────────────────────
  app.patch('/api/v1/composable-skills/:skillId', { preHandler: app.auth }, async (req, reply) => {
    const { skillId } = req.params as { skillId: string };
    const parsed = UpdateSkillInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const updated = await updateSkill(req.user!.userId, skillId, parsed.data);
      return { success: true, data: updated };
    } catch (err) {
      const code = prismaCode(err);
      if (code === PRISMA_RECORD_NOT_FOUND) {
        reply.code(404);
        return { success: false, error: 'Skill not found' };
      }
      reply.code(500);
      app.log.error({ err }, 'updateSkill failed');
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── DELETE /api/v1/composable-skills/:skillId ────────────────────────
  app.delete('/api/v1/composable-skills/:skillId', { preHandler: app.auth }, async (req, reply) => {
    const { skillId } = req.params as { skillId: string };
    try {
      // Pre-check so a missing row gives a 404 identical to RLS-hidden
      // rows (e.g. trying to delete a first-party skill).
      const existing = await getSkill(req.user!.userId, skillId);
      if (!existing) {
        reply.code(404);
        return { success: false, error: 'Skill not found' };
      }
      // RLS also blocks deletes on first_party / community / other-
      // user rows — a getSkill that resolves but a delete that 404s
      // means RLS allowed read but not write. Map both cases to 404.
      await deleteSkill(req.user!.userId, skillId);
      reply.code(204);
      return null;
    } catch (err) {
      const code = prismaCode(err);
      if (code === PRISMA_RECORD_NOT_FOUND) {
        reply.code(404);
        return { success: false, error: 'Skill not found' };
      }
      reply.code(500);
      app.log.error({ err }, 'deleteSkill failed');
      return { success: false, error: (err as Error).message };
    }
  });
}
