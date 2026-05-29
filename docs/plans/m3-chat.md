# M3 — Chat Creation + REST Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase 1 chat-mockup-faithful UI shell — sidebar + topbar + 5-agent-cards home + chat page with thread/chips/input — plus a real `OrchestratorAgent` backend that walks users through the Phase 1 § 4.3 conversational flow (date → enrichment → brand → competitors → intention) using Azure OpenAI GPT-4.1 for natural-language phrasing, with state persisted in `chats.context` JSONB.

**Architecture:** Backend gains the `BaseAgent` abstract class (per Phase 1 spec § 5.4), `AgentRegistry`, an `OrchestratorAgent` that combines a hardcoded 6-step state machine with Azure OpenAI GPT-4.1 for surface-level phrasing/parsing, and REST routes from Phase 1 spec § 4.2 (`/agents`, `/chats`, `/chats/:id/messages`). Frontend gains a `(authed)` Next.js route group wrapping the home + chat pages with a persistent sidebar/topbar layout, and a `(auth)` route group for the existing login page. Message thread renders bubbles + clickable chips that POST to the messages endpoint. RLS from M2 keeps every chat/message strictly scoped to its owner.

**Tech Stack additions:** `openai` npm package (Azure OpenAI compatible client). All other stack pieces (Next.js 14, Fastify 4, Prisma 5, Tailwind 3, Zustand 4, Vitest, Playwright) carried forward from M1/M2/M6.

**Prerequisites the human user must complete before Task 4:**

- Azure OpenAI deployment named `gpt-4.1` exists at `https://amx-gpt-india.openai.azure.com/` (confirmed from earlier shared creds — endpoint kept; **key rotated** because the earlier value leaked to chat).
- The rotated `AZURE_OPENAI_API_KEY` is set in either:
  - `app/backend/.env` (gitignored), **OR**
  - `app/.env.local` (gitignored via `.env.*.local` pattern), **OR**
  - Render web service env vars (for production-only use)
- **Not** in `app/.env.example` (tracked) and **not** in chat.

---

## File map

```
app/
├── backend/
│   ├── package.json                                MODIFY: add `openai` (Azure-compatible)
│   ├── src/
│   │   ├── env.ts                                  MODIFY: add 4 Azure OpenAI env vars
│   │   ├── server.ts                               MODIFY: register agent + chat routes
│   │   ├── lib/
│   │   │   └── llm.ts                              NEW: Azure OpenAI wrapper
│   │   ├── agents/
│   │   │   ├── base-agent.ts                       NEW: abstract BaseAgent (Phase 1 § 5.4)
│   │   │   ├── agent-registry.ts                   NEW: register + lookup agents
│   │   │   ├── orchestrator-state.ts               NEW: pure state machine
│   │   │   └── orchestrator.agent.ts               NEW: BaseAgent subclass; state + LLM
│   │   ├── services/
│   │   │   └── chat.service.ts                     NEW: chat CRUD + message append
│   │   └── routes/
│   │       ├── agent.routes.ts                     NEW: GET /agents, /agents/:id
│   │       └── chat.routes.ts                      NEW: chats CRUD + messages
│   └── test/
│       ├── lib/llm.test.ts                         NEW
│       ├── agents/
│       │   ├── base-agent.test.ts                  NEW
│       │   ├── agent-registry.test.ts              NEW
│       │   ├── orchestrator-state.test.ts          NEW
│       │   └── orchestrator.agent.test.ts          NEW (mocked LLM)
│       ├── services/chat.service.test.ts           NEW (mocked Prisma)
│       └── routes/
│           ├── agent.routes.test.ts                NEW (integration)
│           └── chat.routes.test.ts                 NEW (integration; full convo)
├── frontend/
│   ├── app/
│   │   ├── layout.tsx                              (unchanged — root layout)
│   │   ├── page.tsx                                DELETE (moved into (authed)/)
│   │   ├── login/                                  DELETE (moved into (auth)/)
│   │   ├── (auth)/
│   │   │   └── login/page.tsx                      NEW path; existing component content reused
│   │   └── (authed)/
│   │       ├── layout.tsx                          NEW: AuthGate + Sidebar layout
│   │       ├── page.tsx                            NEW: Home — 5 agent cards + greeting
│   │       └── chat/[id]/page.tsx                  NEW: chat thread
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx                         NEW
│   │   │   └── Topbar.tsx                          NEW
│   │   ├── home/
│   │   │   └── AgentCard.tsx                       NEW
│   │   └── chat/
│   │       ├── MessageThread.tsx                   NEW
│   │       ├── MessageBubble.tsx                   NEW
│   │       ├── ChipRow.tsx                         NEW
│   │       └── ChatInput.tsx                       NEW
│   └── lib/
│       └── chats.ts                                NEW: typed chat API client
└── tests/e2e/
    └── m3-chat.spec.ts                             NEW: full conversation flow
```

---

## Task 1: Azure OpenAI client (TDD)

**Files:**
- Modify: `app/backend/package.json` — add `openai`
- Modify: `app/backend/src/env.ts` — add Azure OpenAI env vars
- Create: `app/backend/src/lib/llm.ts`
- Create: `app/backend/test/lib/llm.test.ts`
- Modify: `app/.env.example` — document Azure OpenAI vars (placeholder values only)

- [ ] **Step 1: Add the `openai` npm package**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend add openai@4.78.1
```

- [ ] **Step 2: Update `app/backend/src/env.ts` with Azure OpenAI vars**

Replace the file contents:

```ts
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_PUBLIC_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(604800),
  CORS_ALLOWED_ORIGIN: z.string().default('*'),
  // Azure OpenAI (M3). Required for OrchestratorAgent.
  AZURE_OPENAI_ENDPOINT: z.string().url(),
  AZURE_OPENAI_API_KEY: z.string().min(20),
  AZURE_OPENAI_API_VERSION: z.string().default('2025-03-01-preview'),
  AZURE_OPENAI_DEPLOYMENT: z.string().default('gpt-4.1'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
```

- [ ] **Step 3: Add Azure OpenAI placeholders to `app/.env.example`**

Append (do not commit real values):

```bash
# Azure OpenAI (M3 — required for OrchestratorAgent natural-language phrasing)
# Get from Azure Portal → your OpenAI resource → Keys and Endpoint
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2025-03-01-preview
AZURE_OPENAI_DEPLOYMENT=gpt-4.1
```

If `app/.env.example` working tree already contains real token values from prior tasks, leave that alone — DO NOT git-add them in this task. Only add the four new placeholder lines above.

- [ ] **Step 4: Write the failing test**

Create `app/backend/test/lib/llm.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { chatComplete, parseChoice } = await import('../../src/lib/llm.js');

describe('llm.chatComplete', () => {
  beforeEach(() => createMock.mockReset());

  it('returns the assistant text from the LLM response', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'Hello there.' } }],
    });
    const out = await chatComplete({
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(out).toBe('Hello there.');
  });

  it('throws if the LLM returns no choices', async () => {
    createMock.mockResolvedValue({ choices: [] });
    await expect(
      chatComplete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
  });
});

describe('llm.parseChoice', () => {
  beforeEach(() => createMock.mockReset());

  it('returns the parsed choice when LLM emits valid JSON', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"choice":"weekly"}' } }],
    });
    const out = await parseChoice('last week', ['weekly', '10days', '20days', 'custom']);
    expect(out).toBe('weekly');
  });

  it('returns null when the LLM emits "unclear"', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"choice":"unclear"}' } }],
    });
    const out = await parseChoice('lalala', ['weekly', '10days']);
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 5: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- llm
```

Expected: FAIL — `Cannot find module '../../src/lib/llm.js'`.

- [ ] **Step 6: Implement `app/backend/src/lib/llm.ts`**

```ts
import { AzureOpenAI } from 'openai';
import { loadEnv } from '../env.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let client: AzureOpenAI | undefined;

