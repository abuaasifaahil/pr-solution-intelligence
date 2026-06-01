import type Redis from 'ioredis';
import { getRedis } from './redis.js';

export type ChatEventType =
  | 'typing:start'
  | 'typing:stop'
  | 'message:chunk'
  | 'message:new'
  | 'agent:progress'
  | 'error'
  // Phase 2 — upload pipeline (M7.4) emits these on the chat channel so the
  // frontend can react when a queued parse-upload job lands or fails.
  | 'upload:parsed'
  | 'upload:error'
  // Phase 2 — conversational flow engine (M7.5) emits this when chat_params
  // advances through the 9-state machine.
  | 'flow:state-change'
  // Phase 2 — DataExtractAgent (M7.7) emits one `processing:step` per step
  // in its 7-step pipeline, and a final `processing:complete` when the run
  // finishes successfully.
  | 'processing:step'
  | 'processing:complete'
  // Phase 3 — EnrichmentAgent (M8.4) announces that batching is planned and
  // per-batch jobs are about to land. M8.5 adds the per-batch lifecycle
  // events emitted by the EnrichBatchWorker:
  //   batch-start    — worker begins processing a batch (LLM call about to fire)
  //   batch-complete — batch wrote N enrichment rows, captured token usage
  //   batch-error    — batch threw; payload.retrying flags whether BullMQ
  //                    will retry (retry_count ≤ MAX_RETRIES) or give up
  //   progress       — running tally toward the job total, percent included
  //   complete       — final job-level event after the last batch settles
  // M8.6 adds the parallel reach pipeline driven by SimilarWebAgent:
  //   reach-start    — fan-out begins (after DISTINCT publisher_domain query)
  //   reach-complete — merge into enrichments.reach JSONB done; coverage stats
  // The reach-* events fire INDEPENDENTLY of `enrichment:complete` (LLM side);
  // the frontend treats them as two separate signals and waits for both when
  // enrichmentType=='reach'.
  // M8.7 adds the terminal `json-ready` event emitted by GET /enrich/json
  // the first time the dashboard JSON is computed for a chat. Phase 4
  // listens for this to flip its ChipUp artifact into "ready" state.
  | 'enrichment:start'
  | 'enrichment:batch-start'
  | 'enrichment:batch-complete'
  | 'enrichment:batch-error'
  | 'enrichment:progress'
  | 'enrichment:complete'
  | 'enrichment:reach-start'
  | 'enrichment:reach-complete'
  | 'enrichment:json-ready';

export interface ChatEvent {
  type: ChatEventType;
  payload: unknown;
}

function channelFor(chatId: string): string {
  return `chat:${chatId}:events`;
}

/**
 * Publish a single chat event on the chat's pub/sub channel. The publisher
 * reuses the shared singleton ioredis connection (`getRedis()`). Fire-and-
 * forget from the caller's perspective — errors are logged, never thrown.
 */
export async function publishChatEvent(
  chatId: string,
  type: ChatEventType,
  payload: unknown,
): Promise<void> {
  const pub = getRedis();
  const message = JSON.stringify({ type, payload });
  try {
    await pub.publish(channelFor(chatId), message);
  } catch (err) {
    // Pub/sub failure must never break the streaming task.
    // eslint-disable-next-line no-console
    console.error('[event-bus] publish failed', { chatId, type, err });
  }
}

/**
 * Publish to an arbitrary Redis pub/sub channel (not the per-chat one).
 * Used by the Phase 3 cross-agent bus (e.g. `agent:enrichment:incoming`)
 * to hand control off between agents that live in the same process but
 * are decoupled through the message bus. Errors are logged, not thrown —
 * the publish must never break the publishing agent's lifecycle.
 */
export async function publishAgentBus(
  channel: string,
  payload: unknown,
): Promise<void> {
  const pub = getRedis();
  try {
    await pub.publish(channel, JSON.stringify(payload));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[event-bus] agent-bus publish failed', { channel, err });
  }
}

/**
 * Subscribe to all events for a chat. Returns an `unsubscribe()` that closes
 * the duplicated ioredis connection. ioredis requires a separate connection
 * for SUBSCRIBE mode (cannot multiplex with the shared publisher), so each
 * subscriber gets its own duplicate.
 */
export async function subscribeChatEvents(
  chatId: string,
  handler: (event: ChatEvent) => void,
): Promise<() => Promise<void>> {
  const base = getRedis();
  const sub: Redis = base.duplicate();
  const channel = channelFor(chatId);

  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return;
    try {
      const parsed = JSON.parse(raw) as ChatEvent;
      handler(parsed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[event-bus] malformed event', { ch, raw, err });
    }
  });

  await sub.subscribe(channel);

  return async () => {
    try {
      await sub.unsubscribe(channel);
      await sub.quit();
    } catch {
      /* shutdown errors ignored */
    }
  };
}
