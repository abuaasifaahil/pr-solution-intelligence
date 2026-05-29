import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

// Mock just the LLM — keep the real Redis + Postgres + Fastify stack.
// chatComplete is used by the welcome-message path (createChat), so it must be mocked too.
vi.mock('../../src/lib/llm.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/llm.js')>(
    '../../src/lib/llm.js',
  );
  return {
    ...actual,
    chatComplete: vi.fn().mockResolvedValue('Welcome! How can I help you today?'),
    chatCompleteStream: async function* () {
      yield 'Hello ';
      yield 'there. ';
      yield 'What date range?';
    },
    parseChoice: vi.fn().mockResolvedValue('weekly'),
  };
});

import { buildServer } from '../../src/server.js';
import { prisma } from '@prsi/shared/db';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { signAccess } from '../../src/lib/jwt.js';
import { closeRedis } from '../../src/lib/redis.js';

const TEST_EMAIL = 'm4-int@test.local';

describe('M4 streaming end-to-end', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    baseUrl = `127.0.0.1:${addr.port}`;

    await prisma.message.deleteMany({ where: { chat: { user: { email: TEST_EMAIL } } } });
    await prisma.chat.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    const u = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'M4 Test',
        role: 'analyst',
      },
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

  it('POST /messages → WS events arrive in order: typing:start, chunks, typing:stop, message:new', async () => {
    // Create chat first.
    const created = await app.inject({
      method: 'POST', url: '/api/v1/chats',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentType: 'pr_impact' },
    });
    const chatId = created.json().data.chat.id;

    // Connect WS BEFORE sending message so we don't miss events.
    const ws = new WebSocket(`ws://${baseUrl}/ws/chat/${chatId}?token=${token}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const events: Array<{ type: string; payload: unknown }> = [];
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        events.push(JSON.parse(line));
      }
    });

    // Send a message — advances welcome → awaiting_date.
    const res = await app.inject({
      method: 'POST', url: `/api/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Analyze brand sentiment', choice: 'analyze_sentiment' },
    });
    expect(res.statusCode).toBe(200);
    const { assistantMessageId, chips } = res.json().data;
    expect(typeof assistantMessageId).toBe('string');
    expect(Array.isArray(chips)).toBe(true);

    // Wait up to 10s for message:new.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message:new')), 10_000);
      const interval = setInterval(() => {
        if (events.some((e) => e.type === 'message:new')) {
          clearTimeout(t);
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    ws.close();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('typing:start');
    expect(types).toContain('message:chunk');
    expect(types).toContain('typing:stop');
    expect(types[types.length - 1]).toBe('message:new');
    // typing:stop must come before message:new
    expect(types.indexOf('typing:stop')).toBeLessThan(types.indexOf('message:new'));

    // The placeholder message row was updated with the streamed content.
    const messages = await app.inject({
      method: 'GET', url: `/api/v1/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    const persisted = messages.json().data.messages.find(
      (m: { id: string }) => m.id === assistantMessageId,
    );
    expect(persisted.content).toContain('Hello');
  });
});
