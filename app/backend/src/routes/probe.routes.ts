/**
 * M9.7 (Phase 3.5) — probe endpoints.
 *
 *   GET  /api/v1/chats/:id/probe          — classify attached source(s) + return ProbingResult
 *   POST /api/v1/chats/:id/probe/resolve  — patch chat_params from user resolutions
 *                                            and return remaining probes
 *
 * These power the chat-entry ProbingResultCard (M9.8) per ADR-0003
 * Decision 2 (agent-as-prober) + patterns 3, 4, 6, 7.
 *
 * The endpoints are deliberately stateless: every GET re-runs the
 * classifier against a fresh sample, every POST re-runs it after the
 * patch. M9.11 may add a `chat_params.probe_cache` column if the
 * sample-fetch cost becomes a problem; M9.7 doesn't pre-optimize.
 *
 * @file backend/src/routes/probe.routes.ts
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../lib/prisma-rls.js';
import { sampleClassifier } from '../lib/sample-classifier.js';
import { collectAdapterSamples } from '../lib/source-snapshot.js';
import { getOrCreateParams, patchParams, type PatchInput } from '../services/chat-params.service.js';
import { MediaTypeSchema } from '../lib/media-types.js';
import type { ProbingResult } from '../agents/probing-agent.js';

// ─── Resolve body schema ────────────────────────────────────────────────

const ResolveFieldSchema = z.enum([
  'brand',
  'competitors',
  'dateRange',
  'mediaTypes',
  'language',
  'intention',
  'enrichmentType',
]);

/**
 * Single resolution payload. `value` is loose at the Zod layer
 * (string | string[] | {start,end}) — the handler validates per-field
 * shape before translating to a `PatchInput`. Keeping it open here lets
 * Zod accept the wire shape; the handler's per-field switch enforces
 * the concrete contract.
 */
const ResolveBodySchema = z.object({
  resolutions: z
    .array(
      z.object({
        field: ResolveFieldSchema,
        value: z.union([
          z.string(),
          z.array(z.string()),
          z.object({ start: z.string(), end: z.string() }),
        ]),
      }),
    )
    .min(1)
    .max(8),
});

type ResolveField = z.infer<typeof ResolveFieldSchema>;
type ResolveValue =
  | string
  | string[]
  | { start: string; end: string };

/**
 * BRD wording (what the M9.8 UI emits) → chat_params enum. Mirrors the
 * intent-application.service.ts mapping so the UI can use the same
 * value strings everywhere.
 */
const ENRICHMENT_TYPE_MAP: Record<'enrichment' | 'enrichment_plus_reach', 'standard' | 'reach'> = {
  enrichment: 'standard',
  enrichment_plus_reach: 'reach',
};

/**
 * Translate one {field, value} resolution into a partial `PatchInput`.
 * Throws on invalid value shapes — caller maps to HTTP 400.
 */
