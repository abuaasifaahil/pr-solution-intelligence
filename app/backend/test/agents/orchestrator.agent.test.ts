import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorResult } from '../../src/agents/orchestrator.agent.js';

vi.mock('../../src/lib/llm.js', () => ({
  chatComplete: vi.fn().mockResolvedValue('Got it. What date range should I analyze?'),
  parseChoice: vi.fn(),
}));

const { OrchestratorAgent } = await import('../../src/agents/orchestrator.agent.js');
const { chatComplete, parseChoice } = await import('../../src/lib/llm.js');

describe('OrchestratorAgent.execute', () => {
  beforeEach(() => {
    (chatComplete as any).mockClear();
    (parseChoice as any).mockClear();
  });

  it('on a new chat (welcome state) advances to awaiting_date and returns LLM phrasing + chips', async () => {
    const agent = new OrchestratorAgent('pr-impact-id', 'PR Impact Agent', 'pr_impact');
    const out = await agent.execute<OrchestratorResult>({
      userId: 'u1',
      chatId: 'c1',
      message: 'Analyze brand sentiment',
      metadata: { currentState: 'welcome', currentContext: {} },
    });
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
    expect(out.contextPatch.state ?? 'ready').toBe('ready');
  });
});