function getClient(): AzureOpenAI {
  if (!client) {
    const env = loadEnv();
    client = new AzureOpenAI({
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiKey: env.AZURE_OPENAI_API_KEY,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return client;
}

export interface ChatCompleteInput {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
}

export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  const env = loadEnv();
  const response = await getClient().chat.completions.create({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    temperature: input.temperature ?? 0.3,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages,
    ],
  });
  const choice = response.choices[0];
  if (!choice?.message?.content) {
    throw new Error('LLM returned no content');
  }
  return choice.message.content;
}

/**
 * Ask the LLM to pick one of `options` based on free-text user input.
 * Returns the matching option string, or null if the LLM says "unclear".
 */
export async function parseChoice(userInput: string, options: string[]): Promise<string | null> {
  const env = loadEnv();
  const response = await getClient().chat.completions.create({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a strict classifier. Given a user input and a list of valid choices, reply with JSON ' +
          '{"choice":"<exact-choice-string-or-unclear>"}. Use exactly one of the provided choices. ' +
          'If the input does not clearly match any choice, return "unclear".',
      },
      {
        role: 'user',
        content: `Input: ${userInput}\nValid choices: ${options.join(', ')}`,
      },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { choice?: string };
    if (!parsed.choice || parsed.choice === 'unclear') return null;
    if (!options.includes(parsed.choice)) return null;
    return parsed.choice;
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- llm
```

Expected: PASS — 4 tests.

- [ ] **Step 8: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/lib/llm.ts app/backend/src/env.ts app/backend/test/lib/llm.test.ts app/backend/package.json app/.env.example app/pnpm-lock.yaml
git commit -m "M3.1: Azure OpenAI client (chatComplete + parseChoice) + env vars"
```

---

## Task 2: BaseAgent abstract class + AgentRegistry (TDD)

**Files:**
- Create: `app/backend/src/agents/base-agent.ts`
- Create: `app/backend/src/agents/agent-registry.ts`
- Create: `app/backend/test/agents/base-agent.test.ts`
- Create: `app/backend/test/agents/agent-registry.test.ts`

- [ ] **Step 1: Write the failing BaseAgent test**

Create `app/backend/test/agents/base-agent.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BaseAgent, type AgentInput } from '../../src/agents/base-agent.js';

class StubAgent extends BaseAgent {
  static readonly type = 'stub';
  static readonly name = 'Stub Agent';
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
    const calls: string[] = [];
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
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- base-agent
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/agents/base-agent.ts`**

```ts
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
```

- [ ] **Step 4: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- base-agent
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing AgentRegistry test**

Create `app/backend/test/agents/agent-registry.test.ts`:

```ts
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
```

- [ ] **Step 6: Implement `app/backend/src/agents/agent-registry.ts`**

```ts
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
```

- [ ] **Step 7: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- agent-registry
```

Expected: PASS — 4 tests.

- [ ] **Step 8: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/agents/base-agent.ts app/backend/src/agents/agent-registry.ts app/backend/test/agents/base-agent.test.ts app/backend/test/agents/agent-registry.test.ts
git commit -m "M3.2: BaseAgent abstract class + AgentRegistry singleton"
```

---

## Task 3: Orchestrator state machine (pure functions, TDD)

**Files:**
- Create: `app/backend/src/agents/orchestrator-state.ts`
- Create: `app/backend/test/agents/orchestrator-state.test.ts`

The state machine is pure (no I/O, no LLM). It takes `(currentState, parsedAnswer) → { newState, contextPatch, replyTemplate, chips }`. The OrchestratorAgent later wraps these reply templates with an LLM call for natural phrasing.

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/agents/orchestrator-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATE,
  WELCOME_CHIPS_BY_AGENT,
  advance,
  isReady,
  type ConversationState,
} from '../../src/agents/orchestrator-state.js';

describe('orchestrator-state', () => {
  it('INITIAL_STATE is "welcome"', () => {
    expect(INITIAL_STATE).toBe<ConversationState>('welcome');
  });

  it('welcome transitions to awaiting_date on any non-empty input', () => {
    const r = advance('welcome', { freeText: 'Analyze brand sentiment' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_date');
    expect(r.chips.map((c) => c.value)).toEqual(['weekly', '10days', '20days', 'custom']);
  });

  it('awaiting_date with valid choice stores dateRange and advances', () => {
    const r = advance('awaiting_date', { choice: 'weekly' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_enrichment');
    expect(r.contextPatch.dateRange).toEqual({ type: 'weekly' });
  });

  it('awaiting_enrichment advances to awaiting_brand', () => {
    const r = advance('awaiting_enrichment', { choice: 'enrichment' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_brand');
    expect(r.contextPatch.enrichment).toBe('enrichment');
  });

  it('awaiting_brand stores brand from free text and advances', () => {
    const r = advance('awaiting_brand', { freeText: 'FreshSip' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_competitors');
    expect(r.contextPatch.brand).toBe('FreshSip');
  });

  it('awaiting_competitors with chip choice advances', () => {
    const r = advance('awaiting_competitors', { choice: 'top5' }, 'pr_impact');
    expect(r.newState).toBe('awaiting_intention');
    expect(r.contextPatch.competitors).toEqual({ preset: 'top5' });
  });

  it('awaiting_intention advances to ready', () => {
    const r = advance('awaiting_intention', { choice: 'intention_based' }, 'pr_impact');
    expect(r.newState).toBe('ready');
    expect(r.contextPatch.intention).toBe('intention_based');
  });

  it('ready stays in ready', () => {
    const r = advance('ready', { freeText: 'anything' }, 'pr_impact');
    expect(r.newState).toBe('ready');
  });

  it('isReady returns true only for "ready"', () => {
    expect(isReady('ready')).toBe(true);
    expect(isReady('awaiting_brand')).toBe(false);
  });

  it('exposes welcome chips per agent type', () => {
    expect(WELCOME_CHIPS_BY_AGENT.pr_impact).toBeDefined();
    expect(WELCOME_CHIPS_BY_AGENT.pr_impact[0]?.label).toBeTypeOf('string');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- orchestrator-state
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/agents/orchestrator-state.ts`**

```ts
export type ConversationState =
  | 'welcome'
  | 'awaiting_date'
  | 'awaiting_enrichment'
  | 'awaiting_brand'
  | 'awaiting_competitors'
  | 'awaiting_intention'
  | 'ready';

export const INITIAL_STATE: ConversationState = 'welcome';

export interface Chip {
  label: string;   // user-facing
  value: string;   // machine value
}

export interface DateRange {
  type: 'weekly' | '10days' | '20days' | 'custom';
  from?: string;
  to?: string;
}

export interface ChatContext {
  state?: ConversationState;
  dateRange?: DateRange;
  enrichment?: 'enrichment' | 'enrichment_plus_reach';
  brand?: string;
  competitors?: { preset?: 'top5' | 'top3' | 'top2' | 'other'; custom?: string[] };
  intention?: 'intention_based' | 'comment_based';
}

export interface AdvanceInput {
  choice?: string;
  freeText?: string;
}

export interface AdvanceResult {
  newState: ConversationState;
  contextPatch: Partial<ChatContext>;
  replyTemplate: string;     // prompt for the LLM phrasing pass
  chips: Chip[];
}

const DATE_CHIPS: Chip[] = [
  { label: 'Weekly', value: 'weekly' },
  { label: '10 Days', value: '10days' },
  { label: '20 Days', value: '20days' },
  { label: 'Custom', value: 'custom' },
];
const ENRICHMENT_CHIPS: Chip[] = [
  { label: 'Enrichment', value: 'enrichment' },
  { label: 'Enrichment + Reach', value: 'enrichment_plus_reach' },
];
const COMPETITOR_CHIPS: Chip[] = [
  { label: 'Top 5', value: 'top5' },
  { label: 'Top 3', value: 'top3' },
  { label: 'Top 2', value: 'top2' },
  { label: 'Other (custom)', value: 'other' },
];
const INTENTION_CHIPS: Chip[] = [
  { label: 'Intention-based', value: 'intention_based' },
  { label: 'Comment-based', value: 'comment_based' },
];

export const WELCOME_CHIPS_BY_AGENT: Record<string, Chip[]> = {
  pr_impact: [
    { label: 'Analyze brand sentiment', value: 'analyze_sentiment' },
    { label: 'Monitor coverage', value: 'monitor_coverage' },
    { label: 'Generate PR report', value: 'generate_report' },
  ],
  media_monitoring: [
    { label: 'Track brand mentions', value: 'track_mentions' },
    { label: 'Monitor competitors', value: 'monitor_competitors' },
    { label: 'Set up alerts', value: 'setup_alerts' },
  ],
  media_measurement: [
    { label: 'Measure reach', value: 'measure_reach' },
    { label: 'Compare against industry', value: 'compare_industry' },
    { label: 'Engagement breakdown', value: 'engagement_breakdown' },
  ],
  reputation_index: [
    { label: 'Score brand reputation', value: 'score_reputation' },
    { label: 'Trend over time', value: 'trend_over_time' },
    { label: 'Compare to peers', value: 'compare_to_peers' },
  ],
  crisis_management: [
    { label: 'Detect anomalies', value: 'detect_anomalies' },
    { label: 'Triage emerging crisis', value: 'triage_crisis' },
    { label: 'Suggest response', value: 'suggest_response' },
  ],
};

export function isReady(state: ConversationState): boolean {
  return state === 'ready';
}

export function advance(
  state: ConversationState,
  input: AdvanceInput,
  _agentType: string,
): AdvanceResult {
  const userInput = input.choice ?? input.freeText ?? '';
  if (!userInput) {
    // Empty input: do not advance.
    return {
      newState: state,
      contextPatch: {},
      replyTemplate: 'Please reply or pick an option to continue.',
      chips: [],
    };
  }

  switch (state) {
    case 'welcome':
      return {
        newState: 'awaiting_date',
        contextPatch: { state: 'awaiting_date' },
        replyTemplate:
          'Acknowledge the user wants to start, and ask which date range to analyze. ' +
          'Keep it to two short sentences.',
        chips: DATE_CHIPS,
      };

    case 'awaiting_date': {
      const dateType = (input.choice ?? '') as DateRange['type'];
      const valid = ['weekly', '10days', '20days', 'custom'].includes(dateType);
      if (!valid) {
        return {
          newState: 'awaiting_date',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the date-range chips.',
          chips: DATE_CHIPS,
        };
      }
      return {
        newState: 'awaiting_enrichment',
        contextPatch: { state: 'awaiting_enrichment', dateRange: { type: dateType } },
        replyTemplate:
          `Acknowledge the ${dateType} date range and ask whether to run plain enrichment or ` +
          `enrichment + reach metrics. Two sentences.`,
        chips: ENRICHMENT_CHIPS,
      };
    }

    case 'awaiting_enrichment': {
      const v = input.choice as ChatContext['enrichment'];
      if (v !== 'enrichment' && v !== 'enrichment_plus_reach') {
        return {
          newState: 'awaiting_enrichment',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the enrichment chips.',
          chips: ENRICHMENT_CHIPS,
        };
      }
      return {
        newState: 'awaiting_brand',
        contextPatch: { state: 'awaiting_brand', enrichment: v },
        replyTemplate:
          'Acknowledge the enrichment choice and ask the user to type the brand name they want to analyze.',
        chips: [],
      };
    }

    case 'awaiting_brand': {
      const brand = (input.freeText ?? '').trim();
      if (!brand) {
        return {
          newState: 'awaiting_brand',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to type the brand name.',
          chips: [],
        };
      }
      return {
        newState: 'awaiting_competitors',
        contextPatch: { state: 'awaiting_competitors', brand },
        replyTemplate:
          `Acknowledge ${brand} and ask which competitor preset to compare against. ` +
          `Two sentences.`,
        chips: COMPETITOR_CHIPS,
      };
    }

    case 'awaiting_competitors': {
      const preset = input.choice as 'top5' | 'top3' | 'top2' | 'other' | undefined;
      if (!preset || !['top5', 'top3', 'top2', 'other'].includes(preset)) {
        return {
          newState: 'awaiting_competitors',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the competitor chips.',
          chips: COMPETITOR_CHIPS,
        };
      }
      return {
        newState: 'awaiting_intention',
        contextPatch: { state: 'awaiting_intention', competitors: { preset } },
        replyTemplate:
          'Acknowledge the competitor preset and ask whether to analyze by intention or by comments.',
        chips: INTENTION_CHIPS,
      };
    }

    case 'awaiting_intention': {
      const v = input.choice as ChatContext['intention'];
      if (v !== 'intention_based' && v !== 'comment_based') {
        return {
          newState: 'awaiting_intention',
          contextPatch: {},
          replyTemplate: 'Politely ask the user to pick one of the intention chips.',
          chips: INTENTION_CHIPS,
        };
      }
      return {
        newState: 'ready',
        contextPatch: { state: 'ready', intention: v },
        replyTemplate:
          'Confirm that all parameters are captured. Briefly summarize the brand, date range, ' +
          'enrichment, competitors, and intention. End with: "Phase 2 plugs in real PR analysis. ' +
          'For now, click New Chat to start over."',
        chips: [],
      };
    }

    case 'ready':
      return {
        newState: 'ready',
        contextPatch: {},
        replyTemplate:
          'All parameters were already captured. Politely remind the user that real analysis ' +
          'arrives in Phase 2 and they can click New Chat to start a new flow.',
        chips: [],
      };
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- orchestrator-state
```

Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/agents/orchestrator-state.ts app/backend/test/agents/orchestrator-state.test.ts
git commit -m "M3.3: orchestrator state machine (pure 6-step flow)"
```

---

## Task 4: OrchestratorAgent (BaseAgent + state machine + LLM) — TDD

**Files:**
- Create: `app/backend/src/agents/orchestrator.agent.ts`
- Create: `app/backend/test/agents/orchestrator.agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/agents/orchestrator.agent.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const out = await agent.execute({
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
    const out = await agent.execute({
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
    const out = await agent.execute({
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
    const out = await agent.execute({
      userId: 'u1',
      chatId: 'c1',
      message: 'anything',
      metadata: { currentState: 'ready', currentContext: { brand: 'FreshSip' } },
    });
    expect(out.contextPatch.state ?? 'ready').toBe('ready');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- orchestrator.agent
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/agents/orchestrator.agent.ts`**

```ts
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
    // We need the current state too; perceive stored it on `this` via no closure,
    // so we recompute via a stash on the request. Use a per-execute prop:
    return { advanceInput, agentType: this.type, state: this._currentState };
  }

  async act(plan: unknown): Promise<ActOutput> {
    const { advanceInput, agentType, state } = plan as PlanItem;
    const r = advance(state, advanceInput, agentType);
    // If we're transitioning from welcome on a fresh chat, prepend agent-specific intro.
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

  /** Set by perceive(); read by plan(). Cleared per execute via execute() override. */
  private _currentState: ConversationState = INITIAL_STATE;

  async execute<T = unknown>(input: AgentInput): Promise<T> {
    const o = input as OrchestratorInput;
    this._currentState = o.metadata?.currentState ?? INITIAL_STATE;
    return super.execute<T>(input);
  }
}

export { WELCOME_CHIPS_BY_AGENT } from './orchestrator-state.js';
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- orchestrator.agent
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/agents/orchestrator.agent.ts app/backend/test/agents/orchestrator.agent.test.ts
git commit -m "M3.4: OrchestratorAgent — state machine + LLM phrasing"
```

---

## Task 5: Chat service (mocked Prisma, TDD)

**Files:**
- Create: `app/backend/src/services/chat.service.ts`
- Create: `app/backend/test/services/chat.service.test.ts`

The service centralizes chat business logic so routes stay thin:
- `createChat(userId, agentType)` → row + welcome AI message
- `listChats(userId)` — RLS-scoped
- `getChat(userId, chatId)` — RLS-scoped
- `deleteChat(userId, chatId)`
- `listMessages(userId, chatId)`
- `appendUserMessage(userId, chatId, content) → { userMessage, aiMessage }` — runs OrchestratorAgent

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/services/chat.service.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- chat.service
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/services/chat.service.ts`**

```ts
import { prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import type { ChatContext, Chip, ConversationState } from '../agents/orchestrator-state.js';

export interface ChatRecord {
  id: string;
  userId: string;
  agentType: string;
  title: string | null;
  status: 'active' | 'completed' | 'archived';
  context: ChatContext;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: { chips?: Chip[]; choice?: string };
  createdAt: Date;
}

export interface CreateChatResult {
  chat: ChatRecord;
  welcomeMessage: MessageRecord;
}

export async function createChat(userId: string, agentType: string): Promise<CreateChatResult> {
  // Validate agent exists.
  const agentRow = await prisma.agent.findUnique({ where: { type: agentType } });
  if (!agentRow) throw new Error(`Unknown agent type: ${agentType}`);

  return withUser(userId, async (tx) => {
    const chat = await tx.chat.create({
      data: {
        userId,
        agentType,
        title: agentRow.name,
        status: 'active',
        context: {},
      },
    });

    const orchestrator = AgentRegistry.getByType(agentType);
    if (!orchestrator) throw new Error(`No orchestrator registered for ${agentType}`);

    const result = await orchestrator.execute<{ replyText: string; chips: Chip[]; contextPatch: Partial<ChatContext> }>({
      userId,
      chatId: chat.id,
      message: '', // empty triggers welcome path
      metadata: { currentState: 'welcome', currentContext: {} },
    });

    const welcomeMessage = await tx.message.create({
      data: {
        chatId: chat.id,
        role: 'assistant',
        content: result.replyText,
        metadata: { chips: result.chips },
      },
    });

    const newContext = { ...(chat.context as ChatContext), ...result.contextPatch };
    await tx.chat.update({
      where: { id: chat.id },
      data: { context: newContext },
    });

    return {
      chat: { ...chat, context: newContext } as ChatRecord,
      welcomeMessage: welcomeMessage as MessageRecord,
    };
  });
}

export async function listChats(userId: string): Promise<ChatRecord[]> {
  return withUser(userId, async (tx) => {
    const chats = await tx.chat.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return chats as ChatRecord[];
  });
}

export async function getChat(userId: string, chatId: string): Promise<ChatRecord | null> {
  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    return (chat as ChatRecord | null) ?? null;
  });
}

export async function deleteChat(userId: string, chatId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.chat.delete({ where: { id: chatId } });
  });
}

export async function listMessages(userId: string, chatId: string): Promise<MessageRecord[]> {
  return withUser(userId, async (tx) => {
    const owned = await tx.chat.findFirst({ where: { id: chatId } });
    if (!owned) throw new Error('Chat not found');
    const msgs = await tx.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
    });
    return msgs as MessageRecord[];
  });
}

export interface AppendResult {
  userMessage: MessageRecord;
  aiMessage: MessageRecord;
}

export async function appendUserMessage(
  userId: string,
  chatId: string,
  content: string,
  choice?: string,
): Promise<AppendResult> {
  return withUser(userId, async (tx) => {
    const chat = (await tx.chat.findFirst({ where: { id: chatId } })) as ChatRecord | null;
    if (!chat) throw new Error('Chat not found');

    const userMessage = (await tx.message.create({
      data: {
        chatId,
        role: 'user',
        content,
        metadata: choice ? { choice } : {},
      },
    })) as MessageRecord;

    const orchestrator = AgentRegistry.getByType(chat.agentType);
    if (!orchestrator) throw new Error(`No orchestrator for ${chat.agentType}`);

    const currentState = (chat.context.state ?? 'welcome') as ConversationState;
    const result = await orchestrator.execute<{ replyText: string; chips: Chip[]; contextPatch: Partial<ChatContext> }>({
      userId,
      chatId,
      message: content,
      metadata: { currentState, currentContext: chat.context, choice },
    });

    const aiMessage = (await tx.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: result.replyText,
        metadata: { chips: result.chips },
      },
    })) as MessageRecord;

    const newContext = { ...chat.context, ...result.contextPatch };
    await tx.chat.update({ where: { id: chatId }, data: { context: newContext } });

    return { userMessage, aiMessage };
  });
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- chat.service
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/services/chat.service.ts app/backend/test/services/chat.service.test.ts
git commit -m "M3.5: chat service (createChat, appendUserMessage, RLS-scoped)"
```

---

## Task 6: Agent routes (GET /agents, GET /agents/:id) — TDD

**Files:**
- Create: `app/backend/src/routes/agent.routes.ts`
- Create: `app/backend/test/routes/agent.routes.test.ts`
- Modify: `app/backend/src/server.ts` — register agent routes + orchestrator bootstrap

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/routes/agent.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'a1', type: 'pr_impact', name: 'PR Impact Agent', description: 'd', capabilities: [], icon: 'i', color: '#0078D4', isDefault: true, isActive: true },
      ]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'a1', type: 'pr_impact', name: 'PR Impact Agent', description: 'd', capabilities: [], icon: 'i', color: '#0078D4', isDefault: true, isActive: true,
      }),
    },
  },
}));
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const token = signAccess({
  userId: '00000000-0000-0000-0000-000000000001',
  email: 'kb@test.local',
  role: 'analyst',
  sessionId: 's',
});

describe('GET /api/v1/agents', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('returns list of active default agents', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.agents)).toBe(true);
    expect(body.data.agents[0].type).toBe('pr_impact');
  });

  it('GET /agents/:id returns one agent', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agents/a1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent.type).toBe('pr_impact');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- agent.routes
```

Expected: FAIL — `Cannot find module '../../src/routes/agent.routes.js'`.

- [ ] **Step 3: Implement `app/backend/src/routes/agent.routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { prisma } from '@prsi/shared/db';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/agents', { preHandler: app.auth }, async () => {
    const agents = await prisma.agent.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return { success: true, data: { agents } };
  });

  app.get('/api/v1/agents/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }
    return { success: true, data: { agent } };
  });

  app.get('/api/v1/agents/:id/health', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Phase 1 § 5.4 — agent health surface. M3 returns a stub (all agents are
    // singletons in-process, no real health check yet).
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }
    return {
      success: true,
      data: { health: { status: 'ok', uptimeMs: process.uptime() * 1000, lastActionAt: null, messageCount: 0 } },
    };
  });
}
```

- [ ] **Step 4: Register routes in `app/backend/src/server.ts`**

Replace the file's `buildServer` function contents (preserve imports + decorate):

```ts
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';
import { agentRoutes } from './routes/agent.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { OrchestratorAgent } from './agents/orchestrator.agent.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { prisma } from '@prsi/shared/db';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerAsyncHookHandler;
  }
}

function corsOriginConfig(): true | string[] {
  const raw = process.env.CORS_ALLOWED_ORIGIN ?? '*';
  if (raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function bootstrapAgents(): Promise<void> {
  if (AgentRegistry.listAll().length > 0) return;
  const agents = await prisma.agent.findMany({ where: { isActive: true } });
  for (const a of agents) {
    AgentRegistry.register(new OrchestratorAgent(a.id, a.name, a.type));
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: corsOriginConfig(), credentials: true });
  app.decorate('auth', authMiddleware);
  await bootstrapAgents();
  await app.register(healthzRoute);
  await app.register(authRoutes);
  await app.register(agentRoutes);

  return app;
}
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- agent.routes
```

Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/routes/agent.routes.ts app/backend/src/server.ts app/backend/test/routes/agent.routes.test.ts
git commit -m "M3.6: GET /agents + GET /agents/:id + orchestrator bootstrap"
```

---

## Task 7: Chat CRUD routes (POST/GET/DELETE /chats, GET /chats/:id)

**Files:**
- Create: `app/backend/src/routes/chat.routes.ts`
- Create: `app/backend/test/routes/chat.routes.test.ts`
- Modify: `app/backend/src/server.ts` — register chat routes

- [ ] **Step 1: Write the failing test (CRUD subset)**

Create `app/backend/test/routes/chat.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { prisma } from '@prsi/shared/db';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';
import { signAccess } from '../../src/lib/jwt.js';

const TEST_EMAIL = 'chat-route-test@test.local';

describe('Chat CRUD routes (integration)', () => {
  let app: FastifyInstance;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    await prisma.message.deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    const u = await prisma.user.create({
      data: { email: TEST_EMAIL, passwordHash: await hashPassword('x'), displayName: 'CT', role: 'analyst' },
    });
    userId = u.id;
    token = signAccess({ userId, email: TEST_EMAIL, role: 'analyst', sessionId: 's' });
  });

  beforeEach(async () => {
    await prisma.message.deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await app.close();
    await closeRedis();
    await prisma.$disconnect();
  });

  it('POST /chats requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { agentType: 'pr_impact' } });
    expect(res.statusCode).toBe(401);
  });

  it('POST /chats creates a chat scoped to a real agent type', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentType: 'pr_impact' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.chat.agentType).toBe('pr_impact');
    expect(body.data.welcomeMessage.role).toBe('assistant');
  });

  it('GET /chats returns the user\'s chats', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` }, payload: { agentType: 'pr_impact' },
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.chats.length).toBeGreaterThan(0);
  });

  it('DELETE /chats/:id removes the chat', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` }, payload: { agentType: 'pr_impact' },
    });
    const chatId = created.json().data.chat.id;
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/chats/${chatId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
  });

  it('returns 400 on invalid agentType', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentType: 'not_a_real_agent' },
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
docker compose -f infra/docker-compose.yml up -d postgres redis
sleep 5
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
pnpm --filter @prsi/backend test -- chat.routes
```

Expected: FAIL — `Cannot find module '../../src/routes/chat.routes.js'`.

- [ ] **Step 3: Implement `app/backend/src/routes/chat.routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createChat, listChats, getChat, deleteChat,
} from '../services/chat.service.js';

const CreateChatBody = z.object({
  agentType: z.string().min(1).max(50),
  title: z.string().max(255).optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/chats', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateChatBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const result = await createChat(req.user!.userId, parsed.data.agentType);
      return { success: true, data: result };
    } catch (err) {
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });

  app.get('/api/v1/chats', { preHandler: app.auth }, async (req) => {
    const chats = await listChats(req.user!.userId);
    return { success: true, data: { chats } };
  });

  app.get('/api/v1/chats/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await getChat(req.user!.userId, id);
    if (!chat) {
      reply.code(404);
      return { success: false, error: 'Chat not found' };
    }
    return { success: true, data: { chat } };
  });

  app.delete('/api/v1/chats/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteChat(req.user!.userId, id);
      return { success: true, data: { message: 'Deleted' } };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });
}
```

- [ ] **Step 4: Wire chatRoutes in `server.ts`**

Add to `buildServer()` after `await app.register(agentRoutes);`:

```ts
import { chatRoutes } from './routes/chat.routes.js';
// ... inside buildServer():
await app.register(chatRoutes);
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
pnpm --filter @prsi/backend test -- chat.routes
```

Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/routes/chat.routes.ts app/backend/src/server.ts app/backend/test/routes/chat.routes.test.ts
git commit -m "M3.7: chat CRUD routes (POST/GET/DELETE /chats + GET /chats/:id)"
```

