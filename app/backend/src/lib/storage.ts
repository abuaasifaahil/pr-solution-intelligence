import type { Readable } from 'node:stream';
import { loadEnv } from '../env.js';
import { createInMemoryAdapter } from './storage.inmemory.js';
import { createS3Adapter } from './storage.s3.js';

export type StorageMode = 'inmemory' | 's3';

export interface PutObjectResult {
  key: string;
  size: number;
}

export interface StoragePingResult {
  ok: boolean;
  mode: StorageMode;
  latencyMs: number;
}

/**
 * Storage adapter — uniform interface over the two backends used in Phase 2:
 *   - `inmemory`  : zero-persistence; free-tier prod baseline.
 *   - `s3`        : S3 wire-protocol — MinIO locally, AWS S3 in production.
 *
 * Migration to a real AWS bucket is a pure env-var flip (see
 * docs/storage-migration.md) — no code change.
 */
export interface StorageAdapter {
  /** Upload a file. `body` may be Buffer or Readable stream. */
  putObject(
    key: string,
    body: Buffer | Readable,
    opts?: { contentType?: string },
  ): Promise<PutObjectResult>;

  /** Read a file as a stream. Throws if the key does not exist. */
  getObject(key: string): Promise<Readable>;

  /** Delete an object. No-op if the key does not exist. */
  deleteObject(key: string): Promise<void>;

  /**
   * Generate a presigned PUT URL — used to allow browser-direct upload
   * without a backend pass-through. The inmemory adapter throws because
   * it has no externally-reachable endpoint to presign against.
   */
  getPresignedPutUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Lightweight health probe — used by /healthz. */
  ping(): Promise<StoragePingResult>;
}

let cached: StorageAdapter | undefined;

/**
 * Lazy singleton accessor. The adapter is selected once at first call from
 * env, then memoised for the life of the process. Tests reset via
 * `resetStorageForTests()`.
 */
export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const env = loadEnv();
  if (env.STORAGE_MODE === 's3') {
    cached = createS3Adapter({
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    });
  } else {
    cached = createInMemoryAdapter();
  }
  return cached;
}

/** Test-only — clears the cached adapter so a new env can be picked up. */
export function resetStorageForTests(): void {
  cached = undefined;
}
