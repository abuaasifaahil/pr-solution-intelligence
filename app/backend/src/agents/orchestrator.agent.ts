import { BaseAgent, type AgentInput } from './base-agent.js';
import {
  advance,
  CHIPS_FOR_STATE,
  CHIP_OPTIONS_BY_STATE,
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  nextUnfilledState,
  type ChatParamsShape,
  type ConversationState,
  type ChatContext,
  type Chip,
  type AdvanceInput,
} from './orchestrator-state.js';
import { chatComplete, chatCompleteStream, parseChoice } from '../lib/llm.js';
import { publishChatEvent } from '../lib/event-bus.js';
import { extractIntent } from '../lib/intent-extractor.js';
import { unfilledFields, type Intent } from '../types/intent.js';
import { getOrCreateParams } from '../services/chat-params.service.js';
import {
  applyIntentToChatParams,
  markIntentExtracted,
} from '../services/intent-application.service.js';

interface OrchestratorInput extends AgentInput {
  metadata?: {
    currentState?: ConversationState;
    currentContext?: ChatContext;
    choice?: string;
  };
}

/**
 * Result of the M9.4 intent-extraction hook. When `skipTo` is non-null the
 * orchestrator should produce an LLM phrasing that prompts the user for
 * `skipTo` (the first unfilled slot), with the matching chips, instead of
 * routing the message through the regular state machine. `null` means
 * "extraction either ran but didn't help (target state is still
 * awaiting_date — no actual skip) OR was inapplicable/failed — fall back
 * to the normal welcome→awaiting_date transition".
 */
interface IntentHookResult {
  skipTo: Exclude<ConversationState, 'welcome' | 'awaiting_date'> | null;
}

export interface OrchestratorResult {
  replyText: string;
  chips: Chip[];
  contextPatch: Partial<ChatContext>;
}

interface PerceivedContext {
  state: ConversationState;
  context: ChatContext;
  message: string;
  choice?: string;
  agentType: string;
}

/**
 * `Reasoned` carries both the advance input AND the state from perceive,
 * so plan() doesn't need a side channel. The singleton OrchestratorAgent in
 * the registry is shared across concurrent requests for the same agentType,
 * so per-request state must flow through the lifecycle methods rather than
 * being stashed on `this`.
 */
interface Reasoned {
  advanceInput: AdvanceInput;
  state: ConversationState;
}

interface PlanItem {
  advanceInput: AdvanceInput;
  agentType: string;
  state: ConversationState;
}

interface ActOutput extends OrchestratorResult { /* same */ }

export class OrchestratorAgent extends BaseAgent {
  async perceive(input: AgentInput): Promise<PerceivedContext> {
    const o = input as OrchestratorInput;
    const state = o.metadata?.currentState ?? INITIAL_STATE;
    const context = o.metadata?.currentContext ?? {};
    return {
      state,
      context,
      message: o.message,
      choice: o.metadata?.choice,
      agentType: this.type,
    };
  }

  async reason(ctx: unknown): Promise<Reasoned> {
    const p = ctx as PerceivedContext;
    // If a chip click came in, use it directly.
    if (p.choice) return { advanceInput: { choice: p.choice }, state: p.state };
    // Otherwise try to extract a choice from free text via the LLM for states with chips.
    const options = CHIP_OPTIONS_BY_STATE[p.state];
    if (options) {
      const parsed = await parseChoice(p.message, options);
      if (parsed) return { advanceInput: { choice: parsed }, state: p.state };
    }
    return { advanceInput: { freeText: p.message }, state: p.state };
  }

  async plan(goal: unknown): Promise<PlanItem> {
    const { advanceInput, state } = goal as Reasoned;
    return { advanceInput, agentType: this.type, state };
  }

  async act(plan: unknown): Promise<ActOutput> {
    const { advanceInput, agentType, state } = plan as PlanItem;
    const r = advance(state, advanceInput, agentType);
    const phrasingSystemPrompt =
      `You are ${this.name}, a specialized AI for PR/media analysis. ` +
      `Reply in a friendly, professional tone. Keep replies under 2 sentences unless summarizing. ` +
      `Do not use markdown formatting.`;
    const replyText = await chatComplete({
      system: phrasingSystemPrompt,
      messages: [{ role: 'user', content: r.replyTemplate }],
    });
    return {
      replyText: replyText.trim(),
      chips: r.chips,
      contextPatch: r.contextPatch,
    };
  }