---

## Task 8: Messages routes (POST + GET) — full conversation integration test

**Files:**
- Modify: `app/backend/src/routes/chat.routes.ts` — add 2 routes
- Modify: `app/backend/test/routes/chat.routes.test.ts` — append the integration test

- [ ] **Step 1: Extend `app/backend/src/routes/chat.routes.ts`** — add two routes inside the same `chatRoutes` function, after the existing 4:

```ts
const SendMessageBody = z.object({
  content: z.string().min(1).max(4000),
  choice: z.string().max(100).optional(),
});

app.post('/api/v1/chats/:id/messages', { preHandler: app.auth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { success: false, error: 'Invalid body' };
  }
  try {
    const out = await appendUserMessage(
      req.user!.userId, id, parsed.data.content, parsed.data.choice,
    );
    return { success: true, data: out };
  } catch (err) {
    reply.code(404);
    return { success: false, error: (err as Error).message };
  }
});

app.get('/api/v1/chats/:id/messages', { preHandler: app.auth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const messages = await listMessages(req.user!.userId, id);
    return { success: true, data: { messages } };
  } catch (err) {
    reply.code(404);
    return { success: false, error: (err as Error).message };
  }
});
```

Don't forget to add the matching import at the top of the file:

```ts
import { createChat, listChats, getChat, deleteChat, appendUserMessage, listMessages } from '../services/chat.service.js';
```

