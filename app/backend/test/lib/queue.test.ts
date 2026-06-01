/**
 * M7.2 — BullMQ queue + inline worker integration test.
 *
 * Requires a live Redis. Falls back to the docker-compose dev URL so
 * `pnpm test` works without manually exporting REDIS_URL (mirroring the
 * Phase 2 RLS integration test). If Redis can't be reached, the whole
 * suite skips with a clear log line — same posture as the existing
 * integration tests when their dependencies are down.
 */
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';

// Probe Redis BEFORE importing queue.ts. If unreachable OR running a version
// older than 5.0 (BullMQ's minimum), mark the suite as `describe.skip` so
// we don't open a connection that will spam retries. The Windows-native
// Redis port (3.0.504) is incompatible — devs must use docker-compose
// (Redis 7) to exercise this suite locally.
async function redisCompatible(url: string): Promise<{ ok: boolean; reason?: string }> {
  const probe = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    lazyConnect: true,
  });
  try {
    await probe.connect();
    const pong = await probe.ping();
    if (pong !== 'PONG') return { ok: false, reason: 'ping not PONG' };
    const info = await probe.info('server');
    const match = /redis_version:(\d+)\./.exec(info);
    const major = match ? Number(match[1]) : 0;
    await probe.quit();
    if (major < 5) return { ok: false, reason: `Redis ${major}.x < 5.0 (BullMQ minimum)` };
    return { ok: true };
  } catch (err) {
    try {
      probe.disconnect();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: (err as Error).message };
  }
}

const compat = await redisCompatible(process.env.REDIS_URL);
const REDIS_OK = compat.ok;

const suite = REDIS_OK ? describe : describe.skip;

if (!REDIS_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    '[queue.test] skipping —',
    compat.reason,
    '(REDIS_URL=',
    process.env.REDIS_URL,
    ')',
  );
}

const { getQueue, startInlineWorker, closeQueue } = await import('../../src/lib/queue.js');

suite('queue — BullMQ inline worker', () => {
  beforeAll(async () => {
    // Drain any leftover jobs from prior runs so assertions are deterministic.
    const q = getQueue();
    await q.drain(true);
  });

  afterAll(async () => {
    await closeQueue();
  });

  it('processes a job: producer enqueues -> worker receives same payload', async () => {
    const received: Array<{ name: string; data: unknown }> = [];
    let resolveProcessed: (v: unknown) => void;
    const processed = new Promise((r) => {
      resolveProcessed = r;
    });

    startInlineWorker(async (job) => {
      received.push({ name: job.name, data: job.data });
      resolveProcessed(job.data);
      return { ok: true };
    });

    const q = getQueue();
    await q.add('probe', { hello: 'world', n: 42 });

    await processed;
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ name: 'probe', data: { hello: 'world', n: 42 } });
  }, 15_000);

  it('marks a job failed when the processor throws', async () => {
    // closeQueue + restart so we register a fresh failing processor.
    await closeQueue();

    let failedSignal: ((v: unknown) => void) | undefined;
    const failed = new Promise<{ id?: string; reason: string }>((resolve) => {
      failedSignal = resolve as (v: unknown) => void;
    });

    const worker = startInlineWorker(async () => {
      throw new Error('boom');
    });
    worker.on('failed', (job, err) => {
      failedSignal?.({ id: job?.id, reason: err.message });
    });

    const q = getQueue();
    await q.add('crash', { x: 1 }, { attempts: 1 });

    const result = await failed;
    expect(result.reason).toBe('boom');
  }, 15_000);

  it('closeQueue shuts down cleanly (idempotent)', async () => {
    // Already closed above; calling again must not throw.
    await closeQueue();
    await closeQueue();
    expect(true).toBe(true);
  });
});
