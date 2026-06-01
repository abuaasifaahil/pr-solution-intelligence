import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorResult } from '../../src/agents/orchestrator.agent.js';
import type { Intent } from '../../src/types/intent.js';

vi.mock('../../src/lib/llm.js', () => ({
  chatComplete: vi.fn().mockResolvedValue('Got it. What date range should I analyze?'),
  parseChoice: vi.fn(),
  chatCompleteStream: vi.fn(),
}));

// M9.4 — mock the IntentExtractor + application service + chat-params getter
// so the orchestrator test stays a pure unit test (no LLM, no DB).
const extractIntentMock = vi.fn();
vi.mock('../../src/lib/intent-extractor.js', () => ({
  extractIntent: extractIntentMock,
}));

// Explicitly typed return so mockImplementationOnce can widen appliedFields
// to string[] (otherwise the initial `never[]` inference blocks per-test
// overrides — vi narrows aggressively).
const applyIntentMock = vi.fn<
  [string, string, Intent],
  Promise<{ appliedFields: string[]; skippedDueToConfidence: string[] }>
>(async () => ({
  appliedFields: [] as string[],
  skippedDueToConfidence: [] as string[],
}));
const markIntentExtractedMock = vi.fn(async () => {});
vi.mock('../../src/services/intent-application.service.js', () => ({
  applyIntentToChatParams: applyIntentMock,
  markIntentExtracted: markIntentExtractedMock,
}));

// In-memory chat_params fixture controlled per-test by setting `paramsFixture`.
let paramsFixture: {
  intentExtractedAt: Date | null;
  brand: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  enrichmentType: string | null;
  competitors: unknown;
  intention: string | null;
  mediaTypes: string[];
} = {
  intentExtractedAt: null,
  brand: null,
  dateStart: null,
  dateEnd: null,
  enrichmentType: null,
  competitors: [],
  intention: null,
  mediaTypes: [],
};
const getOrCreateParamsMock = vi.fn(async () => paramsFixture);
// Partial mock — keep the real Zod schemas (DataSourceSchema,
// MediaTypesSchema) because `types/intent.ts` re-exports DataSourceSchema
// from this module to build IntentSchema. Stub only the side-effecting
// functions the orchestrator calls.
vi.mock('../../src/services/chat-params.service.js', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('../../src/services/chat-params.service.js');
  return {
    ...actual,
    getOrCreateParams: getOrCreateParamsMock,
    patchParams: vi.fn(),
    suggestCompetitors: vi.fn(),
  };
});

const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  subscribeChatEvents: vi.fn(),
  publishAgentBus: vi.fn(),
}));

// M9.5.5 — mock the reach-probe service so the orchestrator's side-effect
// dispatch path can be asserted without touching Prisma or hitting the
// agent bus.
const resolveReachProbeMock = vi.fn(async () => {});
vi.mock('../../src/services/reach-probe.service.js', () => ({
  resolveReachProbe: resolveReachProbeMock,
  enterReachProbe: vi.fn(),
}));

// Silence agent_logs DB writes during tests.
vi.mock('@prsi/shared/db', () => ({
  prisma: {
    agentLog: { create: vi.fn(async () => ({})) },
  },
}));

const { OrchestratorAgent } = await import('../../src/agents/orchestrator.agent.js');
const { chatComplete, parseChoice } = await import('../../src/lib/llm.js');

/** Build a fully-confident, fully-populated Intent. */
function fullIntent(): Intent {
  return {
    brand: 'FreshSip',
    dateStart: '2026-04-01',
    dateEnd: '2026-05-01',
    competitors: ['PepsiCo', 'Coca-Cola'],
    intention: 'intention_based',
    enrichmentType: 'enrichment_plus_reach',
    mediaTypes: [],
    dataSource: null,
    confidence: {
      brand: 0.95,
      dateRange: 0.95,
      competitors: 0.95,
      intention: 0.95,
      enrichmentType: 0.95,
      mediaTypes: 0,
      dataSource: 0,
    },
  };
}

function resetParamsFixture(): void {
  paramsFixture = {
    intentExtractedAt: null,
    brand: null,
    dateStart: null,
    dateEnd: null,
    enrichmentType: null,
    competitors: [],
    intention: null,
    mediaTypes: [],
  };
}