- [ ] **Step 2: Append the full-conversation integration test**

Append to `app/backend/test/routes/chat.routes.test.ts` inside the existing `describe` block (before the final `});`):

```ts
it('full conversation: advances state through all 6 steps', async () => {
  // Create chat
  const created = await app.inject({
    method: 'POST', url: '/api/v1/chats',
    headers: { authorization: `Bearer ${token}` }, payload: { agentType: 'pr_impact' },
  });
  const chatId = created.json().data.chat.id;

  // Step 1: welcome → awaiting_date (any user input)
  let r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'Analyze brand sentiment', choice: 'analyze_sentiment' },
  });
  expect(r.statusCode).toBe(200);

  // Step 2: awaiting_date → awaiting_enrichment (weekly chip)
  r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'Weekly', choice: 'weekly' },
  });
  expect(r.statusCode).toBe(200);

  // Step 3: awaiting_enrichment → awaiting_brand
  r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'Enrichment', choice: 'enrichment' },
  });
  expect(r.statusCode).toBe(200);

  // Step 4: awaiting_brand → awaiting_competitors (free text)
  r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'FreshSip' },
  });
  expect(r.statusCode).toBe(200);

  // Step 5: awaiting_competitors → awaiting_intention
  r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'Top 5', choice: 'top5' },
  });
  expect(r.statusCode).toBe(200);

  // Step 6: awaiting_intention → ready
  r = await app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: 'Intention-based', choice: 'intention_based' },
  });
  expect(r.statusCode).toBe(200);

  // Verify final state
  const chatRes = await app.inject({
    method: 'GET', url: `/api/v1/chats/${chatId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(chatRes.json().data.chat.context.state).toBe('ready');
  expect(chatRes.json().data.chat.context.brand).toBe('FreshSip');

  // Verify message thread has welcome + 6 user + 6 AI = 13 messages
  const msgs = await app.inject({
    method: 'GET', url: `/api/v1/chats/${chatId}/messages`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(msgs.json().data.messages.length).toBeGreaterThanOrEqual(13);
});
```

- [ ] **Step 3: Run the full test suite — this exercises Azure OpenAI**

The integration test calls real Azure OpenAI through OrchestratorAgent. You MUST have `AZURE_OPENAI_API_KEY` set in `app/backend/.env` for this to pass (see Prerequisites at top of plan).

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/backend test -- chat.routes
```

Expected: 6 tests pass (5 from Task 7 + 1 new conversation flow). Conversation flow may take ~30 seconds because each step calls Azure OpenAI.

If Azure key isn't set, the new conversation test will error with a 500 (OrchestratorAgent's `chatComplete` throws). That's the expected gating behavior — fix by setting the key.

