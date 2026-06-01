/**
 * Phase 2 BooleanQuery service — M7.6.
 *
 * Owns the lifecycle of `boolean_queries` rows: generate (from chat_params),
 * patch (user manual edit, version bump), confirm (flip is_confirmed +
 * enqueue data-extract job + advance flow state), and a simple latest-row
 * helper for the frontend.
 *
 * All DB access is RLS-scoped via `withUser`. The 'data-extract' job is
 * pushed onto the shared `phase2-jobs` queue; M7.7 will register the
 * processor. Until then BullMQ logs an "unknown processor" warning and
 * the job sits idle — acceptable, the queue side is intentionally
 * decoupled.
 *
 * @file services/boolean-query.service.ts
 */
import { withUser } from '../lib/prisma-rls.js';
import { generateBooleanQuery } from '../lib/boolean-query-engine.js';
import { getQueue } from '../lib/queue.js';
import { patchParams } from './chat-params.service.js';
import type { Prisma } from '@prsi/shared/db';

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

/**
 * Generate a Boolean query from the current chat_params. Versioning rule:
 *   - If a draft (unconfirmed) row already exists and its `queryText`
 *     matches the freshly-generated text, return it as-is (no bump).
 *   - Otherwise create a new row with `version = previous.version + 1`
 *     (or 1 if no previous).
 *
 * Throws:
 *   'Chat params not found' — RLS hides the row OR it has not been created.
 *   'brand required before generating query' — flow not yet at this stage.
 */
export async function generateQueryForChat(userId: string, chatId: string) {
  return withUser(userId, async (tx) => {
    const params = await tx.chatParams.findUnique({ where: { chatId } });
    if (!params) throw new Error('Chat params not found');
    if (!params.brand) throw new Error('brand required before generating query');

    const result = generateBooleanQuery({
      brand: params.brand,
      competitors: Array.isArray(params.competitors)
        ? (params.competitors as string[])
        : [],
      dateStart: params.dateStart,
      dateEnd: params.dateEnd,
    });

    // Latest draft (if any) determines whether we reuse vs version-bump.
    const previous = await tx.booleanQuery.findFirst({
      where: { chatId, chatParamsId: params.id, isConfirmed: false },
      orderBy: { version: 'desc' },
    });
    if (previous && previous.queryText === result.text) return previous;

    const nextVersion = previous ? previous.version + 1 : 1;
    const created = await tx.booleanQuery.create({
      data: {
        chatId,
        chatParamsId: params.id,
        queryText: result.text,
        queryStructured: toJson(result.structured),
        version: nextVersion,
        isConfirmed: false,
      },
    });
    return created;
  });
}

/**
 * Apply a user-edited query text on top of the latest draft. Always creates
 * a new row (version bump) — the previous draft remains as audit history.
 * The `queryStructured` field is carried over from the previous draft
 * (best-effort reference); we do not attempt to parse the new text.
 *
 * Throws:
 *   'queryText cannot be empty'
 *   'No draft query to edit'
 */
export async function patchQueryText(
  userId: string,
  chatId: string,
  newText: string,
) {
  const trimmed = newText.trim();
  if (!trimmed) throw new Error('queryText cannot be empty');
  return withUser(userId, async (tx) => {
    const previous = await tx.booleanQuery.findFirst({
      where: { chatId, isConfirmed: false },
      orderBy: { version: 'desc' },
    });
    if (!previous) throw new Error('No draft query to edit');

    const nextVersion = previous.version + 1;
    const updated = await tx.booleanQuery.create({
      data: {
        chatId,
        chatParamsId: previous.chatParamsId,
        queryText: trimmed,
        queryStructured: toJson(previous.queryStructured),
        version: nextVersion,
        isConfirmed: false,
      },
    });
    return updated;
  });
}

/**
 * Confirm the latest draft query for a chat:
 *   1. Flip `is_confirmed = true` + stamp `confirmedAt`.
 *   2. Enqueue a 'data-extract' job on the shared `phase2-jobs` queue.
 *   3. Re-run `patchParams({})` so the chat-params snapshot picks up the
 *      new `hasConfirmedQuery` and advances the flow state to 'processing'
 *      (emitting `flow:state-change` on the WS channel for free).
 *
 * Throws 'No draft query to confirm' when there is nothing to confirm.
 */
export async function confirmQuery(userId: string, chatId: string) {
  const confirmed = await withUser(userId, async (tx) => {
    const draft = await tx.booleanQuery.findFirst({
      where: { chatId, isConfirmed: false },
      orderBy: { version: 'desc' },
    });
    if (!draft) throw new Error('No draft query to confirm');
    return tx.booleanQuery.update({
      where: { id: draft.id },
      data: { isConfirmed: true, confirmedAt: new Date() },
    });
  });

  // Enqueue the data-extract job. M7.7 will register the processor.
  await getQueue().add('data-extract', {
    chatId,
    userId,
    queryId: confirmed.id,
  });

  // Re-run patchParams with an empty patch so the snapshot recomputes and
  // the flow state advances past 'generate_query' → 'processing'. This
  // also publishes the WS state-change event on success.
  await patchParams(userId, chatId, {});

  return confirmed;
}

/**
 * Fetch the most-recent query (draft or confirmed) for a chat. Used by
 * the frontend on chat load to render the current query state.
 *
 * Order: confirmed first, then highest version. So a confirmed row wins
 * over a stale higher-version draft (shouldn't happen, but defensive).
 */
export async function getLatestQuery(userId: string, chatId: string) {
  return withUser(userId, async (tx) => {
    return tx.booleanQuery.findFirst({
      where: { chatId },
      orderBy: [{ isConfirmed: 'desc' }, { version: 'desc' }],
    });
  });
}
