/**
 * Phase 3.5 (M9.5.5) — Reach probe service.
 *
 * Orchestrates the "this source lacks reach data, how should we proceed?"
 * interaction. SearchAgent (today) and the future SourceOrchestrator
 * (M9.11) both call `enterReachProbe` after their reflect step finds
 * reach coverage below `PRESENCE_THRESHOLD` (0.8) AND chat_params.
 * enrichmentType == 'standard'. The probe:
 *
 *   1. emits `reach:absent` on the chat's WS channel so the frontend
 *      surfaces a chip prompt
 *   2. transitions `chat.context.state` to `awaiting_reach_upgrade_consent`
 *      so a reconnect resumes the same probe (idempotent)
 *
 * The user picks one of two chips in the wizard state machine; the
 * orchestrator then calls `resolveReachProbe` with the choice:
 *
 *   - `upgrade_similarweb`     — bump chat_params.enrichmentType to 'reach'
 *                                → EnrichmentAgent + SimilarWebAgent run
 *   - `continue_without_reach` — set chat_params.intention to 'comment_based'
 *                                → EnrichmentAgent runs alone (no SimilarWeb)
 *
 * Decoupled from any specific agent class so the M9.6 adapter refactor
 * (ADR-0001) leaves this service untouched — the data-source adapters
 * call it, not vice versa.
 *
 * @file services/reach-probe.service.ts
 */
import { prisma } from '@prsi/shared/db';
import { patchParams } from './chat-params.service.js';
import { publishAgentBus, publishChatEvent } from '../lib/event-bus.js';
import { asAdmin } from '../lib/prisma-rls.js';
import type { ChatContext } from '../agents/orchestrator-state.js';

/** Input payload `enterReachProbe` accepts from SearchAgent / future adapters. */
export interface ReachProbeInput {
  chatId: string;
  /** Fraction (0..1) of sampled articles with a finite reach value.
   *  Sourced from `field-presence-detector.detectFieldPresence`. */
  coverageReach: number;
  /** How many articles the presence detector inspected. */
  sampleSize: number;
}

/** Chip values consumed by `resolveReachProbe`. */
export type ReachProbeChoice = 'upgrade_similarweb' | 'continue_without_reach';

/**
 * Called by SearchAgent / SourceOrchestrator when reach coverage is
 * below threshold AND `enrichmentType == 'standard'`. Emits the
 * `reach:absent` WS event and pins the chat state to
 * `awaiting_reach_upgrade_consent` so a reconnect resumes the probe.
 *
 * Idempotent: calling twice for the same chat publishes the event
 * twice (the WS channel has at-least-once semantics — the frontend
 * dedupes by `chatId`) but the chat-state write is a no-op when the
 * state is already set.
 */
export async function enterReachProbe(input: ReachProbeInput): Promise<void> {
  await publishChatEvent(input.chatId, 'reach:absent', {
    chatId: input.chatId,
    coverageReach: input.coverageReach,
    sampleSize: input.sampleSize,
    suggestUpgrade: true,
  });
  await setChatProbeState(input.chatId, 'awaiting_reach_upgrade_consent');
}

/**
 * Called by the orchestrator when the user submits a chip in the
 * probe state. Patches chat_params per the choice, emits
 * `reach:resolved`, transitions the chat state to `enriching`, and
 * dispatches enrichment on the cross-agent bus.
 *
 * Mirrors the exact `agent:enrichment:incoming` payload SearchAgent
 * uses on its no-probe-needed path so the dispatch code stays
 * single-sourced.
 *
 * Errors from `patchParams` propagate — callers (orchestrator) emit
 * a `chat:error` event and surface the failure to the user.
 */
export async function resolveReachProbe(
  userId: string,
  chatId: string,
  choice: ReachProbeChoice,
): Promise<void> {
  if (choice === 'upgrade_similarweb') {
    // Bump enrichmentType so EnrichmentAgent's reach branch fires +
    // SimilarWebAgent fan-out runs in parallel. `intention` stays
    // whatever the wizard captured.
    await patchParams(userId, chatId, { enrichmentType: 'reach' });
  } else {
    // `continue_without_reach` — flip intention to comment_based so
    // EnrichmentAgent uses the comment-based prompt branch. We
    // deliberately leave `enrichmentType` at 'standard' (no SimilarWeb).
    await patchParams(userId, chatId, { intention: 'comment_based' });
  }

  await publishChatEvent(chatId, 'reach:resolved', { chatId, choice });
  await setChatProbeState(chatId, 'enriching');

  // Read back the patched enrichmentType — SearchAgent stores either
  // 'standard' or 'reach' in chat_params and forwards it onto the bus
  // so EnrichmentAgent doesn't have to round-trip the DB. We mirror
  // that contract here.
  const params = await asAdmin((tx) =>
    tx.chatParams.findUnique({
      where: { chatId },
      select: { enrichmentType: true },
    }),
  );
  const enrichmentType: 'standard' | 'reach' =
    params?.enrichmentType === 'reach' ? 'reach' : 'standard';

  await publishAgentBus('agent:enrichment:incoming', {
    chatId,
    userId,
    // Empty articleIds = enrich all articles for the chat. Matches
    // SearchAgent.learn()'s no-probe-path dispatch (and the M7.7 CSV
    // path contract).
    articleIds: [],
    enrichmentType,
  });
}

/**
 * Persist the chat state on `chat.context.state`. Uses `asAdmin` because
 * the caller may be a singleton agent (SearchAgent, future
 * SourceOrchestrator) running outside any per-user RLS transaction.
 * The chatId scope is enforced by the WHERE — we only ever update
 * the one row the probe is for.
 */
async function setChatProbeState(
  chatId: string,
  state: 'awaiting_reach_upgrade_consent' | 'enriching',
): Promise<void> {
  await asAdmin(async (tx) => {
    const chat = await tx.chat.findUnique({ where: { id: chatId } });
    if (!chat) return; // Nothing to update — the chat was deleted mid-probe.
    const prevContext = (chat.context ?? {}) as ChatContext;
    if (prevContext.state === state) return; // Idempotent — no-op.
    const nextContext: ChatContext = { ...prevContext, state };
    await tx.chat.update({
      where: { id: chatId },
      data: { context: nextContext as unknown as object },
    });
  });
}
