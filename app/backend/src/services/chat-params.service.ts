/**
 * Phase 2 chat_params service — M7.5.
 *
 * Owns reads/writes for the chat_params row (1:1 with chats). PATCH calls
 * automatically recompute the flow_state via the pure flow-engine and emit
 * `flow:state-change` on the per-chat WS channel when the state advances.
 *
 * Also exposes an LLM-driven brand→competitors suggestion used by the
 * `collect_competitors` step.
 *
 * @file services/chat-params.service.ts
 */
import { withUser } from '../lib/prisma-rls.js';
import { getNextFlowState, getPromptForState, type ChatParamsSnapshot } from '../agents/flow-engine.js';
import { publishChatEvent } from '../lib/event-bus.js';
import { chatComplete } from '../lib/llm.js';
import type { Prisma } from '@prsi/shared/db';

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

/** Fetch (or lazily create) the chat_params row for a chat owned by userId.
 *  1:1 with chats — UNIQUE(chat_id). */
export async function getOrCreateParams(userId: string, chatId: string) {
  return withUser(userId, async (tx) => {
    let row = await tx.chatParams.findUnique({ where: { chatId } });
    if (!row) {
      // Verify chat ownership before creating.
      const chat = await tx.chat.findFirst({ where: { id: chatId } });
      if (!chat) throw new Error('Chat not found');
      row = await tx.chatParams.create({
        data: { chatId, userId, flowState: 'init' },
      });
    }
    return row;
  });
}

export interface PatchInput {
  dateRangeType?: 'weekly' | 'ten_days' | 'twenty_days' | 'custom' | 'auto_detected';
  dateStart?: Date | null;
  dateEnd?: Date | null;
  enrichmentType?: 'standard' | 'reach';
  reachThreshold?: number | null;
  brand?: string | null;
  competitors?: string[];
  competitorSet?: 'top5' | 'top3' | 'top2' | 'custom';
  intention?: 'intention_based' | 'comment_based';
  hasUpload?: boolean;
  uploadId?: string | null;
}

/** Partial update of chat_params + automatic flow-state advance.
 *  Publishes flow:state-change WS event if the state moved. */
export async function patchParams(
  userId: string,
  chatId: string,
  patch: PatchInput,
) {
  const result = await withUser(userId, async (tx) => {
    // Ensure row exists (lazy-create on first PATCH).
    const existing = await tx.chatParams.findUnique({ where: { chatId } });
    if (!existing) {
      const chat = await tx.chat.findFirst({ where: { id: chatId } });
      if (!chat) throw new Error('Chat not found');
      await tx.chatParams.create({ data: { chatId, userId, flowState: 'init' } });
    }
    const data: Prisma.ChatParamsUpdateInput = {};
    if (patch.dateRangeType !== undefined) data.dateRangeType = patch.dateRangeType;
    if (patch.dateStart !== undefined) data.dateStart = patch.dateStart;
    if (patch.dateEnd !== undefined) data.dateEnd = patch.dateEnd;
    if (patch.enrichmentType !== undefined) data.enrichmentType = patch.enrichmentType;
    if (patch.reachThreshold !== undefined) data.reachThreshold = patch.reachThreshold;
    if (patch.brand !== undefined) data.brand = patch.brand;
    if (patch.competitors !== undefined) data.competitors = toJson(patch.competitors);
    if (patch.competitorSet !== undefined) data.competitorSet = patch.competitorSet;
    if (patch.intention !== undefined) data.intention = patch.intention;
    if (patch.hasUpload !== undefined) data.hasUpload = patch.hasUpload;
    if (patch.uploadId !== undefined) {
      // Prisma relation-style update: connect or disconnect upload.
      data.upload = patch.uploadId === null
        ? { disconnect: true }
        : { connect: { id: patch.uploadId } };
    }

    const updated = await tx.chatParams.update({ where: { chatId }, data });
    return updated;
  });

  // Compute next state OUTSIDE the transaction so we know the previous
  // state to emit. Snapshot is built from the updated row.
  const snapshot = toSnapshot(result);
  const nextState = getNextFlowState(snapshot);
  const prompt = getPromptForState(nextState, snapshot);

  if (nextState !== result.flowState) {
    const persisted = await withUser(userId, async (tx) => {
      return tx.chatParams.update({
        where: { chatId },
        data: {
          flowState: nextState,
          collectedAt: nextState === 'complete' ? new Date() : undefined,
        },
      });
    });
    await publishChatEvent(chatId, 'flow:state-change', {
      chatId,
      fromState: result.flowState,
      toState: nextState,
      nextPrompt: prompt,
    });
    return { params: persisted, nextPrompt: prompt };
  }

  return { params: result, nextPrompt: prompt };
}

function toSnapshot(row: {
  brand: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  competitors: unknown;
  intention: string | null;
  hasUpload: boolean;
}): ChatParamsSnapshot {
  return {
    brand: row.brand,
    dateStart: row.dateStart,
    dateEnd: row.dateEnd,
    enrichmentType: row.enrichmentType,
    competitors: row.competitors,
    intention: row.intention,
    hasUpload: row.hasUpload,
    hasConfirmedQuery: false, // M7.6 wires this from boolean_queries.is_confirmed
    isProcessingComplete: false, // M7.7 wires this from DataExtractAgent
  };
}

/** LLM-driven competitor suggestion. Returns three lists (top5/top3/top2)
 *  derived from the brand name and inferred industry. */
export async function suggestCompetitors(
  _userId: string,
  brand: string,
): Promise<{ top5: string[]; top3: string[]; top2: string[] }> {
  const prompt =
    `For the brand "${brand}", list its main competitors in the same industry. ` +
    `Reply in compact JSON: {"top5": [...], "top3": [...], "top2": [...]}. ` +
    `The top3 list MUST be a strict subset of top5, and top2 a strict subset of top3. ` +
    `No commentary, JSON only.`;
  const raw = await chatComplete({
    system: 'You are a market-research assistant.',
    messages: [{ role: 'user', content: prompt }],
  });
  try {
    const parsed = JSON.parse(raw) as { top5?: unknown; top3?: unknown; top2?: unknown };
    const top5 = Array.isArray(parsed.top5) ? parsed.top5.map(String).slice(0, 5) : [];
    const top3 = Array.isArray(parsed.top3) ? parsed.top3.map(String).slice(0, 3) : top5.slice(0, 3);
    const top2 = Array.isArray(parsed.top2) ? parsed.top2.map(String).slice(0, 2) : top5.slice(0, 2);
    return { top5, top3, top2 };
  } catch {
    // LLM emitted non-JSON. Return empty arrays; the caller can show a
    // friendly "let me know your competitors manually" message.
    return { top5: [], top3: [], top2: [] };
  }
}