- [ ] **Step 4: Tear down compose if no other tasks need it**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
docker compose -f infra/docker-compose.yml down
```

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/routes/chat.routes.ts app/backend/test/routes/chat.routes.test.ts
git commit -m "M3.8: messages routes + full-conversation integration test"
```

---

## Task 9: Frontend route group restructure

**Files:**
- Create: `app/frontend/app/(authed)/layout.tsx`
- Create: `app/frontend/app/(authed)/page.tsx` — moved from `app/page.tsx`
- Create: `app/frontend/app/(auth)/login/page.tsx` — moved from `app/login/page.tsx`
- Delete: `app/frontend/app/page.tsx`
- Delete: `app/frontend/app/login/page.tsx`

Next.js route groups in parentheses don't appear in the URL — they're for organizational/layout grouping only. After this task: `/` URL still serves home (now from `(authed)/page.tsx`), `/login` URL still serves login (from `(auth)/login/page.tsx`). The `(authed)` layout wraps both home and the future chat page.

- [ ] **Step 1: Move login page (no content change, just path)**

```bash
cd "c:/KhadarBasha/PR Solutions/app/frontend/app"
mkdir -p "(auth)/login"
mv login/page.tsx "(auth)/login/page.tsx"
rmdir login
```

- [ ] **Step 2: Create `app/(authed)/layout.tsx`** — minimal AuthGate wrap for now; sidebar comes in Task 10:

```tsx
import { AuthGate } from '../../components/auth/AuthGate';
import type { ReactNode } from 'react';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
```

- [ ] **Step 3: Move home page**

```bash
cd "c:/KhadarBasha/PR Solutions/app/frontend/app"
mkdir -p "(authed)"
mv page.tsx "(authed)/page.tsx"
```

- [ ] **Step 4: Remove the now-redundant AuthGate wrapper inside `(authed)/page.tsx`**

The layout (from Step 2) already wraps every authed page in `AuthGate`. The page should now be just the `Home` component without `<AuthGate>`. Replace the file:

```tsx
'use client';
import { useAuthStore } from '../../lib/auth-store';
import { greetingFor } from '../../lib/greeting';
import { apiFetch } from '../../lib/api-client';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const { user, clear } = useAuthStore();

  async function handleLogout(): Promise<void> {
    try { await apiFetch('/api/v1/auth/session', { method: 'DELETE' }); } catch { /* */ }
    clear();
    router.replace('/login');
  }

  return (
    <main className="min-h-screen p-12 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-12">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-text-primary">
            {greetingFor()}, <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
          </h1>
          <p className="text-text-secondary">
            M2 — Auth flow online. The full home page with 5 agent cards arrives in M3.
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-sm font-medium rounded-md border border-border-default
                     hover:bg-surface-hover text-text-primary transition"
        >
          Sign out
        </button>
      </div>
      <div className="card">
        <p className="text-sm text-text-secondary">
          Signed in as <code className="font-mono bg-win-blue-50 px-1.5 py-0.5 rounded-sm">{user?.email}</code>{' '}
          (role: {user?.role}).
        </p>
      </div>
    </main>
  );
}
```

(Task 11 replaces this with the 5-agent-card grid; for now we just preserve the M2 home behavior.)

- [ ] **Step 5: Verify build still works**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: `Compiled successfully`. Route table shows `/` and `/login` exactly as before.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/app/
git commit -m "M3.9: route group restructure — (auth)/login + (authed) layout"
```

---

## Task 10: Sidebar + Topbar components

**Files:**
- Create: `app/frontend/components/layout/Sidebar.tsx`
- Create: `app/frontend/components/layout/Topbar.tsx`
- Create: `app/frontend/lib/chats.ts` — chat API client for sidebar
- Modify: `app/frontend/app/(authed)/layout.tsx` — render Sidebar around children

- [ ] **Step 1: Create `app/frontend/lib/chats.ts`** — typed client used by sidebar + chat page

```ts
'use client';
import { apiFetch } from './api-client';

export interface ChatSummary {
  id: string;
  agentType: string;
  title: string | null;
  status: 'active' | 'completed' | 'archived';
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  type: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
}

export interface ChipDef { label: string; value: string }

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: { chips?: ChipDef[]; choice?: string };
  createdAt: string;
}

export interface ChatDetail extends ChatSummary {
  context: Record<string, unknown>;
}

export async function listAgents(): Promise<AgentSummary[]> {
  return apiFetch<{ agents: AgentSummary[] }>('/api/v1/agents').then((d) => d.agents);
}

export async function listChats(): Promise<ChatSummary[]> {
  return apiFetch<{ chats: ChatSummary[] }>('/api/v1/chats').then((d) => d.chats);
}

export async function createChat(agentType: string): Promise<{ chat: ChatDetail; welcomeMessage: ChatMessage }> {
  return apiFetch('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ agentType }),
  });
}

export async function getChat(id: string): Promise<ChatDetail> {
  return apiFetch<{ chat: ChatDetail }>(`/api/v1/chats/${id}`).then((d) => d.chat);
}

export async function deleteChat(id: string): Promise<void> {
  await apiFetch(`/api/v1/chats/${id}`, { method: 'DELETE' });
}

export async function listMessages(chatId: string): Promise<ChatMessage[]> {
  return apiFetch<{ messages: ChatMessage[] }>(`/api/v1/chats/${chatId}/messages`).then((d) => d.messages);
}

export async function sendMessage(
  chatId: string, content: string, choice?: string,
): Promise<{ userMessage: ChatMessage; aiMessage: ChatMessage }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, choice }),
  });
}
```

- [ ] **Step 2: Create `app/frontend/components/layout/Sidebar.tsx`**

```tsx
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '../../lib/auth-store';
import { listChats, type ChatSummary } from '../../lib/chats';
import { apiFetch } from '../../lib/api-client';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const [chats, setChats] = useState<ChatSummary[]>([]);

  useEffect(() => {
    listChats().then(setChats).catch(() => setChats([]));
  }, [pathname]);

  async function handleLogout(): Promise<void> {
    try { await apiFetch('/api/v1/auth/session', { method: 'DELETE' }); } catch {}
    clear();
    router.replace('/login');
  }

  const initials = (user?.displayName ?? user?.email ?? 'U')
    .split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();

  return (
    <aside className="w-[272px] min-w-[272px] bg-surface-sidebar border-r border-border-default
                      flex flex-col h-screen">
      <div className="px-3.5 pt-3.5 pb-1.5 flex items-center gap-2.5">
        <div className="w-[30px] h-[30px] bg-win-blue-500 rounded-sm flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
            <path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" />
          </svg>
        </div>
        <div className="text-[0.92rem] font-bold tracking-tight">PR Solutions</div>
      </div>

      <Link
        href="/"
        className="mx-2.5 mt-1.5 px-3.5 py-2.5 bg-win-blue-500 text-white rounded-md
                   text-sm font-semibold flex items-center gap-2 hover:bg-win-blue-600 transition"
      >
        + New Chat
      </Link>

      <nav className="px-2.5 py-2">
        <SidebarLink href="/" label="Home" active={pathname === '/'} />
        <SidebarLink href="#" label="Settings (coming in M5)" active={false} disabled />
      </nav>

      <div className="px-2 pt-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-text-tertiary">
        Recent Chats
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        {chats.length === 0 && (
          <div className="text-xs text-text-tertiary px-2 py-1">No chats yet</div>
        )}
        {chats.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={`block px-2.5 py-2 rounded-md text-[0.82rem] truncate
                        ${pathname === `/chat/${c.id}` ? 'bg-win-blue-50 text-win-blue-600 font-medium' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}
                        transition`}
          >
            {c.title ?? 'Untitled chat'}
          </Link>
        ))}
      </div>

      <button
        onClick={handleLogout}
        className="px-3.5 py-2.5 border-t border-border-default flex items-center gap-2.5
                   hover:bg-surface-hover transition text-left"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-win-blue-500 to-win-teal
                        text-white text-[0.78rem] font-bold flex items-center justify-center">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[0.82rem] font-semibold truncate">{user?.displayName}</div>
          <div className="text-[0.7rem] text-text-tertiary truncate">Sign out</div>
        </div>
      </button>
    </aside>
  );
}

function SidebarLink({ href, label, active, disabled }: { href: string; label: string; active: boolean; disabled?: boolean }) {
  const cls = `flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition w-full text-left
               ${active ? 'bg-win-blue-50 text-win-blue-500 font-semibold' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}
               ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`;
  if (disabled) return <div className={cls}>{label}</div>;
  return <Link href={href} className={cls}>{label}</Link>;
}
```

- [ ] **Step 3: Create `app/frontend/components/layout/Topbar.tsx`**

```tsx
'use client';
import type { ReactNode } from 'react';

