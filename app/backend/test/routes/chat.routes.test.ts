import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Stateful AgentRegistry mock: each call to execute() runs the REAL state machine
// (orchestrator-state.advance) so the 6-step conversation can actually progress
// across messages. The LLM phrasing step is replaced with a templated reply.
vi.mock('../../src/agents/agent-registry.js', async () => {
  const stateMachine = await import('../../src/agents/orchestrator-state.js');
  return {
    AgentRegistry: {
      getByType: () => ({
        id: 'orch-id',
        name: 'PR Impact Agent',
        type: 'pr_impact',
        async execute(input: {
          metadata?: { currentState?: string; currentContext?: Record<string, unknown>; choice?: string };
          message: string;
        }) {
          const currentState = (input.metadata?.currentState ?? 'welcome') as Parameters<typeof stateMachine.advance>[0];
          const advInput = input.metadata?.choice
            ? { choice: input.metadata.choice }
            : { freeText: input.message };
          const result = stateMachine.advance(currentState, advInput, 'pr_impact');
          return {
            replyText: `[mock] ${result.replyTemplate.slice(0, 60)}…`,
            chips: result.chips,
            contextPatch: result.contextPatch,
          };
        },
      }),
      listAll: () => [],
      register: vi.fn(),
      clear: vi.fn(),
    },
  };
});

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

    // Verify message thread has welcome + 6 user + 6 AI = 13 messages.
    // M4: background streaming fills the placeholder asynchronously; poll up to 30s.
    let count = 0;
    for (let i = 0; i < 60; i++) {
      const msgs = await app.inject({
        method: 'GET', url: `/api/v1/chats/${chatId}/messages`,
        headers: { authorization: `Bearer ${token}` },
      });
      count = msgs.json().data.messages.length;
      if (count >= 13) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(count).toBeGreaterThanOrEqual(13);
  });
});