function translateResolution(field: ResolveField, value: ResolveValue): PatchInput {
  switch (field) {
    case 'brand': {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('brand resolution must be a non-empty string');
      }
      return { brand: value };
    }
    case 'competitors': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error('competitors resolution must be a string array');
      }
      return { competitors: value, competitorSet: 'custom' };
    }
    case 'dateRange': {
      if (typeof value !== 'object' || Array.isArray(value) || value === null) {
        throw new Error('dateRange resolution must be an object {start, end}');
      }
      const { start, end } = value;
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error('dateRange.start and dateRange.end must be ISO dates');
      }
      return { dateStart: startDate, dateEnd: endDate, dateRangeType: 'custom' };
    }
    case 'mediaTypes': {
      if (!Array.isArray(value)) {
        throw new Error('mediaTypes resolution must be a string array');
      }
      // Zod-validate against MediaTypeSchema so a typo trips 400 not 500.
      const parsed = z.array(MediaTypeSchema).safeParse(value);
      if (!parsed.success) {
        throw new Error('mediaTypes contains an unknown media type');
      }
      return { mediaTypes: parsed.data };
    }
    case 'language': {
      // Language is not a chat_params column today — the classifier
      // surfaces it for transparency. We currently NO-OP this resolution
      // (no place to persist) but accept it so the UI's resolve payload
      // stays uniform. M9.x may add a `language` column.
      if (typeof value !== 'string') {
        throw new Error('language resolution must be a string');
      }
      return {};
    }
    case 'intention': {
      if (value !== 'intention_based' && value !== 'comment_based') {
        throw new Error("intention must be 'intention_based' or 'comment_based'");
      }
      return { intention: value };
    }
    case 'enrichmentType': {
      if (value === 'enrichment' || value === 'enrichment_plus_reach') {
        return { enrichmentType: ENRICHMENT_TYPE_MAP[value] };
      }
      if (value === 'standard' || value === 'reach') {
        return { enrichmentType: value };
      }
      throw new Error(
        "enrichmentType must be 'enrichment'|'enrichment_plus_reach' or 'standard'|'reach'",
      );
    }
  }
}

/**
 * Run the sample-classifier against the chat's current state — used by
 * BOTH GET /probe and POST /probe/resolve.
 */
async function runProbe(userId: string, chatId: string): Promise<ProbingResult> {
  const snapshots = await collectAdapterSamples(userId, chatId);
  // First user message (if any) becomes the prompt input. Patterns 6/7
  // ("without prompt") leave this null and the classifier still runs.
  const firstUserMessage = await withUser(userId, async (tx) =>
    tx.message.findFirst({
      where: { chatId, role: 'user' },
      orderBy: { createdAt: 'asc' },
    }),
  );
  const params = await getOrCreateParams(userId, chatId);
  return sampleClassifier.classifyAndProbe({
    userId,
    chatId,
    prompt: firstUserMessage?.content ?? null,
    attachedSources: snapshots,
    existingChatParams: params,
  });
}

export async function probeRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/chats/:id/probe ──────────────────────────────────────
  app.get('/api/v1/chats/:id/probe', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      // assertChatOwnership: getOrCreateParams throws "Chat not found"
      // when the chat isn't visible (RLS) — that bubbles to 404 below.
      await getOrCreateParams(req.user!.userId, id);
      const result = await runProbe(req.user!.userId, id);
      return { success: true, data: result };
    } catch (err) {
      const message = (err as Error).message;
      reply.code(message === 'Chat not found' ? 404 : 500);
      return { success: false, error: message };
    }
  });

  // ─── POST /api/v1/chats/:id/probe/resolve ─────────────────────────────
  app.post('/api/v1/chats/:id/probe/resolve', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      // Verify chat ownership BEFORE attempting any patch — RLS would
      // also block but we want a clean 404 not a 500 from a downstream
      // mismatch.
      await getOrCreateParams(req.user!.userId, id);

      // Translate each resolution into a partial patch + merge.
      const merged: PatchInput = {};
      for (const res of parsed.data.resolutions) {
        const partial = translateResolution(res.field, res.value as ResolveValue);
        Object.assign(merged, partial);
      }

      // Single atomic patch.
      const { params: updatedParams } = await patchParams(
        req.user!.userId,
        id,
        merged,
      );

      // Re-run classifier with the updated params so the UI can render
      // the next set of probes.
      const result = await runProbe(req.user!.userId, id);

      return {
        success: true,
        data: {
          updatedParams,
          remainingProbes: result.probes,
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      // Field-shape errors from translateResolution are validation
      // failures → 400. Ownership errors → 404. Everything else → 500.
      if (message === 'Chat not found') {
        reply.code(404);
      } else if (
        message.includes('resolution') ||
        message.includes('must be') ||
        message.includes('unknown media type')
      ) {
        reply.code(400);
      } else {
        reply.code(500);
      }
      return { success: false, error: message };
    }
  });
}
