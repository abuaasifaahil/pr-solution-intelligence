import { BaseAgent, type AgentInput } from './base-agent.js';
import {
  advance,
  CHIP_OPTIONS_BY_STATE,
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  type ConversationState,
  type ChatContext,
  type Chip,
  type AdvanceInput,
} from './orchestrator-state.js';
import { chatComplete, chatCompleteStream, parseChoice } from '../lib/llm.js';
import { publishChatEvent } from '../lib/event-bus.js';

interface OrchestratorInput extends AgentInput {
  metadata?: {
    currentState?: ConversationState;
    currentContext?: ChatContext;
    choice?: string;
  };
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
   * Streaming entry point. Mirrors `execute()` but routes through `actStreaming`.
   * Required extras on `input`: `chatId` and `assistantMessageId`.
   */
  async executeStreaming(input: AgentInput & {
    chatId: string;
    assistantMessageId: string;
  }): Promise<OrchestratorResult> {
    const start = Date.now();
    try {
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

export { WELCOME_CHIPS_BY_AGENT } from './orchestrator-state.js';