  async reflect(_result: unknown): Promise<void> {
    // No-op for M3. M5 Learning Agent will populate this.
  }

  /**
   * Build the LLM phrasing prompt to use after a successful intent skip.
   * Mirrors the "ask about the next slot" tone used by `advance()` for each
   * state, but acknowledges what was already extracted so the user doesn't
   * feel re-interrogated.
   *
   * Exported as `static` for testability (no this-bound state needed).
   */
  static buildSkipReplyTemplate(
    target: Exclude<ConversationState, 'welcome'>,
    intent: Intent,
  ): string {
    // Per-slot acknowledgement clause. Only mention slots that DID get
    // applied (non-null + sufficient confidence) — leaving "extracted but
    // skipped on confidence" silent so we don't surface low-confidence
    // guesses to the user.
    const ack: string[] = [];
    if (intent.brand) ack.push(`brand "${intent.brand}"`);
    if (intent.dateStart && intent.dateEnd)
      ack.push(`dates ${intent.dateStart} to ${intent.dateEnd}`);
    if (intent.competitors.length > 0)
      ack.push(`competitors ${intent.competitors.join(', ')}`);
    if (intent.intention) ack.push(`${intent.intention.replace('_', '-')} analysis`);
    if (intent.enrichmentType)
      ack.push(intent.enrichmentType === 'enrichment_plus_reach' ? 'reach metrics' : 'standard enrichment');

    const ackClause =
      ack.length > 0
        ? `Acknowledge that the user already specified ${ack.join(', ')}.`
        : 'Acknowledge the user briefly.';

    switch (target) {
      case 'awaiting_date':
        return `${ackClause} Ask which date range to analyze. Two sentences max.`;
      case 'awaiting_enrichment':
        return `${ackClause} Ask whether to run plain enrichment or enrichment + reach metrics. Two sentences max.`;
      case 'awaiting_brand':
        return `${ackClause} Ask the user to type the brand name they want to analyze. One sentence.`;
      case 'awaiting_competitors':
        return `${ackClause} Ask which competitor preset to compare against. Two sentences max.`;
      case 'awaiting_intention':
        return `${ackClause} Ask whether to analyze by intention or by comments. Two sentences max.`;
      case 'ready':
        return (
          `${ackClause} Confirm that all parameters are captured and the analysis is ready to run. ` +
          `Briefly summarize the brand, dates, enrichment, competitors, and intention. ` +
          `End with: "Phase 2 plugs in real PR analysis. For now, click New Chat to start over."`
        );
      default: {
        // Exhaustive guard.
        const _exhaustive: never = target;
        throw new Error(`Unhandled skip target: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * M9.4 intent-extraction hook. Runs ONLY on the first user message after
   * the welcome state, before the state machine takes over. On success it
   * pre-fills chat_params, stamps the idempotency flag, emits
   * `intent:extracting` + `intent:extracted`, and reports which state the
   * orchestrator should jump to. On any failure (LLM error, JSON parse
   * error, Zod rejection) it logs and returns `{skipTo: null}` so the
   * caller falls back to the normal welcome→awaiting_date transition.
   *
   * Idempotency: skipped if chat_params.intentExtractedAt is already set.
   * Caller pre-checks `state === 'welcome'` + non-empty user message +
   * absence of a chip click; this method assumes those conditions hold.
   *
   * Exposed as a public method so the streaming entry point can reuse it.
   */
  async runIntentExtractionHook(
    userId: string,
    chatId: string,
    message: string,
  ): Promise<IntentHookResult> {
    // Idempotency gate. `getOrCreateParams` returns the row (lazily created)
    // — cheaper than a bespoke read because lazy-create is the existing
    // pattern in chat-params.service.
    let existingParams;
    try {
      existingParams = await getOrCreateParams(userId, chatId);
    } catch {
      // Chat ownership / RLS issue — fall back to vanilla flow rather than
      // surfacing a load-failure as a wizard step.
      return { skipTo: null };
    }
    if (existingParams.intentExtractedAt) {
      // Already ran for this chat; the wizard takes over from here.
      return { skipTo: null };
    }

    await publishChatEvent(chatId, 'intent:extracting', { chatId });

    let intent: Intent;
    try {
      intent = await extractIntent(userId, message);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[orchestrator] IntentExtractor failed; falling back to wizard', {
        chatId,
        err: (err as Error).message,
      });
      return { skipTo: null };
    }

    // Apply non-null, confident fields → chat_params. Errors here are
    // serious (DB write failure) — let them propagate. The caller's
    // BaseAgent.execute() will log via agent_logs and re-throw.
    await applyIntentToChatParams(userId, chatId, intent);
    await markIntentExtracted(userId, chatId);

    await publishChatEvent(chatId, 'intent:extracted', {
      chatId,
      intent,
      unfilledFields: unfilledFields(intent),
    });

    // Reload params after the patch so the skip helper sees the writes.
    const reloaded = await getOrCreateParams(userId, chatId);
    const target = nextUnfilledState(reloaded as ChatParamsShape);

    // If the wizard would still start at `awaiting_date` (nothing useful
    // got pre-filled), there's no skip to perform — let the normal
    // welcome→awaiting_date transition run.
    if (target === 'awaiting_date') return { skipTo: null };

    return { skipTo: target };
  }

  /**
   * Streaming variant of act(): runs the same state-machine `advance()`, then
   * streams the LLM phrasing via `chatCompleteStream` and publishes each delta
   * to the chat's Redis channel as `message:chunk`. After the stream ends,
   * publishes `typing:stop` and returns the accumulated reply + chips +
   * context patch so the caller can persist the final assistant message.
   *
   * `chatId` and `assistantMessageId` are required so chunks can be routed
   * to the right placeholder bubble on the frontend.
   */
  async actStreaming(
    plan: { advanceInput: AdvanceInput; agentType: string; state: ConversationState },
    chatId: string,
    assistantMessageId: string,
  ): Promise<OrchestratorResult> {
    const { advanceInput, agentType, state } = plan;
    const r = advance(state, advanceInput, agentType);
    const phrasingSystemPrompt =
      `You are ${this.name}, a specialized AI for PR/media analysis. ` +
      `Reply in a friendly, professional tone. Keep replies under 2 sentences unless summarizing. ` +
      `Do not use markdown formatting.`;

    let full = '';
    try {
      for await (const delta of chatCompleteStream({
        system: phrasingSystemPrompt,
        messages: [{ role: 'user', content: r.replyTemplate }],
      })) {
        full += delta;
        await publishChatEvent(chatId, 'message:chunk', {
          assistantMessageId,
          delta,
        });
      }
      await publishChatEvent(chatId, 'typing:stop', { assistantMessageId });
    } catch (err) {
      await publishChatEvent(chatId, 'error', {
        assistantMessageId,
        message: (err as Error).message,
      });
      throw err;
    }

    return {
      replyText: full.trim(),
      chips: r.chips,
      contextPatch: r.contextPatch,
    };
  }

  /**
   * Build the assistant reply when M9.4 intent extraction has skipped the
   * wizard ahead by one or more states. Used by both the sync `execute()`
   * override and the streaming variant.
   *
   * `target` is the unfilled state we're jumping to (never `welcome`,
   * never `awaiting_date` — both are handled by the caller's fall-through
   * path). Returns the same shape as `act()`: replyText (LLM phrasing),
   * chips (for the target state), contextPatch (sets state=target).
   */
  async actAfterIntentSkip(
    target: Exclude<ConversationState, 'welcome' | 'awaiting_date'>,
    intent: Intent,
  ): Promise<OrchestratorResult> {
    const template = OrchestratorAgent.buildSkipReplyTemplate(target, intent);
    const phrasingSystemPrompt =
      `You are ${this.name}, a specialized AI for PR/media analysis. ` +
      `Reply in a friendly, professional tone. Keep replies under 2 sentences unless summarizing. ` +
      `Do not use markdown formatting.`;
    const replyText = await chatComplete({
      system: phrasingSystemPrompt,
      messages: [{ role: 'user', content: template }],
    });
    return {
      replyText: replyText.trim(),
      chips: CHIPS_FOR_STATE[target],
      // M9.4: contextPatch sets the skipped-to state. The Phase 1 wizard
      // reads `chat.context.state` for the NEXT turn's `currentState`, so
      // setting it here is what makes the skip "stick".
      contextPatch: { state: target },
    };
  }

  /**
   * Streaming variant of `actAfterIntentSkip`. Streams the LLM phrasing
   * delta-by-delta over the chat's WS channel, then emits `typing:stop`.
   */
  async actAfterIntentSkipStreaming(
    target: Exclude<ConversationState, 'welcome' | 'awaiting_date'>,
    intent: Intent,
    chatId: string,
    assistantMessageId: string,
  ): Promise<OrchestratorResult> {
    const template = OrchestratorAgent.buildSkipReplyTemplate(target, intent);
    const phrasingSystemPrompt =
      `You are ${this.name}, a specialized AI for PR/media analysis. ` +
      `Reply in a friendly, professional tone. Keep replies under 2 sentences unless summarizing. ` +
      `Do not use markdown formatting.`;

    let full = '';
    try {
      for await (const delta of chatCompleteStream({
        system: phrasingSystemPrompt,
        messages: [{ role: 'user', content: template }],
      })) {
        full += delta;
        await publishChatEvent(chatId, 'message:chunk', {
          assistantMessageId,
          delta,
        });
      }
      await publishChatEvent(chatId, 'typing:stop', { assistantMessageId });
    } catch (err) {
      await publishChatEvent(chatId, 'error', {
        assistantMessageId,
        message: (err as Error).message,
      });
      throw err;
    }

    return {
      replyText: full.trim(),
      chips: CHIPS_FOR_STATE[target],
      contextPatch: { state: target },
    };
  }

  /**
   * Sync entry point. Overrides BaseAgent.execute() to inject the M9.4
   * intent-extraction hook BEFORE the existing state machine path. The
   * hook only activates on `state === 'welcome'` with a non-empty user
   * message and no chip-click choice; everything else falls through to
   * the inherited pipeline so Phase 1 / Phase 2 behavior is unchanged.
   */
  override async execute<T = unknown>(input: AgentInput): Promise<T> {
    const o = input as OrchestratorInput;
    const state = o.metadata?.currentState ?? INITIAL_STATE;
    const choice = o.metadata?.choice;
    const message = o.message ?? '';
    // Gate: only run on the user's FIRST real message (state=welcome,
    // free-text only, chatId+userId available).
    if (state === 'welcome' && !choice && message.trim().length > 0 && input.chatId) {
      const hook = await this.runIntentExtractionHook(input.userId, input.chatId, message);
      if (hook.skipTo) {
        // We extracted enough to jump past at least `awaiting_date`. Build
        // the skip-state response and short-circuit the normal pipeline.
        // `runIntentExtractionHook` already emitted intent:extracted; we
        // need the intent object for the reply phrasing, so re-fetch via
        // chat_params is overkill — we already have it in the params row.
        // Cheapest path: rebuild a minimal Intent-shaped object from the
        // applied chat_params row so buildSkipReplyTemplate has something
        // to acknowledge. We rely on the params already containing the
        // newly-written fields (just stamped a few ms ago).
        const params = await getOrCreateParams(input.userId, input.chatId);
        const intentForReply: Intent = synthesizeIntentForReply(params);
        const result = await this.actAfterIntentSkip(hook.skipTo, intentForReply);
        // Mirror BaseAgent.execute()'s side-effects so external observers
        // (agent_logs, learning hook) still see the run.
        await this.reflect(result);
        await this.learn(result);
        await this.logAction('execute_intent_skip', input, result, 0);
        return result as T;
      }
    }
    return super.execute<T>(input);
  }

  /**
   * Streaming entry point. Mirrors `execute()` but routes through
   * `actStreaming`. Required extras on `input`: `chatId` and
   * `assistantMessageId`. M9.4 intent-extraction hook fires here too,
   * with its own streaming reply variant on a successful skip.
   */
  async executeStreaming(input: AgentInput & {
    chatId: string;
    assistantMessageId: string;
  }): Promise<OrchestratorResult> {
    const start = Date.now();
    try {
      // M9.4 intent-extraction hook — same gate as `execute()`.
      const o = input as OrchestratorInput;
      const state = o.metadata?.currentState ?? INITIAL_STATE;
      const choice = o.metadata?.choice;
      const message = o.message ?? '';
      if (state === 'welcome' && !choice && message.trim().length > 0) {
        const hook = await this.runIntentExtractionHook(
          input.userId,
          input.chatId,
          message,
        );
        if (hook.skipTo) {
          const params = await getOrCreateParams(input.userId, input.chatId);
          const intentForReply = synthesizeIntentForReply(params);
          const result = await this.actAfterIntentSkipStreaming(
            hook.skipTo,
            intentForReply,
            input.chatId,
            input.assistantMessageId,
          );
          await this.reflect(result);
          await this.learn(result);
          const duration = Date.now() - start;
          await this.logAction('execute_streaming_intent_skip', input, result, duration);
          return result;
        }
      }
      const ctx = await this.perceive(input);
      const goal = (await this.reason(ctx)) as {
        advanceInput: AdvanceInput;
        state: ConversationState;
      };
      const plan = await this.plan(goal);
      const result = await this.actStreaming(
        plan as { advanceInput: AdvanceInput; agentType: string; state: ConversationState },
        input.chatId,
        input.assistantMessageId,
      );
      await this.reflect(result);
      await this.learn(result);
      const duration = Date.now() - start;
      await this.logAction('execute_streaming', input, result, duration);
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      await this.logAction(
        'execute_streaming_failed',
        input,
        { error: (err as Error).message },
        duration,
      );
      throw err;
    }
  }
}

/**
 * Build a minimal Intent-shaped object from a chat_params row, used only
 * to phrase the skip reply (`buildSkipReplyTemplate` reads brand, dates,
 * competitors, intention, enrichmentType to compose the acknowledgement).
 *
 * Confidence scores are zeroed — they aren't displayed, only the value
 * presence matters for the template. `dataSource` is intentionally null
 * because we don't acknowledge it in the user-facing reply (it's a
 * backend routing concern).
 *
 * Translates chat_params.enrichmentType ('standard' | 'reach') back to
 * Intent's BRD wording ('enrichment' | 'enrichment_plus_reach') so the
 * template phrases enrichment correctly.
 */
function synthesizeIntentForReply(params: {
  brand: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  competitors: unknown;
  intention: string | null;
  mediaTypes?: string[];
}): Intent {
  const competitorsArr = Array.isArray(params.competitors)
    ? (params.competitors as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const mediaTypesArr = Array.isArray(params.mediaTypes)
    ? (params.mediaTypes as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  return {
    brand: params.brand ?? null,
    dateStart: params.dateStart ? toIsoDate(params.dateStart) : null,
    dateEnd: params.dateEnd ? toIsoDate(params.dateEnd) : null,
    competitors: competitorsArr,
    intention:
      params.intention === 'intention_based' || params.intention === 'comment_based'
        ? params.intention
        : null,
    enrichmentType:
      params.enrichmentType === 'standard'
        ? 'enrichment'
        : params.enrichmentType === 'reach'
          ? 'enrichment_plus_reach'
          : null,
    // The Intent schema enforces MediaTypeSchema; we cast through unknown
    // because we only need the count + names for the acknowledgement and
    // do not validate further here.
    mediaTypes: mediaTypesArr as Intent['mediaTypes'],
    dataSource: null,
    confidence: {
      brand: 0,
      dateRange: 0,
      competitors: 0,
      intention: 0,
      enrichmentType: 0,
      mediaTypes: 0,
      dataSource: 0,
    },
  };
}

function toIsoDate(d: Date): string {
  // YYYY-MM-DD, matching IntentSchema's ISO_DATE regex.
  return d.toISOString().slice(0, 10);
}

export { WELCOME_CHIPS_BY_AGENT } from './orchestrator-state.js';
