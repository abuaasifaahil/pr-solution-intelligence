/**
 * Bridges DataExtractAgent → EnrichmentAgent via Redis pub/sub — M8.4.
 *
 * The Phase 2 DataExtractAgent's `handoff` step publishes a payload to the
 * `agent:enrichment:incoming` channel after its 7-step pipeline commits.
 * This subscriber turns each publish into a single EnrichmentAgent invocation
 * (which writes the job + batches and fans out per-batch BullMQ jobs).
 *
 * The subscriber uses its OWN ioredis connection because ioredis enters a
 * dedicated subscribe mode (cannot multiplex SUBSCRIBE with regular commands
 * on the shared client from `lib/redis.ts`). Following the same pattern that
 * `subscribeChatEvents` uses for per-chat channels, but for the cross-agent
 * bus.
 *
 * @file backend/src/agents/enrichment-subscriber.ts
 */
import { Redis } from 'ioredis';
import { AgentRegistry } from './agent-registry.js';
import type { EnrichmentAgent } from './enrichment.agent.js';

const CHANNEL = 'agent:enrichment:incoming';

interface IncomingPayload {
  chatId: string;
  userId: string;
  articleIds: string[];
  enrichmentType?: 'standard' | 'reach';
}

let subscriber: Redis | undefined;

/**
 * Start the enrichment subscriber. Idempotent — repeat calls are no-ops.
 * Skips when NODE_ENV=test or REDIS_URL is unset so unit tests / Redis-less
 * dev environments don't open a connection they can't use. Errors during
 * subscribe are logged but never thrown — the server boot must not block on
 * pub/sub availability.
 */
export function startEnrichmentSubscriber(): void {
  if (subscriber) return;
  if (process.env.NODE_ENV === 'test') return;
  if (!process.env.REDIS_URL) return;
  subscriber = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.subscribe(CHANNEL, (err) => {
    if (err) {
      // eslint-disable-next-line no-console
      console.error('[enrichment-subscriber] subscribe failed', err);
    }
  });
  subscriber.on('message', (chan, raw) => {
    if (chan !== CHANNEL) return;
    void handleMessage(raw);
  });
}

/**
 * Process one cross-agent bus message. Parses the payload, looks up the
 * singleton EnrichmentAgent, and invokes execute() with the standard
 * AgentInput shape. Errors at any step are logged — never thrown — because
 * the ioredis 'message' callback has no caller to absorb a rejection.
 *
 * Exported for unit testing only.
 */
export async function handleMessage(raw: string): Promise<void> {
  let payload: IncomingPayload;
  try {
    payload = JSON.parse(raw) as IncomingPayload;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[enrichment-subscriber] malformed payload', { raw, err });
    return;
  }

  const agent = AgentRegistry.getByType('enrichment') as EnrichmentAgent | null;
  if (!agent) {
    // eslint-disable-next-line no-console
    console.error('[enrichment-subscriber] no EnrichmentAgent registered');
    return;
  }

  try {
    await agent.execute({
      userId: payload.userId,
      chatId: payload.chatId,
      message: '',
      metadata: {
        articleIds: payload.articleIds ?? [],
        enrichmentType: payload.enrichmentType,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[enrichment-subscriber] agent execute failed', err);
  }
}

/** Test / shutdown helper — disconnects the subscriber and clears state. */
export async function stopEnrichmentSubscriber(): Promise<void> {
  if (!subscriber) return;
  try {
    await subscriber.unsubscribe(CHANNEL);
  } catch {
    /* shutdown errors ignored */
  }
  subscriber.disconnect();
  subscriber = undefined;
}

export const ENRICHMENT_INCOMING_CHANNEL = CHANNEL;
