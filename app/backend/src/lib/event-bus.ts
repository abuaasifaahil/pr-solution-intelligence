import type Redis from 'ioredis';
import { getRedis } from './redis.js';
import type { Intent, IntentFieldKey } from '../types/intent.js';

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
  // Phase 3.5 (M9.3) — IntentExtractor LLM emits this once per chat, on the
  // user's first message, after parsing free text into structured chat_params
  // slots. The payload shape is captured in `IntentExtractedPayload` below.
  // Definition only — emission lands in M9.4 once the orchestrator hook
  // calls extractIntent().
  | 'intent:extracted'
  // Phase 3.5 (M9.4) — fired BEFORE the LLM call begins so the frontend can
  // render a "thinking…" indicator while extractIntent runs. Cold-start
  // Azure latency can hit ~17s, so this event matters for UX. Always
  // followed by either `intent:extracted` (success) or no further intent
  // event (silent fallback to wizard on LLM error).
  | 'intent:extracting'
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
  | 'enrichment:json-ready'
  // Phase 3.5 (M9.5) — SearchAgent lifecycle. Fires when chat_params.data_source
  // == 'opensearch' and the user confirms the generated boolean query.
  //   search:start    — fan-out begins. Payload includes resolved index list
  //                     preview (first 5) + total index count for visibility.
  //   search:progress — per-page progress as the search_after loop advances.
  //                     Frontend renders a running counter; one event per page.
  //   search:fetched  — every page returned + bulk-inserted to articles. The
  //                     terminal happy-path event for the FETCH phase; the
  //                     REASONING phase (presence detection + handoff) may
  //                     still pause via `reach:absent`.
  //   reach:absent    — field-presence detector found < 80% reach coverage on
  //                     the first batch AND chat_params.enrichmentType ==
  //                     'standard'. SearchAgent STOPS here; M9.5.5 wires the
  //                     chat state machine to surface a probe chip.
  //   search:complete — terminal event after handoff to EnrichmentAgent. Fires
  //                     when reach is present, or enrichmentType=='reach' (we
  //                     don't probe in that case), or count=0 (empty result).
  //   search:error    — terminal failure. No partial state — articles may have
  //                     been bulk-inserted for completed pages, but the
  //                     handoff did not run and search_history was not
  //                     written. The frontend should surface `message`.
  | 'search:start'
  | 'search:progress'
  | 'search:fetched'
  | 'reach:absent'
  | 'search:complete'
  | 'search:error'
  // Phase 3.5 (M9.5.5) — terminal event for the reach-probe handshake.
  // Emitted by `resolveReachProbe` after the user picks a chip in the
  // `awaiting_reach_upgrade_consent` state and the matching enrichment
  // dispatch has been queued. Frontend uses this to clear the probe chip
  // UI and switch to the `enrichment:*` event stream.
  | 'reach:resolved';

export interface ChatEvent {
  type: ChatEventType;
  payload: unknown;
}

/**
 * Payload for the `intent:extracted` event (M9.3 type, M9.4 emits).
 *
 * `unfilledFields` is the precomputed list of slots the orchestrator still
 * needs to prompt the user for — derived from `unfilledFields(intent)` in
 * `types/intent.ts`. M9.8's IntentExtractedCard renders the intent summary
 * and reads `unfilledFields` to mark which chips still need attention.
 */
export interface IntentExtractedPayload {
  chatId: string;
  intent: Intent;
  unfilledFields: IntentFieldKey[];
}

/**
 * Payload for the `intent:extracting` event (M9.4). Fired before the LLM
 * call begins so the frontend can show a loading state. The chatId is all
 * the consumer needs — there's no extracted data yet.
 */
export interface IntentExtractingPayload {
  chatId: string;
}

/**
 * M9.5 — SearchAgent event payloads.
 *
 * All events carry `chatId` so the per-chat WS multiplexer routes them
 * correctly. Numeric fields are emitted as plain `number` (not bigint) —
 * the totalHits count from OpenSearch can spike to millions, but Phase
 * 3.5's MAX_PAGES cap means we never report more than 10K rows from
 * SearchAgent itself, comfortably under Number.MAX_SAFE_INTEGER.
 */
export interface SearchStartPayload {
  chatId: string;
  /** Total number of OpenSearch indices that will be queried. */
  totalIndicesQueried: number;
  /** First 5 resolved indices for visibility in the UI; full list is huge. */
  indicesPreview: string[];
}

export interface SearchProgressPayload {
  chatId: string;
  /** Running tally of articles bulk-inserted so far. */
  totalSoFar: number;
  /** 1-based page counter — number of search_after pages completed. */
  pagesScanned: number;
  /** True when the loop is about to stop (no more hits or MAX_PAGES hit). */
  lastPage: boolean;
}

export interface SearchFetchedPayload {
  chatId: string;
  /** Distinct article rows newly written to the articles table. */
  articlesInserted: number;
  /** Indices that contributed at least one hit — full list, no truncation. */
  indicesQueried: string[];
  /** Wall-clock ms spent inside SearchAgent.act() from first page to last. */
  latencyMsTotal: number;
}

export interface ReachAbsentPayload {
  chatId: string;
  /** Fraction (0..1) of sampled articles with a finite reach value. */
  coverageReach: number;
  /** How many articles were inspected (capped at PRESENCE_SAMPLE_SIZE). */
  sampleSize: number;
  /** Always `true` in M9.5 — kept as a flag so M9.5.5 can flip it for
   *  silent paths (e.g. enterprise tier auto-upgrade). */
  suggestUpgrade: boolean;
}

export interface SearchCompletePayload {
  chatId: string;
  /** True when the EnrichmentAgent hand-off was dispatched. False on
   *  zero-hits — the chat is still in a clean terminal state, just empty. */
  ready: boolean;
  /** Distinct articles bulk-inserted across the whole fetch loop. */
  count: number;
}

export interface SearchErrorPayload {
  chatId: string;
  /** Friendly, user-facing failure reason. */
  message: string;
  /** Populated when the failure came from `search()`'s retry loop. */
  retriesUsed?: number;
}

/**
 * M9.5.5 — payload for `reach:resolved`. The user's chip choice from the
 * `awaiting_reach_upgrade_consent` state. `upgrade_similarweb` means the
 * downstream EnrichmentAgent + SimilarWebAgent fan-out is about to run;
 * `continue_without_reach` means only EnrichmentAgent runs (comment-based).
 */
export interface ReachResolvedPayload {
  chatId: string;
  choice: 'upgrade_similarweb' | 'continue_without_reach';
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
