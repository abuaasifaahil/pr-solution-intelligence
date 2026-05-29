import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/agents/agent-registry.js', () => ({
  AgentRegistry: {
    getByType: () => ({
      execute: vi.fn().mockResolvedValue({
        replyText: 'Welcome (mocked).',
        chips: [{ label: 'Analyze brand sentiment', value: 'analyze_sentiment' }],
        contextPatch: { state: 'welcome' },
      }),
      id: 'orch-id', name: 'PR Impact Agent', type: 'pr_impact',
    }),
    listAll: () => [],
    register: vi.fn(),
    clear: vi.fn(),
  },
}));

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
