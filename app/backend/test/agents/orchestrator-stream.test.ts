import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM and event-bus modules.
const streamMock = vi.fn();
vi.mock('../../src/lib/llm.js', () => ({
  chatComplete: vi.fn(),
  chatCompleteStream: (...args: unknown[]) => streamMock(...args),
  parseChoice: vi.fn(),
}));
const publishMock = vi.fn(async () => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishMock,
}));

// BaseAgent.logAction hits prisma — short-circuit it via vi.mock of the shared db.
vi.mock('@prsi/shared/db', () => ({
  prisma: { agentLog: { create: vi.fn() } },
}));

const { OrchestratorAgent } = await import('../../src/agents/orchestrator.agent.js');

function makeStream(deltas: string[]) {
  return (async function* () {
    for (const d of deltas) yield d;
  })();
}

describe('OrchestratorAgent.executeStreaming', () => {
  beforeEach(() => {
    streamMock.mockReset();
    publishMock.mockClear();
  });

  it('publishes one message:chunk per delta and returns the joined replyText + chips + contextPatch', async () => {
    streamMock.mockReturnValue(makeStream(['Got ', 'it. ', 'Weekly?']));
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');

    const out = await agent.executeStreaming({
      userId: 'u1',
      chatId: 'c1',
      assistantMessageId: 'm-placeholder',
      message: 'Analyze brand sentiment',
      metadata: { currentState: 'welcome', currentContext: {} },
    });

    expect(out.replyText).toBe('Got it. Weekly?');
    expect(out.chips.map((c) => c.value)).toEqual(['weekly', '10days', '20days', 'custom']);
    expect(out.contextPatch.state).toBe('awaiting_date');

    // Each delta was published.
    const chunkCalls = publishMock.mock.calls.filter(([, type]) => type === 'message:chunk');
    expect(chunkCalls.map((c) => (c[2] as { delta: string }).delta)).toEqual(['Got ', 'it. ', 'Weekly?']);
    // typing:stop was published once at the end.
    const typingStops = publishMock.mock.calls.filter(([, type]) => type === 'typing:stop');
    expect(typingStops).toHaveLength(1);
  });

  it('publishes an error event if the stream throws and rethrows', async () => {
    streamMock.mockReturnValue((async function* () {
      yield 'Hello ';
      throw new Error('boom');
    })());
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');

    await expect(agent.executeStreaming({
      userId: 'u1',
      chatId: 'c1',
      assistantMessageId: 'm-x',
      message: 'hi',
      metadata: { currentState: 'welcome', currentContext: {} },
    })).rejects.toThrow('boom');

    const errors = publishMock.mock.calls.filter(([, type]) => type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]?.[2] as { message: string }).message).toMatch(/boom/);
  });
});
