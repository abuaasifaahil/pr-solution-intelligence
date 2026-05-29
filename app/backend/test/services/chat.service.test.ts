import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const mockMessage = {
  create: vi.fn(),
  findMany: vi.fn(),
};
const mockAgent = { findUnique: vi.fn() };

vi.mock('@prsi/shared/db', () => ({
  prisma: { chat: mockChat, message: mockMessage, agent: mockAgent, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn((_uid, fn) => fn({ chat: mockChat, message: mockMessage, agent: mockAgent })),
  asAdmin: vi.fn(),
}));

const orchExecute = vi.fn();
vi.mock('../../src/agents/agent-registry.js', () => ({
  AgentRegistry: {
    getByType: () => ({ execute: orchExecute, id: 'orch-id', name: 'PR Impact Agent', type: 'pr_impact' }),
    listAll: () => [],
  },
}));

const { createChat, appendUserMessage } = await import('../../src/services/chat.service.js');

describe('chat.service.createChat', () => {
  beforeEach(() => {
    Object.values(mockChat).forEach((f) => f.mockReset());
    Object.values(mockMessage).forEach((f) => f.mockReset());
    Object.values(mockAgent).forEach((f) => f.mockReset());
    orchExecute.mockReset();
  });

  it('creates a chat row + a welcome AI message', async () => {
    mockAgent.findUnique.mockResolvedValue({ id: 'a1', type: 'pr_impact', name: 'PR Impact Agent' });
    mockChat.create.mockResolvedValue({ id: 'c1', userId: 'u1', agentType: 'pr_impact', context: {} });
    orchExecute.mockResolvedValue({
      replyText: 'Welcome to PR Impact Agent. How can I help?',
      chips: [{ label: 'Analyze brand sentiment', value: 'analyze_sentiment' }],
      contextPatch: { state: 'welcome' },
    });
    mockMessage.create.mockResolvedValue({ id: 'm1', role: 'assistant', content: 'Welcome…' });
    mockChat.update.mockResolvedValue({ id: 'c1' });

    const result = await createChat('u1', 'pr_impact');
    expect(result.chat.id).toBe('c1');
    expect(result.welcomeMessage.role).toBe('assistant');
    expect(mockMessage.create).toHaveBeenCalled();
    expect(orchExecute).toHaveBeenCalled();
  });

  it('throws on unknown agent type', async () => {
    mockAgent.findUnique.mockResolvedValue(null);
    await expect(createChat('u1', 'nope')).rejects.toThrow();
  });
});

describe('chat.service.appendUserMessage', () => {
  beforeEach(() => {
    Object.values(mockChat).forEach((f) => f.mockReset());
    Object.values(mockMessage).forEach((f) => f.mockReset());
    orchExecute.mockReset();
  });

  it('saves the user message, runs the orchestrator, saves the AI reply, returns both', async () => {
    mockChat.findFirst.mockResolvedValue({
      id: 'c1', userId: 'u1', agentType: 'pr_impact',
      context: { state: 'awaiting_date' },
    });
    mockMessage.create
      .mockResolvedValueOnce({ id: 'm1', role: 'user', content: 'weekly' })
      .mockResolvedValueOnce({ id: 'm2', role: 'assistant', content: 'Got it.' });
    orchExecute.mockResolvedValue({
      replyText: 'Got it.',
      chips: [],
      contextPatch: { state: 'awaiting_enrichment', dateRange: { type: 'weekly' } },
    });
    mockChat.update.mockResolvedValue({ id: 'c1' });

    const out = await appendUserMessage('u1', 'c1', 'weekly', 'weekly');
    expect(out.userMessage.content).toBe('weekly');
    expect(out.aiMessage.content).toBe('Got it.');
    expect(mockMessage.create).toHaveBeenCalledTimes(2);
    expect(mockChat.update).toHaveBeenCalled();
  });

  it('throws when chat is not found or not owned by user', async () => {
    mockChat.findFirst.mockResolvedValue(null);
    await expect(appendUserMessage('u1', 'cX', 'x')).rejects.toThrow();
  });
});
