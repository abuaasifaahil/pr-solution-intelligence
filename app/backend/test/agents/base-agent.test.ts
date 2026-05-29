import { describe, it, expect, vi } from 'vitest';
import { BaseAgent, type AgentInput } from '../../src/agents/base-agent.js';

class StubAgent extends BaseAgent {
  static readonly type = 'stub';
  static override readonly name = 'Stub Agent';
  perceiveCalled = 0;
  reasonCalled = 0;
  planCalled = 0;
  actCalled = 0;
  reflectCalled = 0;
  async perceive(input: AgentInput): Promise<unknown> { this.perceiveCalled++; return input; }
  async reason(_ctx: unknown): Promise<unknown> { this.reasonCalled++; return { intent: 'stub' }; }
  async plan(_goal: unknown): Promise<unknown> { this.planCalled++; return ['do-thing']; }
  async act(_plan: unknown): Promise<unknown> { this.actCalled++; return { result: 'ok' }; }
  async reflect(_result: unknown): Promise<void> { this.reflectCalled++; }
}

describe('BaseAgent.execute', () => {
  it('runs perceive → reason → plan → act → reflect in order', async () => {
    const agent = new StubAgent('stub-id', 'Stub Agent', 'stub');
    const spy = vi.spyOn(agent, 'logAction').mockResolvedValue();

    const out = await agent.execute({ userId: 'u1', message: 'hello' });
    expect(agent.perceiveCalled).toBe(1);
    expect(agent.reasonCalled).toBe(1);
    expect(agent.planCalled).toBe(1);
    expect(agent.actCalled).toBe(1);
    expect(agent.reflectCalled).toBe(1);
    expect(out).toEqual({ result: 'ok' });
    expect(spy).toHaveBeenCalled();
  });

  it('reports health metadata via getHealth()', () => {
    const agent = new StubAgent('stub-id', 'Stub Agent', 'stub');
    const h = agent.getHealth();
    expect(h.status).toBe('ok');
    expect(h.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(h.messageCount).toBe(0);
  });
});
