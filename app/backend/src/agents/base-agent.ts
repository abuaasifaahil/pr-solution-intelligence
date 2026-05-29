import { prisma } from '@prsi/shared/db';

export interface AgentInput {
  userId: string;
  chatId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AgentHealth {
  status: 'ok' | 'degraded' | 'down';
  uptimeMs: number;
  lastActionAt: Date | null;
  messageCount: number;
}

/**
 * Abstract base for all agents (Phase 1 spec § 5.4).
 * Subclasses MUST implement perceive/reason/plan/act/reflect.
 * `learn` is virtual — override in Phase 5 Learning Agent only.
 * execute() drives the lifecycle and writes to agent_logs.
 */
export abstract class BaseAgent {
  protected readonly startedAt: Date = new Date();
  protected lastActionAt: Date | null = null;
  protected messageCount = 0;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly type: string,
  ) {}

  abstract perceive(input: AgentInput): Promise<unknown>;
  abstract reason(context: unknown): Promise<unknown>;
  abstract plan(goal: unknown): Promise<unknown>;
  abstract act(plan: unknown): Promise<unknown>;
  abstract reflect(result: unknown): Promise<void>;

  /** Phase 5 Learning Agent overrides this. M3 default: no-op. */
  async learn(_outcome: unknown): Promise<void> {
    /* virtual no-op */
  }

  async execute<T = unknown>(input: AgentInput): Promise<T> {
    const start = Date.now();
    try {
      const ctx = await this.perceive(input);
      const goal = await this.reason(ctx);
      const plan = await this.plan(goal);
      const result = await this.act(plan);
      await this.reflect(result);
      await this.learn(result);
      this.lastActionAt = new Date();
      this.messageCount += 1;
      const duration = Date.now() - start;
      await this.logAction('execute', input, result, duration);
      return result as T;
    } catch (err) {
      const duration = Date.now() - start;
      await this.logAction('execute_failed', input, { error: (err as Error).message }, duration);
      throw err;
    }
  }

  getHealth(): AgentHealth {
    return {
      status: 'ok',
      uptimeMs: Date.now() - this.startedAt.getTime(),
      lastActionAt: this.lastActionAt,
      messageCount: this.messageCount,
    };
  }

  async logAction(
    action: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ): Promise<void> {
    try {
      await prisma.agentLog.create({
        data: {
          agentId: this.id,
          action,
          input: input as object,
          output: output as object,
          durationMs,
        },
      });
    } catch {
      /* log write failures should not break agent execution */
    }
  }
}
