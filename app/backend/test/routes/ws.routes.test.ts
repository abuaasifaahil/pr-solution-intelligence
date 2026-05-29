import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

// Use a real ioredis stub: just expose duplicate() that creates fake instances
// with shared state, like Task M4.1's test harness.
import EventEmitter from 'node:events';

class FakeRedis extends EventEmitter {
  private subscribed = new Set<string>();
  private static all: FakeRedis[] = [];
  constructor() { super(); FakeRedis.all.push(this); }
  async subscribe(channel: string) { this.subscribed.add(channel); }
  async unsubscribe(channel: string) { this.subscribed.delete(channel); }
  async publish(channel: string, message: string) {
    for (const peer of FakeRedis.all) {
      if (peer.subscribed.has(channel)) peer.emit('message', channel, message);
    }
    return 1;
  }
  duplicate() { return new FakeRedis(); }
  async quit() { return 'OK' as const; }
  async ping() { return 'PONG'; }
}

const sharedFake = new FakeRedis();
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => sharedFake,
  closeRedis: vi.fn(),
}));

// Stub agent + RLS so ws.routes can verify chat ownership.
vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    chat: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'chat-owned') return { id: 'chat-owned', userId: 'u1' };
        return null;
      }),
    },
    message: { findMany: vi.fn() },
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      chat: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === 'chat-owned' ? { id: 'chat-owned', userId: 'u1' } : null,
      },
    })),
  asAdmin: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');
const { publishChatEvent } = await import('../../src/lib/event-bus.js');

const token = signAccess({
  userId: 'u1', email: 'a@test.local', role: 'analyst', sessionId: 's',
});

describe('WS /ws/chat/:chatId', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    baseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => { await app.close(); });

  it('rejects with 401 when token is missing', async () => {
    const ws = new WebSocket(`${baseUrl}/ws/chat/chat-owned`);
    await new Promise<void>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        ws.terminate();
        resolve();
      });
      ws.on('error', () => resolve());
    });
  });

  it('rejects with 404 when chat is not owned by user', async () => {
    const ws = new WebSocket(`${baseUrl}/ws/chat/some-other-chat?token=${token}`);
    await new Promise<void>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(404);
        ws.terminate();
        resolve();
      });
      ws.on('error', () => resolve());
    });
  });

  it('forwards Redis events as newline-delimited JSON', async () => {
    const ws = new WebSocket(`${baseUrl}/ws/chat/chat-owned?token=${token}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const received: Array<{ type: string; payload: unknown }> = [];
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        received.push(JSON.parse(line));
      }
    });

    // Give the route a tick to finish subscribe()
    await new Promise((r) => setTimeout(r, 50));
    await publishChatEvent('chat-owned', 'typing:start', { assistantMessageId: 'a1' });
    await publishChatEvent('chat-owned', 'message:chunk', { assistantMessageId: 'a1', delta: 'Hi' });
    await new Promise((r) => setTimeout(r, 80));

    ws.close();
    expect(received).toEqual([
      { type: 'typing:start', payload: { assistantMessageId: 'a1' } },
      { type: 'message:chunk', payload: { assistantMessageId: 'a1', delta: 'Hi' } },
    ]);
  });
});
