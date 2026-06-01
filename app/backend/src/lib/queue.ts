import { Queue, Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * BullMQ infrastructure — runs INLINE inside the Fastify process. No
 * separate Render Background Worker, no extra $7/mo dyno. The single
 * `phase2-jobs` queue carries every Phase 2 job; the dispatcher in
 * `server.ts` routes each job to its registered processor by name.
 *
 * BullMQ requires its own ioredis connection (cannot multiplex with the
 * shared pub/sub client from `lib/redis.ts`), so we open new ones here.
 */

const QUEUE_NAME = 'phase2-jobs';

let queueCache: Queue | undefined;
let workerCache: Worker | undefined;
let queueConnection: Redis | undefined;
let workerConnection: Redis | undefined;

function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('queue: REDIS_URL is not set');
  }
  return url;
}

function newRedisConnection(): Redis {
  // BullMQ requires maxRetriesPerRequest=null on the connection used for
  // blocking commands (Worker). Same option on the Queue side is harmless.
  return new Redis(getRedisUrl(), { maxRetriesPerRequest: null });
}

/** Lazy singleton queue accessor used by producers (route handlers). */
export function getQueue(): Queue {
  if (!queueCache) {
    queueConnection = newRedisConnection();
    queueCache = new Queue(QUEUE_NAME, { connection: queueConnection });
  }
  return queueCache;
}

/**
 * Boot the inline worker. Idempotent — repeat calls return the same Worker.
 * The processor is typically a dispatcher that looks up the per-job-name
 * handler in a registry (see server.ts).
 */
export function startInlineWorker(processor: Processor): Worker {
  if (workerCache) return workerCache;
  workerConnection = newRedisConnection();
  workerCache = new Worker(QUEUE_NAME, processor, {
    connection: workerConnection,
    concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 2),
  });
  workerCache.on('failed', (job: Job | undefined, err: Error) => {
    // eslint-disable-next-line no-console
    console.error('[queue] job failed', {
      id: job?.id,
      name: job?.name,
      err: err.message,
    });
  });
  return workerCache;
}

/** Graceful shutdown — used by tests and the SIGTERM handler. */
export async function closeQueue(): Promise<void> {
  if (workerCache) {
    await workerCache.close();
    workerCache = undefined;
  }
  if (queueCache) {
    await queueCache.close();
    queueCache = undefined;
  }
  if (workerConnection) {
    await workerConnection.quit().catch(() => {});
    workerConnection = undefined;
  }
  if (queueConnection) {
    await queueConnection.quit().catch(() => {});
    queueConnection = undefined;
  }
}

export const QUEUE_NAME_PHASE2 = QUEUE_NAME;
