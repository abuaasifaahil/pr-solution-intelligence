import { describe, it, expect, beforeEach } from 'vitest';
import { BaseAgent, type AgentInput } from '../../src/agents/base-agent.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';

class FakeAgent extends BaseAgent {
  async perceive(i: AgentInput): Promise<unknown> { return i; }
  async reason(c: unknown): Promise<unknown> { return c; }
  async plan(g: unknown): Promise<unknown> { return g; }
  async act(p: unknown): Promise<unknown> { return p; }
  async reflect(): Promise<void> { /* */ }
}

describe('AgentRegistry', () => {
  beforeEach(() => AgentRegistry.clear());

  it('registers and looks up an agent by type', () => {
    const a = new FakeAgent('a-id', 'A', 'pr_impact');
    AgentRegistry.register(a);
    expect(AgentRegistry.getByType('pr_impact')).toBe(a);
  });

  it('returns null for unknown type', () => {
    expect(AgentRegistry.getByType('nope')).toBeNull();
  });

  it('listAll returns all registered agents', () => {
    AgentRegistry.register(new FakeAgent('1', 'A', 'pr_impact'));
    AgentRegistry.register(new FakeAgent('2', 'B', 'media_monitoring'));
    expect(AgentRegistry.listAll()).toHaveLength(2);
  });

  it('rejects duplicate type registration', () => {
    AgentRegistry.register(new FakeAgent('1', 'A', 'pr_impact'));
    expect(() => AgentRegistry.register(new FakeAgent('2', 'B', 'pr_impact'))).toThrow();
  });
});
