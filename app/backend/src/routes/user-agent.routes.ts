/**
 * M9.7 (Phase 3.5) — per-user agent CRUD (ADR-0003 Decision 4).
 *
 *   GET    /api/v1/me/agents               — list the caller's user_agents
 *   POST   /api/v1/me/agents               — create
 *   PATCH  /api/v1/me/agents/:agentId      — partial update
 *   DELETE /api/v1/me/agents/:agentId      — hard delete
 *
 * Uses `/me/...` (the authenticated user is always the subject) per the
 * M9.7 design — `/users/:id/...` invites URL-id-vs-auth-id mismatches
 * and RLS bypass bugs.
 *
 * Service layer (`user-agent.service.ts`) already runs every operation
 * inside `withUser(userId, ...)` so RLS protects against cross-user
 * reads/writes — this file is a thin Zod-validate + delegate + map
 * errors to HTTP layer.
 *
 * Error mapping:
 *   - Zod parse fail              → 400 + flattened error
 *   - P2025 (Prisma RecordNotFound, RLS hid the row) → 404
 *   - Unique constraint (duplicate name within user) → 409
 *   - Anything else               → 500
 *
 * @file backend/src/routes/user-agent.routes.ts
 */
import type { FastifyInstance } from 'fastify';
import {
  listUserAgents,
  getUserAgent,
  createUserAgent,
  updateUserAgent,
  deleteUserAgent,
  CreateUserAgentInputSchema,
  UpdateUserAgentInputSchema,
} from '../services/user-agent.service.js';

// Prisma's known error codes we map to HTTP. Kept inline (no import of
// Prisma.PrismaClientKnownRequestError class) to avoid a runtime import
// of @prisma/client just for `instanceof` — we check `code` on the
// duck-typed error.
const PRISMA_RECORD_NOT_FOUND = 'P2025';
const PRISMA_UNIQUE_VIOLATION = 'P2002';

function prismaCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export async function userAgentRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/me/agents ────────────────────────────────────────────
  app.get('/api/v1/me/agents', { preHandler: app.auth }, async (req) => {
    const rows = await listUserAgents(req.user!.userId);
    return { success: true, data: rows };
  });

  // ─── POST /api/v1/me/agents ───────────────────────────────────────────
  app.post('/api/v1/me/agents', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateUserAgentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const created = await createUserAgent(req.user!.userId, parsed.data);
      reply.code(201);
      return { success: true, data: created };
    } catch (err) {
      const code = prismaCode(err);
      if (code === PRISMA_UNIQUE_VIOLATION) {
        reply.code(409);
        return {
          success: false,
          error: `An agent named "${parsed.data.name}" already exists`,
        };
      }
      reply.code(500);
      app.log.error({ err }, 'createUserAgent failed');
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── PATCH /api/v1/me/agents/:agentId ─────────────────────────────────
  app.patch('/api/v1/me/agents/:agentId', { preHandler: app.auth }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const parsed = UpdateUserAgentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const updated = await updateUserAgent(req.user!.userId, agentId, parsed.data);
      return { success: true, data: updated };
    } catch (err) {
      const code = prismaCode(err);
      if (code === PRISMA_RECORD_NOT_FOUND) {
        reply.code(404);
        return { success: false, error: 'Agent not found' };
      }
      if (code === PRISMA_UNIQUE_VIOLATION) {
        reply.code(409);
        return {
          success: false,
          error: `An agent named "${parsed.data.name ?? ''}" already exists`,
        };
      }
      reply.code(500);
      app.log.error({ err }, 'updateUserAgent failed');
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── DELETE /api/v1/me/agents/:agentId ────────────────────────────────
  app.delete('/api/v1/me/agents/:agentId', { preHandler: app.auth }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      // Service's `deleteUserAgent` is a delete-by-id. If the row is RLS-
      // hidden Prisma raises P2025. Pre-check via getUserAgent so the 404
      // case is identical whether the row never existed or RLS hides it.
      const existing = await getUserAgent(req.user!.userId, agentId);
      if (!existing) {
        reply.code(404);
        return { success: false, error: 'Agent not found' };
      }
      await deleteUserAgent(req.user!.userId, agentId);
      reply.code(204);
      return null;
    } catch (err) {
      const code = prismaCode(err);
      if (code === PRISMA_RECORD_NOT_FOUND) {
        reply.code(404);
        return { success: false, error: 'Agent not found' };
      }
      reply.code(500);
      app.log.error({ err }, 'deleteUserAgent failed');
      return { success: false, error: (err as Error).message };
    }
  });
}