describe('OrchestratorAgent.execute', () => {
  beforeEach(() => {
    (chatComplete as any).mockClear();
    (parseChoice as any).mockClear();
    extractIntentMock.mockReset();
    applyIntentMock.mockClear();
    markIntentExtractedMock.mockClear();
    getOrCreateParamsMock.mockClear();
    publishChatEventMock.mockClear();
    resolveReachProbeMock.mockClear();
    resolveReachProbeMock.mockResolvedValue(undefined);
    resetParamsFixture();
  });

  it('on a new chat (welcome state) with empty message → existing Phase 1 path (no extraction)', async () => {
    // createChat() calls the orchestrator with message=''. The hook gate
    // requires a non-empty message — so extraction MUST NOT fire here.
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: '',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
  });

  it('on a new chat (welcome state) advances to awaiting_date and returns LLM phrasing + chips', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze brand sentiment',
      metadata: { currentState: 'welcome', currentContext: {}, choice: 'analyze_sentiment' },
    });
    // Has a chip click → hook gate (no choice) fails → no extraction.
    expect(extractIntentMock).not.toHaveBeenCalled();
    expect(out.replyText).toBe('Got it. What date range should I analyze?');
    expect(out.chips.map((c: any) => c.value)).toEqual(['weekly', '10days', '20days', 'custom']);
    expect(out.contextPatch.state).toBe('awaiting_date');
  });

  it('on awaiting_date with chip click stores dateRange and advances', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'weekly',
      metadata: { currentState: 'awaiting_date', currentContext: {}, choice: 'weekly' },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
    expect(out.contextPatch.state).toBe('awaiting_enrichment');
    expect(out.contextPatch.dateRange).toEqual({ type: 'weekly' });
  });

  it('on awaiting_date with free text "last week" calls parseChoice and stores weekly', async () => {
    (parseChoice as any).mockResolvedValue('weekly');
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'last week',
      metadata: { currentState: 'awaiting_date', currentContext: {} },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
    expect(parseChoice).toHaveBeenCalled();
    expect(out.contextPatch.dateRange).toEqual({ type: 'weekly' });
  });

  it('on ready state, stays in ready', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'anything',
      metadata: { currentState: 'ready', currentContext: { brand: 'FreshSip' } },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
    expect(out.contextPatch.state ?? 'ready').toBe('ready');
  });
});

