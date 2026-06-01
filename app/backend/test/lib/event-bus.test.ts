import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock ioredis with a tiny in-memory pub/sub that exercises the same surface
// (publish + subscribe + message event + quit). One pub instance + one sub instance.
type MessageListener = (channel: string, message: string) => void;

interface FakeRedisInstance {
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string) => Promise<void>;
  unsubscribe: (channel: string) => Promise<void>;
  on: (event: 'message', handler: MessageListener) => void;
  duplicate: () => FakeRedisInstance;
  quit: () => Promise<'OK'>;
  // Internal fields used by publish() to broadcast across the fake instance pool.
  _listeners: Map<string, MessageListener[]>;
  _subscribed: Set<string>;
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
    _listeners: listeners,
    _subscribed: subscribed,
  };
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

  // M9.5 — SearchAgent event types are routable through the same channel.
  // We assert delivery here; the discriminated union is enforced at the
  // TypeScript layer (tsc would have rejected an unknown event name).
  it('routes M9.5 SearchAgent events end-to-end', async () => {
    const received: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = await subscribeChatEvents('chat-1', (e) => {
      received.push(e);
    });

    await publishChatEvent('chat-1', 'search:start', {
      chatId: 'chat-1',
      totalIndicesQueried: 17,
      indicesPreview: ['amx-data-*'],
    });
    await publishChatEvent('chat-1', 'search:progress', {
      chatId: 'chat-1',
      totalSoFar: 100,
      pagesScanned: 1,
      lastPage: false,
    });
    await publishChatEvent('chat-1', 'search:fetched', {
      chatId: 'chat-1',
      articlesInserted: 500,
      indicesQueried: ['amx-data-*'],
      latencyMsTotal: 1234,
    });
    await publishChatEvent('chat-1', 'reach:absent', {
      chatId: 'chat-1',
      coverageReach: 0.2,
      sampleSize: 50,
      suggestUpgrade: true,
    });
    await publishChatEvent('chat-1', 'search:complete', {
      chatId: 'chat-1',
      ready: true,
      count: 500,
    });
    await publishChatEvent('chat-1', 'search:error', {
      chatId: 'chat-1',
      message: 'Invalid OpenSearch query syntax or parameters.',
    });

    expect(received.map((r) => r.type)).toEqual([
      'search:start',
      'search:progress',
      'search:fetched',
      'reach:absent',
      'search:complete',
      'search:error',
    ]);
    await unsubscribe();
  });
});