export function Topbar({ title, badge, right }: { title: string; badge?: string; right?: ReactNode }) {
  return (
    <header className="h-12 px-5 flex items-center justify-between bg-surface-card border-b border-border-subtle">
      <div className="flex items-center gap-2.5">
        <h2 className="text-[0.95rem] font-semibold">{title}</h2>
        {badge && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[0.72rem] font-semibold
                           bg-win-blue-50 text-win-blue-600">
            <span className="w-1.5 h-1.5 rounded-full bg-win-green" />
            {badge}
          </span>
        )}
      </div>
      {right}
    </header>
  );
}
```

- [ ] **Step 4: Update `app/(authed)/layout.tsx`** to render Sidebar around children

```tsx
import { AuthGate } from '../../components/auth/AuthGate';
import { Sidebar } from '../../components/layout/Sidebar';
import type { ReactNode } from 'react';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
      </div>
    </AuthGate>
  );
}
```

- [ ] **Step 5: Verify build**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: builds clean. Visiting `/` now shows sidebar+content layout.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/components/layout/ app/frontend/lib/chats.ts app/frontend/app/(authed)/layout.tsx
git commit -m "M3.10: Sidebar + Topbar components + typed chats API client"
```

---

## Task 11: Home page — 5 agent cards + greeting

**Files:**
- Create: `app/frontend/components/home/AgentCard.tsx`
- Modify: `app/frontend/app/(authed)/page.tsx` — replace placeholder with full home

- [ ] **Step 1: Create `app/frontend/components/home/AgentCard.tsx`**

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createChat, type AgentSummary } from '../../lib/chats';

export function AgentCard({ agent }: { agent: AgentSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const { chat } = await createChat(agent.type);
      router.push(`/chat/${chat.id}`);
    } catch {
      setBusy(false);
    }
  }

  const color = agent.color ?? '#0078D4';

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="text-left bg-surface-card rounded-lg shadow-win-4 p-6 hover:shadow-win-8
                 hover:-translate-y-0.5 transition transform border border-border-subtle
                 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div
        className="w-11 h-11 rounded-md flex items-center justify-center mb-4"
        style={{ background: `${color}1A` }}
      >
        <div className="w-6 h-6 rounded" style={{ background: color }} />
      </div>
      <h3 className="text-base font-semibold text-text-primary mb-1.5">{agent.name}</h3>
      <p className="text-[0.82rem] text-text-secondary line-clamp-3">{agent.description}</p>
    </button>
  );
}
```

- [ ] **Step 2: Replace `app/(authed)/page.tsx`** with the full home

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../lib/auth-store';
import { greetingFor } from '../../lib/greeting';
import { Topbar } from '../../components/layout/Topbar';
import { AgentCard } from '../../components/home/AgentCard';
import { listAgents, type AgentSummary } from '../../lib/chats';

export default function HomePage() {
  const user = useAuthStore((s) => s.user);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgents()
      .then((a) => { setAgents(a); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <>
      <Topbar title="Home" badge="Online" />
      <main className="flex-1 overflow-y-auto p-12">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-3xl font-bold mb-2 text-text-primary">
            {greetingFor()}, <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
          </h1>
          <p className="text-text-secondary mb-10">
            Pick an agent below to start a new analysis.
          </p>

          {loading ? (
            <div className="text-text-tertiary">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="text-text-tertiary">No agents available.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Build + visual smoke**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: clean.

(Optional: run dev server, open `http://localhost:3000/`, see sidebar + 5 agent cards rendered after login.)

- [ ] **Step 4: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/components/home/ app/frontend/app/(authed)/page.tsx
git commit -m "M3.11: home page — 5 agent cards + greeting"
```

---

## Task 12: Chat page — thread + chips + input

**Files:**
- Create: `app/frontend/components/chat/MessageBubble.tsx`
- Create: `app/frontend/components/chat/ChipRow.tsx`
- Create: `app/frontend/components/chat/MessageThread.tsx`
- Create: `app/frontend/components/chat/ChatInput.tsx`
- Create: `app/frontend/app/(authed)/chat/[id]/page.tsx`

- [ ] **Step 1: Create `app/frontend/components/chat/MessageBubble.tsx`**

```tsx
'use client';
import type { ChatMessage } from '../../lib/chats';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-2.5 max-w-3xl ${isUser ? 'self-end flex-row-reverse' : 'self-start'}`}>
      <div
        className={`w-[30px] h-[30px] rounded-full flex-shrink-0 flex items-center justify-center
                    text-[0.72rem] font-bold ${
                      isUser
                        ? 'bg-surface-hover text-text-secondary'
                        : 'bg-gradient-to-br from-win-blue-500 to-win-teal text-white'
                    }`}
      >
        {isUser ? 'You' : 'AI'}
      </div>
      <div
        className={`px-4 py-2.5 rounded-lg text-[0.9rem] whitespace-pre-wrap ${
          isUser
            ? 'bg-win-blue-500 text-white rounded-tr-sm'
            : 'bg-surface-card text-text-primary rounded-tl-sm shadow-win-2'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `app/frontend/components/chat/ChipRow.tsx`**

```tsx
'use client';
import type { ChipDef } from '../../lib/chats';

interface Props {
  chips: ChipDef[];
  onPick: (chip: ChipDef) => void;
  disabled?: boolean;
}

export function ChipRow({ chips, onPick, disabled }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pl-10">
      {chips.map((chip) => (
        <button
          key={chip.value}
          onClick={() => onPick(chip)}
          disabled={disabled}
          className="px-3 py-1.5 text-[0.82rem] font-medium rounded-pill
                     bg-win-blue-50 text-win-blue-600 hover:bg-win-blue-100
                     border border-win-blue-100 transition
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
```

(`rounded-pill` — add to `app/frontend/tailwind.config.ts` under `extend.borderRadius`: `pill: '9999px'`. If you skipped that in M2.8, add it now alongside `sm`/`md`/`lg`/`xl`.)

- [ ] **Step 3: Create `app/frontend/components/chat/MessageThread.tsx`**

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChipRow } from './ChipRow';
import type { ChatMessage, ChipDef } from '../../lib/chats';

interface Props {
  messages: ChatMessage[];
  onChipPick: (chip: ChipDef) => void;
  busy?: boolean;
}

export function MessageThread({ messages, onChipPick, busy }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const last = messages[messages.length - 1];
  const lastChips: ChipDef[] = last?.role === 'assistant' ? (last.metadata.chips ?? []) : [];

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3.5">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {!busy && <ChipRow chips={lastChips} onPick={onChipPick} />}
      {busy && (
        <div className="flex gap-2.5 pl-10 text-text-tertiary text-[0.82rem]">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse" style={{ animationDelay: '120ms' }}>●</span>
          <span className="animate-pulse" style={{ animationDelay: '240ms' }}>●</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 4: Create `app/frontend/components/chat/ChatInput.tsx`**

```tsx
'use client';
import { useState, type FormEvent } from 'react';

export function ChatInput({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('');

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-border-default bg-surface-card px-5 py-3.5 flex items-center gap-2.5"
    >
      <button
        type="button"
        disabled
        className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary
                   hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed"
        title="Attachment — coming in Phase 2"
      >
        📎
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message…"
        disabled={disabled}
        className="flex-1 px-3.5 py-2.5 text-sm border border-border-default rounded-md
                   bg-surface-card text-text-primary outline-none
                   focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                   transition disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={disabled || text.trim().length === 0}
        className="px-4 py-2.5 text-sm font-semibold rounded-md
                   bg-win-blue-500 text-white shadow-win-2
                   hover:bg-win-blue-600 active:bg-win-blue-700
                   disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        Send
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Create `app/(authed)/chat/[id]/page.tsx`**

```tsx
'use client';
import { useEffect, useState, use } from 'react';
import { Topbar } from '../../../../components/layout/Topbar';
import { MessageThread } from '../../../../components/chat/MessageThread';
import { ChatInput } from '../../../../components/chat/ChatInput';
import {
  getChat, listMessages, sendMessage,
  type ChatDetail, type ChatMessage, type ChipDef,
} from '../../../../lib/chats';
import { ApiError } from '../../../../lib/api-client';
import { useRouter } from 'next/navigation';

interface PageProps { params: Promise<{ id: string }> }

export default function ChatPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, m] = await Promise.all([getChat(id), listMessages(id)]);
        if (!cancelled) {
          setChat(c);
          setMessages(m);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          router.replace('/');
          return;
        }
        if (!cancelled) setError('Failed to load chat.');
      }
    })();
    return () => { cancelled = true; };
  }, [id, router]);

  async function handleSend(content: string, choice?: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await sendMessage(id, content, choice);
      setMessages((prev) => [...prev, out.userMessage, out.aiMessage]);
    } catch {
      setError('Message failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function handleChip(chip: ChipDef): void {
    void handleSend(chip.label, chip.value);
  }

  return (
    <>
      <Topbar title={chat?.title ?? 'Chat'} badge="Online" />
      <div className="flex-1 flex flex-col overflow-hidden">
        {error && (
          <div role="alert" className="bg-red-50 border-b border-red-200 text-win-red text-sm px-5 py-2">
            {error}
          </div>
        )}
        <MessageThread messages={messages} onChipPick={handleChip} busy={busy} />
        <ChatInput onSend={(text) => handleSend(text)} disabled={busy} />
      </div>
    </>
  );
}
```

- [ ] **Step 6: Build + typecheck**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: build clean. Route table now includes `/chat/[id]`.

- [ ] **Step 7: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/components/chat/ app/frontend/app/(authed)/chat/ app/frontend/tailwind.config.ts
git commit -m "M3.12: chat page — thread + chip row + input"
```