// ─── M9.4 — IntentExtractor hook ─────────────────────────────────────────────
describe('OrchestratorAgent.execute — M9.4 intent extraction hook', () => {
  beforeEach(() => {
    (chatComplete as any).mockClear();
    (parseChoice as any).mockClear();
    extractIntentMock.mockReset();
    applyIntentMock.mockClear();
    markIntentExtractedMock.mockClear();
    getOrCreateParamsMock.mockClear();
    publishChatEventMock.mockClear();
    resolveReachProbeMock.mockClear();
    resolveReachProbeMock.mockResolvedValue(undefined);
    resetParamsFixture();
  });

  it('first user message after welcome triggers extractIntent → emits intent:extracting + intent:extracted', async () => {
    extractIntentMock.mockResolvedValueOnce(fullIntent());
    // After applyIntentToChatParams runs, the fixture should reflect what
    // chat_params would look like — emulate that here.
    applyIntentMock.mockImplementationOnce(async () => {
      paramsFixture.brand = 'FreshSip';
      paramsFixture.dateStart = new Date('2026-04-01');
      paramsFixture.dateEnd = new Date('2026-05-01');
      paramsFixture.enrichmentType = 'reach';
      paramsFixture.competitors = ['PepsiCo', 'Coca-Cola'];
      paramsFixture.intention = 'intention_based';
      return { appliedFields: ['brand', 'dateRange'], skippedDueToConfidence: [] };
    });

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze FreshSip from April 1 to May 1, intention-based, compare with PepsiCo and Coca-Cola with reach',
      metadata: { currentState: 'welcome', currentContext: {} },
    });

    expect(extractIntentMock).toHaveBeenCalledTimes(1);
    expect(applyIntentMock).toHaveBeenCalledTimes(1);
    expect(markIntentExtractedMock).toHaveBeenCalledTimes(1);

    const eventTypes = publishChatEventMock.mock.calls.map((c) => c[1]);
    expect(eventTypes).toContain('intent:extracting');
    expect(eventTypes).toContain('intent:extracted');
  });

  it('intent fully fills all slots → next state = "ready"', async () => {
    extractIntentMock.mockResolvedValueOnce(fullIntent());
    applyIntentMock.mockImplementationOnce(async () => {
      paramsFixture.brand = 'FreshSip';
      paramsFixture.dateStart = new Date('2026-04-01');
      paramsFixture.dateEnd = new Date('2026-05-01');
      paramsFixture.enrichmentType = 'reach';
      paramsFixture.competitors = ['PepsiCo', 'Coca-Cola'];
      paramsFixture.intention = 'intention_based';
      return { appliedFields: [], skippedDueToConfidence: [] };
    });

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze FreshSip ...',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(out.contextPatch.state).toBe('ready');
  });

  it('intent fills brand+date+enrichment only → next state = "awaiting_competitors"', async () => {
    const intent = fullIntent();
    intent.competitors = [];
    intent.intention = null;
    extractIntentMock.mockResolvedValueOnce(intent);
    applyIntentMock.mockImplementationOnce(async () => {
      paramsFixture.brand = 'FreshSip';
      paramsFixture.dateStart = new Date('2026-04-01');
      paramsFixture.dateEnd = new Date('2026-05-01');
      paramsFixture.enrichmentType = 'reach';
      // competitors still empty, intention still null → first unfilled is competitors
      return { appliedFields: [], skippedDueToConfidence: [] };
    });

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze FreshSip from April 1 to May 1 with reach',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(out.contextPatch.state).toBe('awaiting_competitors');
    // Chips should match the competitor state
    expect(out.chips.map((c) => c.value)).toEqual(['top5', 'top3', 'top2', 'other']);
  });

  it('intent fills date+enrichment (no brand) → next state = "awaiting_brand"', async () => {
    const intent = fullIntent();
    intent.brand = null;
    intent.competitors = [];
    intent.intention = null;
    extractIntentMock.mockResolvedValueOnce(intent);
    applyIntentMock.mockImplementationOnce(async () => {
      paramsFixture.dateStart = new Date('2026-04-01');
      paramsFixture.dateEnd = new Date('2026-05-01');
      paramsFixture.enrichmentType = 'reach';
      return { appliedFields: [], skippedDueToConfidence: [] };
    });

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'I want reach metrics from April 1 to May 1',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(out.contextPatch.state).toBe('awaiting_brand');
    expect(out.chips).toEqual([]); // free-text state
  });

  it('extractIntent throws → falls back to normal welcome→awaiting_date (no intent:extracted emit)', async () => {
    extractIntentMock.mockRejectedValueOnce(new Error('LLM 500'));

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze FreshSip',
      metadata: { currentState: 'welcome', currentContext: {} },
    });

    // Fall-back: state advances to awaiting_date via normal advance()
    expect(out.contextPatch.state).toBe('awaiting_date');

    // intent:extracting was emitted (we started extraction); intent:extracted was NOT.
    const eventTypes = publishChatEventMock.mock.calls.map((c) => c[1]);
    expect(eventTypes).toContain('intent:extracting');
    expect(eventTypes).not.toContain('intent:extracted');

    expect(applyIntentMock).not.toHaveBeenCalled();
    expect(markIntentExtractedMock).not.toHaveBeenCalled();
  });

  it('currentState is NOT "welcome" → intent extraction is NOT called', async () => {
    extractIntentMock.mockResolvedValueOnce(fullIntent());
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Hello!',
      metadata: { currentState: 'awaiting_brand', currentContext: {} },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
  });

  it('chat_params already has intentExtractedAt → not re-called', async () => {
    paramsFixture.intentExtractedAt = new Date('2026-05-01T12:00:00Z');
    extractIntentMock.mockResolvedValueOnce(fullIntent());
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze FreshSip',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
    // Falls back to the normal welcome→awaiting_date path.
    expect(out.contextPatch.state).toBe('awaiting_date');
    // No intent:extracting either — we never started the extraction.
    const eventTypes = publishChatEventMock.mock.calls.map((c) => c[1]);
    expect(eventTypes).not.toContain('intent:extracting');
  });

  it('chip click on welcome (choice present) → intent extraction is NOT called', async () => {
    extractIntentMock.mockResolvedValueOnce(fullIntent());
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze brand sentiment',
      metadata: {
        currentState: 'welcome',
        currentContext: {},
        choice: 'analyze_sentiment',
      },
    });
    expect(extractIntentMock).not.toHaveBeenCalled();
  });

  it('extraction succeeds but yields only awaiting_date → no skip (falls back to normal flow)', async () => {
    // Confidence all zero / nothing applied → nextUnfilledState returns
    // 'awaiting_date' (nothing changed). The orchestrator should treat
    // that as "no skip" and run the normal welcome transition so the user
    // still sees a coherent first prompt.
    extractIntentMock.mockResolvedValueOnce({
      brand: null,
      dateStart: null,
      dateEnd: null,
      competitors: [],
      intention: null,
      enrichmentType: null,
      mediaTypes: [],
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
    } as Intent);

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'hi',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
    expect(extractIntentMock).toHaveBeenCalled();
    // applyIntentToChatParams still called (it's a no-op on no-fields)
    expect(applyIntentMock).toHaveBeenCalled();
    expect(markIntentExtractedMock).toHaveBeenCalled();
    // intent:extracted IS emitted (we ran the extractor) even though the
    // result is "no fields filled".
    const eventTypes = publishChatEventMock.mock.calls.map((c) => c[1]);
    expect(eventTypes).toContain('intent:extracted');
    // State advances via normal welcome→awaiting_date path.
    expect(out.contextPatch.state).toBe('awaiting_date');
  });
});

