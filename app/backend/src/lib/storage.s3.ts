import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  PutObjectResult,
  StorageAdapter,
  StoragePingResult,
} from './storage.js';

export interface S3AdapterOptions {
  /** Custom S3 endpoint — set for MinIO ('http://localhost:9000'); omit for AWS S3. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** MinIO requires path-style; AWS S3 prefers virtual-host (false). */
  forcePathStyle: boolean;
}

/**
 * S3-compatible storage adapter. Single implementation services both
 *   - MinIO (local dev, `forcePathStyle=true`, custom endpoint)
 *   - AWS S3 (prod, `forcePathStyle=false`, no endpoint override)
 *
 * Migration from MinIO -> AWS S3 is env-var only. See docs/storage-migration.md.
 */
class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3AdapterOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined, // fall through to AWS default chain (IAM role, env, etc.)
    });
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    opts?: { contentType?: string },
  ): Promise<PutObjectResult> {
    // The S3 SDK needs to know the content length when body is a stream; the
    // simplest robust path is to buffer up-front. Phase 2 uploads are bounded
    // (limit enforced at the route layer); for very large objects we'd switch
    // to `@aws-sdk/lib-storage`'s multipart Upload.
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buf,
        ContentType: opts?.contentType,
        ContentLength: buf.byteLength,
      }),
    );
    return { key, size: buf.byteLength };
  }

  async getObject(key: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = res.Body;
    if (!body) {
      throw new Error(`storage.s3: empty body for key: ${key}`);
    }
    // SDK v3 returns a Node Readable in Node runtimes.
    return body as Readable;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getPresignedPutUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async ping(): Promise<StoragePingResult> {
    const t0 = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, mode: 's3', latencyMs: Date.now() - t0 };
    } catch {
      return { ok: false, mode: 's3', latencyMs: Date.now() - t0 };
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createS3Adapter(opts: S3AdapterOptions): StorageAdapter {
  return new S3StorageAdapter(opts);
}
