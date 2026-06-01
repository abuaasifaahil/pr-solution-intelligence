import { Readable } from 'node:stream';
import type {
  PutObjectResult,
  StorageAdapter,
  StoragePingResult,
} from './storage.js';

/**
 * In-memory storage adapter — used when STORAGE_MODE=inmemory.
 *
 * Backing store is a plain `Map<key, Buffer>` in process memory. Bytes are
 * dropped on process restart; intended for the free-tier prod baseline
 * (stream-parse + discard) and as a zero-dep test default.
 *
 * Presigned URLs are unsupported — there is no externally-reachable endpoint
 * to sign against. Calling that method throws a clear message pointing the
 * caller at STORAGE_MODE=s3.
 */
class InMemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, Buffer>();

  async putObject(
    key: string,
    body: Buffer | Readable,
    _opts?: { contentType?: string },
  ): Promise<PutObjectResult> {
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    this.store.set(key, buf);
    return { key, size: buf.byteLength };
  }

  async getObject(key: string): Promise<Readable> {
    const buf = this.store.get(key);
    if (!buf) {
      throw new Error(`storage.inmemory: key not found: ${key}`);
    }
    return Readable.from(buf);
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getPresignedPutUrl(_key: string, _ttlSeconds: number): Promise<string> {
    throw new Error(
      'storage.inmemory: presigned URLs are not supported — set STORAGE_MODE=s3 (with MinIO locally or AWS S3 in prod) to enable browser-direct uploads.',
    );
  }

  async ping(): Promise<StoragePingResult> {
    const t0 = Date.now();
    // Sanity round-trip — write + read + delete a probe key.
    const probe = `__ping__:${t0}`;
    this.store.set(probe, Buffer.alloc(0));
    const ok = this.store.has(probe);
    this.store.delete(probe);
    return { ok, mode: 'inmemory', latencyMs: Date.now() - t0 };
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createInMemoryAdapter(): StorageAdapter {
  return new InMemoryStorageAdapter();
}