// ─── M9.5.5 — reach-probe state side-effect dispatch ─────────────────────
describe('OrchestratorAgent.execute — M9.5.5 reach probe state', () => {
  beforeEach(() => {
    (chatComplete as any).mockClear();
    (parseChoice as any).mockClear();
    extractIntentMock.mockReset();
    applyIntentMock.mockClear();
    markIntentExtractedMock.mockClear();
    getOrCreateParamsMock.mockClear();
    publishChatEventMock.mockClear();
    resolveReachProbeMock.mockClear();
    resolveReachProbeMock.mockResolvedValue(undefined);
    resetParamsFixture();
  });

  it('valid chip click "upgrade_similarweb" → resolveReachProbe called with the choice', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'add similarweb',
      metadata: {
        currentState: 'awaiting_reach_upgrade_consent',
        currentContext: { state: 'awaiting_reach_upgrade_consent' },
        choice: 'upgrade_similarweb',
      },
    });

    expect(resolveReachProbeMock).toHaveBeenCalledTimes(1);
    expect(resolveReachProbeMock).toHaveBeenCalledWith('u1', 'c1', 'upgrade_similarweb');
    // The wizard advances out of the probe state.
    expect(out.contextPatch.state).toBe('enriching');
    expect(out.chips).toEqual([]);
    // No intent extraction on this path (state is not 'welcome').
    expect(extractIntentMock).not.toHaveBeenCalled();
  });

  it('valid chip click "continue_without_reach" → resolveReachProbe called with the choice', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'continue without reach',
      metadata: {
        currentState: 'awaiting_reach_upgrade_consent',
        currentContext: { state: 'awaiting_reach_upgrade_consent' },
        choice: 'continue_without_reach',
      },
    });

    expect(resolveReachProbeMock).toHaveBeenCalledTimes(1);
    expect(resolveReachProbeMock).toHaveBeenCalledWith(
      'u1',
      'c1',
      'continue_without_reach',
    );
    expect(out.contextPatch.state).toBe('enriching');
  });

  it('invalid choice ("gibberish") → resolveReachProbe NOT called, stays in probe state', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'gibberish',
      metadata: {
        currentState: 'awaiting_reach_upgrade_consent',
        currentContext: { state: 'awaiting_reach_upgrade_consent' },
        choice: 'gibberish',
      },
    });

    expect(resolveReachProbeMock).not.toHaveBeenCalled();
    // Re-prompt: stay in probe state, chips re-issued.
    expect(out.contextPatch.state).toBeUndefined();
    expect(out.chips.map((c) => c.value)).toEqual([
      'upgrade_similarweb',
      'continue_without_reach',
    ]);
  });

  it('free-text in probe state without a parsed choice → resolveReachProbe NOT called', async () => {
    // parseChoice returns null → advanceInput becomes { freeText: ... }
    // → advance() falls through to the "stay in state" branch.
    (parseChoice as any).mockResolvedValueOnce(null);

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'what are these options?',
      metadata: {
        currentState: 'awaiting_reach_upgrade_consent',
        currentContext: { state: 'awaiting_reach_upgrade_consent' },
      },
    });

    expect(resolveReachProbeMock).not.toHaveBeenCalled();
  });

  it('resolveReachProbe error surfaces as a chat error event and re-throws', async () => {
    resolveReachProbeMock.mockRejectedValueOnce(new Error('dispatch failed'));

    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    await expect(
      agent.execute<OrchestratorResult>({
        userId: 'u1',
        chatId: 'c1',
        message: 'add similarweb',
        metadata: {
          currentState: 'awaiting_reach_upgrade_consent',
          currentContext: { state: 'awaiting_reach_upgrade_consent' },
          choice: 'upgrade_similarweb',
        },
      }),
    ).rejects.toThrow(/dispatch failed/);

    const errorEvents = publishChatEventMock.mock.calls.filter((c) => c[1] === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0]![2] as { message: string }).message).toMatch(/dispatch failed/);
  });
});
