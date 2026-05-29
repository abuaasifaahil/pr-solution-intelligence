import { BaseAgent, type AgentInput } from './base-agent.js';
import {
  advance,
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  type ConversationState,
  type ChatContext,
  type Chip,
  type AdvanceInput,
} from './orchestrator-state.js';
import { chatComplete, parseChoice } from '../lib/llm.js';

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

interface PlanItem {
  advanceInput: AdvanceInput;
  agentType: string;
  state: ConversationState;
}

interface ActOutput extends OrchestratorResult { /* same */ }

export class OrchestratorAgent extends BaseAgent {
  /** Set by execute(); read by plan(). */
  private _currentState: ConversationState = INITIAL_STATE;

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

  async reason(ctx: unknown): Promise<AdvanceInput> {
    const p = ctx as PerceivedContext;
    // If a chip click came in, use it directly.
    if (p.choice) return { choice: p.choice };
    // Otherwise try to extract a choice from free text via the LLM for states with chips.
    const chipOptionsByState: Partial<Record<ConversationState, string[]>> = {
      awaiting_date: ['weekly', '10days', '20days', 'custom'],
      awaiting_enrichment: ['enrichment', 'enrichment_plus_reach'],
      awaiting_competitors: ['top5', 'top3', 'top2', 'other'],
      awaiting_intention: ['intention_based', 'comment_based'],
    };
    const options = chipOptionsByState[p.state];
    if (options) {
      const parsed = await parseChoice(p.message, options);
      if (parsed) return { choice: parsed };
    }
    return { freeText: p.message };
  }

  async plan(goal: unknown): Promise<PlanItem> {
    // Carry the advance input + agent context into act().
    const advanceInput = goal as AdvanceInput;
    return { advanceInput, agentType: this.type, state: this._currentState };
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

  override async execute<T = unknown>(input: AgentInput): Promise<T> {
    const o = input as OrchestratorInput;
    this._currentState = o.metadata?.currentState ?? INITIAL_STATE;
    return super.execute<T>(input);
  }
}

export { WELCOME_CHIPS_BY_AGENT } from './orchestrator-state.js';
