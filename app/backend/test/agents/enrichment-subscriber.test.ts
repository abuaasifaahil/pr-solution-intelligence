/**
 * M8.4 — enrichment-subscriber unit tests.
 *
 * Mocks ioredis + AgentRegistry. Two surfaces are tested:
 *   - startEnrichmentSubscriber wires a SUBSCRIBE on the right channel
 *   - handleMessage routes valid payloads to the EnrichmentAgent and
 *     swallows malformed payloads / missing-agent / agent errors
 *
 * The real subscriber pins NODE_ENV=test → no-op, so we flip NODE_ENV for
 * the start test and clean up afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────
// ioredis mock — a single instance we can introspect from tests.
// ───────────────────────────────────────────────────────────────────────
const redisInstance = {
  subscribe: vi.fn((channel: string, cb?: (err: Error | null) => void) => {
    if (cb) cb(null);
  }),
  unsubscribe: vi.fn(async () => 0),
  on: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => redisInstance),
}));

// ───────────────────────────────────────────────────────────────────────
// AgentRegistry mock — controllable per-test.
// ───────────────────────────────────────────────────────────────────────
const fakeAgent = {
  execute: vi.fn(async () => ({})),
};

let registeredAgent: typeof fakeAgent | null = fakeAgent;
vi.mock('../../src/agents/agent-registry.js', () => ({
  AgentRegistry: {
    getByType: vi.fn(() => registeredAgent),
  },
}));

const {
  startEnrichmentSubscriber,
  stopEnrichmentSubscriber,
  handleMessage,
  ENRICHMENT_INCOMING_CHANNEL,
} = await import('../../src/agents/enrichment-subscriber.js');

const originalNodeEnv = process.env.NODE_ENV;
const originalRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  redisInstance.subscribe.mockClear();
  redisInstance.unsubscribe.mockClear();
  redisInstance.on.mockClear();
  redisInstance.disconnect.mockClear();
  fakeAgent.execute.mockClear();
  registeredAgent = fakeAgent;
});

afterEach(async () => {
  await stopEnrichmentSubscriber();
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
});

describe('startEnrichmentSubscriber', () => {
  it('subscribes to agent:enrichment:incoming when env permits', () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_URL = 'redis://localhost:6379';
    startEnrichmentSubscriber();
    expect(redisInstance.subscribe).toHaveBeenCalledWith(
      ENRICHMENT_INCOMING_CHANNEL,
      expect.any(Function),
    );
    expect(redisInstance.on).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
  });

  it('is idempotent — second call does not re-subscribe', () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_URL = 'redis://localhost:6379';
    startEnrichmentSubscriber();
    startEnrichmentSubscriber();
    expect(redisInstance.subscribe).toHaveBeenCalledTimes(1);
  });

  it('no-ops under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    startEnrichmentSubscriber();
    expect(redisInstance.subscribe).not.toHaveBeenCalled();
  });

  it('no-ops when REDIS_URL is unset', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.REDIS_URL;
    startEnrichmentSubscriber();
    expect(redisInstance.subscribe).not.toHaveBeenCalled();
  });
});

describe('handleMessage', () => {
  it('routes a valid payload to EnrichmentAgent.execute', async () => {
    const payload = {
      chatId: 'chat-1',
      userId: 'user-1',
      articleIds: ['a', 'b'],
      enrichmentType: 'reach' as const,
    };
    await handleMessage(JSON.stringify(payload));
    expect(fakeAgent.execute).toHaveBeenCalledTimes(1);
    expect(fakeAgent.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'chat-1',
      message: '',
      metadata: {
        articleIds: ['a', 'b'],
        enrichmentType: 'reach',
      },
    });
  });

  it('coerces missing articleIds to []', async () => {
    await handleMessage(
      JSON.stringify({ chatId: 'chat-2', userId: 'user-2' }),
    );
    expect(fakeAgent.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { articleIds: [], enrichmentType: undefined },
      }),
    );
  });

  it('malformed JSON → logs error, does not crash, does not call agent', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleMessage('not json {{')).resolves.toBeUndefined();
    expect(fakeAgent.execute).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      '[enrichment-subscriber] malformed payload',
      expect.any(Object),
    );
    errSpy.mockRestore();
  });

  it('no agent registered → logs error, does not crash', async () => {
    registeredAgent = null;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      handleMessage(
        JSON.stringify({ chatId: 'c', userId: 'u', articleIds: [] }),
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      '[enrichment-subscriber] no EnrichmentAgent registered',
    );
    errSpy.mockRestore();
  });

  it('agent.execute throws → subscriber catches + logs', async () => {
    fakeAgent.execute.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      handleMessage(
        JSON.stringify({ chatId: 'c', userId: 'u', articleIds: [] }),
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      '[enrichment-subscriber] agent execute failed',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