---

## Task 13: Playwright M3 acceptance + CLAUDE.md update

**Files:**
- Create: `app/tests/e2e/m3-chat.spec.ts`
- Modify: `CLAUDE.md` — mark M3 active milestone advanced to M4

- [ ] **Step 1: Create `app/tests/e2e/m3-chat.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${FE_URL}/login`);
  await page.getByLabel('Email').fill(A_EMAIL);
  await page.getByLabel('Password').fill(A_PASSWORD);
  await page.getByRole('button', { name: /Sign In/i }).click();
  await expect(page).toHaveURL(FE_URL + '/');
}

test.describe('M3: chat flow', () => {
  test('home shows 5 agent cards after login', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: /PR Impact Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Media Monitoring Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Media Measurement Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Reputation Index Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Crisis Management Agent/i })).toBeVisible();
  });

  test('clicking PR Impact Agent creates a chat and lands on /chat/:id', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);
    // Welcome message + first chips visible
    await expect(page.getByText(/PR Impact|brand/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test('full 6-step flow reaches "ready" state', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // welcome → click a welcome chip
    await page.getByRole('button', { name: /Analyze brand sentiment/i }).click();
    // awaiting_date → Weekly
    await page.getByRole('button', { name: /Weekly/i }).click();
    // awaiting_enrichment → Enrichment
    await page.getByRole('button', { name: /^Enrichment$/i }).click();
    // awaiting_brand → type brand
    await page.getByPlaceholder(/Type a message/i).fill('FreshSip');
    await page.getByRole('button', { name: /Send/i }).click();
    // awaiting_competitors → Top 5
    await page.getByRole('button', { name: /Top 5/i }).click();
    // awaiting_intention → Intention-based
    await page.getByRole('button', { name: /Intention-based/i }).click();

    // Should see a "Phase 2" line in the final reply
    await expect(page.getByText(/Phase 2/i)).toBeVisible({ timeout: 30_000 });
  });

  test('recent chats appear in the sidebar', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await page.goto(`${FE_URL}/`);
    // Sidebar should now list at least one chat
    await expect(page.getByRole('link', { name: /PR Impact Agent/i }).first()).toBeVisible();
  });
});
```

- [ ] **Step 2: Update `CLAUDE.md` "Current state"**

Replace the section with:

```markdown
## Current state

- **Active phase:** Phase 1 — Foundation Core
- **Active milestone:** M4 — WebSocket + OrchestratorAgent streaming *(M3 chat + REST messaging complete)*
- **Completed milestones:** M1 (repo scaffold), M2 (auth flow), M6 (deploy: Vercel + Render), M3 (chat creation + REST messaging)
- **Remaining:** M4 (WebSocket streaming), M5 (settings tabs)
- See `docs/phase1.md` for milestone breakdown and `docs/plans/` for per-milestone plans.
```

(Live URLs section remains as-is.)

- [ ] **Step 3: Run the full e2e suite locally against compose (one final verify)**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm up
sleep 60
pnpm --filter @prsi/e2e test
```

Expected: M1's 3 tests + M2's 4 tests + M3's 4 tests = 11 tests pass.

If the M3 conversation test fails because Azure OpenAI is slow/down, the M1/M2 tests should still pass — that confirms no regression. Re-run when Azure is available.

- [ ] **Step 4: Tear down + commit**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm down
```

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/tests/e2e/m3-chat.spec.ts CLAUDE.md
git commit -m "M3.13: Playwright acceptance + CLAUDE.md M3 complete"
```

---

## M3 Definition of Done

- [ ] `pnpm --filter @prsi/backend test` passes (existing 34 + new ~25 = ~59 tests)
- [ ] `pnpm --filter @prsi/frontend typecheck` clean
- [ ] `pnpm --filter @prsi/frontend build` clean
- [ ] `pnpm up` brings the local stack healthy
- [ ] Login as `user-a@test.local` / `Password123!` → home shows 5 agent cards
- [ ] Click PR Impact Agent → lands on `/chat/<uuid>` with a welcome message + chips
- [ ] Click chips through all 6 states → final reply mentions "Phase 2"
- [ ] Reload chat → message thread persists
- [ ] Sidebar lists the chat under "Recent Chats"
- [ ] Sign out → redirect to /login; revisit `/chat/<old-id>` → redirect to /login
- [ ] Playwright `m3-chat.spec.ts` 4/4 passes; M1+M2 suites still pass
- [ ] No CORS errors in browser console against Render backend (when deployed)
- [ ] M3 branch merged to main via PR → Vercel + Render auto-redeploy

---

## Self-review notes

**Spec coverage (against the M3 design from brainstorming):**
- Sidebar + topbar + 5-card home + chat thread + chips → Tasks 10/11/12 ✓
- BaseAgent + AgentRegistry + OrchestratorAgent → Tasks 2/4 ✓
- 6-step state machine (date → enrichment → brand → competitors → intention → ready) → Task 3 ✓
- Azure OpenAI for natural phrasing → Tasks 1/4 ✓
- `chats.context` JSONB persistence → Task 5 ✓
- 8 new REST endpoints (`/agents`, `/agents/:id`, `/chats` CRUD, `/chats/:id/messages` POST+GET) → Tasks 6/7/8 ✓
- RLS-scoped access via `withUser` → Task 5 ✓
- Playwright acceptance → Task 13 ✓

**No placeholders verified:** every step has concrete code, exact file paths, exact commands.

**Type consistency:**
- `ConversationState` defined in Task 3 → used in Tasks 4/5 ✓
- `ChatContext`/`Chip`/`AdvanceResult` defined in Task 3 → used downstream ✓
- `ChatRecord`/`MessageRecord`/`AppendResult` defined in Task 5 → used by Tasks 7/8 ✓
- `AgentSummary`/`ChatSummary`/`ChatMessage` defined in Task 10 → used by Tasks 11/12 ✓
- `chatComplete`/`parseChoice` defined in Task 1 → used in Task 4 ✓

**Open items / known M3 gotchas:**
- The `pill` border-radius token used in `ChipRow.tsx` must exist in `tailwind.config.ts`. If M2.8 didn't add it, do so before Task 12 Step 7.
- The Azure OpenAI key MUST be in env (backend/.env or shell) before Task 8 — otherwise the conversation integration test will 500.
- `next.config.js` already env-conditional `output: standalone` from M1.4-fix; Vercel uses non-standalone, Render Docker uses standalone. No change in M3.
- The `chats.context` JSONB shape is a convention, not a Prisma schema column-by-column field. The `ChatContext` TypeScript interface is the source of truth for what's allowed in the JSONB.
- Settings link in sidebar is a placeholder div (not a Link). When M5 lands it becomes a real Link.
