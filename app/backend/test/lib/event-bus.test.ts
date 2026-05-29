import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock ioredis with a tiny in-memory pub/sub that exercises the same surface
// (publish + subscribe + message event + quit). One pub instance + one sub instance.
interface FakeRedisInstance {
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string) => Promise<void>;
  unsubscribe: (channel: string) => Promise<void>;
  on: (event: 'message', handler: (channel: string, message: string) => void) => void;
  duplicate: () => FakeRedisInstance;
  quit: () => Promise<'OK'>;
}

const instances: FakeRedisInstance[] = [];

function makeInstance(): FakeRedisInstance {
  const listeners = new Map<string, ((channel: string, message: string) => void)[]>();
  const subscribed = new Set<string>();
  const inst: FakeRedisInstance = {
    async publish(channel: string, message: string) {
      // Broadcast to ALL fake instances that have subscribed.
      for (const peer of instances) {
        if (peer._subscribed.has(channel)) {
          for (const cb of (peer._listeners.get('message') ?? [])) cb(channel, message);
        }
      }
      return 1;
    },
    async subscribe(channel: string) { subscribed.add(channel); },
    async unsubscribe(channel: string) { subscribed.delete(channel); },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    duplicate() { return makeInstance(); },
    async quit() { return 'OK' as const; },
    // expose internals for cross-instance broadcast above
    _listeners: listeners,
    _subscribed: subscribed,
  } as FakeRedisInstance & { _listeners: typeof listeners; _subscribed: typeof subscribed };
  instances.push(inst);
  return inst;
}

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => makeInstance(),
  closeRedis: vi.fn(),
}));

const { publishChatEvent, subscribeChatEvents } = await import('../../src/lib/event-bus.js');

describe('event-bus', () => {
  beforeEach(() => { instances.length = 0; });
  afterEach(() => { instances.length = 0; });

  it('delivers a published event to a subscriber on the same chatId', async () => {
    const received: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = await subscribeChatEvents('chat-1', (evt) => { received.push(evt); });
    await publishChatEvent('chat-1', 'typing:start', { assistantMessageId: 'a1' });
    await publishChatEvent('chat-1', 'message:chunk', { assistantMessageId: 'a1', delta: 'Hel' });
    expect(received).toEqual([
      { type: 'typing:start', payload: { assistantMessageId: 'a1' } },
      { type: 'message:chunk', payload: { assistantMessageId: 'a1', delta: 'Hel' } },
    ]);
    await unsubscribe();
  });

  it('does not deliver events from a different chatId', async () => {
    const received: unknown[] = [];
    const unsubscribe = await subscribeChatEvents('chat-1', (e) => received.push(e));
    await publishChatEvent('chat-2', 'message:chunk', { assistantMessageId: 'a1', delta: 'x' });
    expect(received).toHaveLength(0);
    await unsubscribe();
  });

  it('unsubscribe stops further delivery', async () => {
    const received: unknown[] = [];
    const unsubscribe = await subscribeChatEvents('chat-1', (e) => received.push(e));
    await unsubscribe();
    await publishChatEvent('chat-1', 'message:chunk', { assistantMessageId: 'a1', delta: 'x' });
    expect(received).toHaveLength(0);
  });
});
