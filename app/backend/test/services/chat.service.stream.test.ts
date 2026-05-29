import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
const mockMessage = {
  create: vi.fn(),
  update: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { chat: mockChat, message: mockMessage, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid, fn) =>
    fn({ chat: mockChat, message: mockMessage })),
  asAdmin: vi.fn(),
}));

const executeStreaming = vi.fn();
vi.mock('../../src/agents/agent-registry.js', () => ({
  AgentRegistry: {
    getByType: () => ({
      id: 'orch',
      name: 'PR Impact Agent',
      type: 'pr_impact',
      executeStreaming,
    }),
  },
}));

const publishMock = vi.fn(async () => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishMock,
}));

const { startStreamingReply } = await import('../../src/services/chat.service.js');

describe('chat.service.startStreamingReply', () => {
  beforeEach(() => {
    Object.values(mockChat).forEach((f) => f.mockReset());
    Object.values(mockMessage).forEach((f) => f.mockReset());
    executeStreaming.mockReset();
    publishMock.mockClear();
  });

  it('persists user msg + placeholder, returns chips synchronously, runs orchestrator in background', async () => {
    mockChat.findFirst.mockResolvedValue({
      id: 'c1', userId: 'u1', agentType: 'pr_impact',
      context: { state: 'awaiting_date' },
    });
    mockMessage.create
      .mockResolvedValueOnce({
        id: 'user-msg-1', chatId: 'c1', role: 'user', content: 'weekly', metadata: { choice: 'weekly' },
      })
      .mockResolvedValueOnce({
        id: 'asst-msg-1', chatId: 'c1', role: 'assistant', content: '', metadata: {},
      });

    executeStreaming.mockResolvedValue({
      replyText: 'Got it.',
      chips: [{ label: 'Enrichment', value: 'enrichment' }],
      contextPatch: { state: 'awaiting_enrichment', dateRange: { type: 'weekly' } },
    });
    mockMessage.update.mockResolvedValue({});
    mockChat.update.mockResolvedValue({});

    const out = await startStreamingReply('u1', 'c1', 'weekly', 'weekly');

    // The synchronous response shape.
    expect(out.userMessage.id).toBe('user-msg-1');
    expect(out.assistantMessageId).toBe('asst-msg-1');
    // State machine returns both enrichment chips for awaiting_date → awaiting_enrichment.
    expect(out.chips.map((c) => c.value)).toContain('enrichment');

    // Background task is kicked off and we can wait for it.
    await out.streamingDone;

    expect(publishMock).toHaveBeenCalledWith('c1', 'typing:start',
      expect.objectContaining({ assistantMessageId: 'asst-msg-1' }));
    expect(executeStreaming).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', chatId: 'c1', assistantMessageId: 'asst-msg-1',
    }));
    expect(mockMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asst-msg-1' },
    }));
    expect(publishMock).toHaveBeenCalledWith('c1', 'message:new', expect.any(Object));
  });

  it('throws synchronously when chat is missing (404 path)', async () => {
    mockChat.findFirst.mockResolvedValue(null);
    await expect(startStreamingReply('u1', 'cX', 'hi')).rejects.toThrow('Chat not found');
  });
});
