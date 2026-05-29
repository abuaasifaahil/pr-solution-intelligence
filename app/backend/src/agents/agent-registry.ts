import type { BaseAgent } from './base-agent.js';

class Registry {
  private agents = new Map<string, BaseAgent>();

  register(agent: BaseAgent): void {
    if (this.agents.has(agent.type)) {
      throw new Error(`Agent type "${agent.type}" already registered`);
    }
    this.agents.set(agent.type, agent);
  }

  getByType(type: string): BaseAgent | null {
    return this.agents.get(type) ?? null;
  }

  listAll(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  clear(): void {
    this.agents.clear();
  }
}

/** Singleton registry. Agents register at server boot. */
export const AgentRegistry = new Registry();
