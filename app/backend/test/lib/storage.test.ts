import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ----------------------------------------------------------------------------
// Mock @aws-sdk/client-s3 and the presigner. We exercise the adapter's surface
// (PutObject / GetObject / DeleteObject / HeadBucket / presigned URL) without
// touching network. M7.3 will add a live-MinIO integration test for the
// real wire path.
// ----------------------------------------------------------------------------

interface FakeStore {
  bucket: Map<string, Buffer>;
}

const fake: FakeStore = { bucket: new Map() };
const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    constructor(public readonly cfg: unknown) {}
    async send(cmd: { __cmd: string; input: Record<string, unknown> }) {
      return sendMock(cmd);
    }
  }
  const makeCmd = (name: string) =>
    class {
      __cmd = name;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: makeCmd('Put'),
    GetObjectCommand: makeCmd('Get'),
    DeleteObjectCommand: makeCmd('Delete'),
    HeadBucketCommand: makeCmd('Head'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (_client: unknown, cmd: { input: { Bucket: string; Key: string } }, opts: { expiresIn: number }) =>
      `https://signed.example/${cmd.input.Bucket}/${cmd.input.Key}?exp=${opts.expiresIn}`,
  ),
}));

// Default send() implementation routes commands to the fake bucket map.
function installDefaultSend(): void {
  sendMock.mockImplementation(async (cmd: { __cmd: string; input: Record<string, unknown> }) => {
    const { __cmd: name, input } = cmd;
    const key = String(input.Key ?? '');
    if (name === 'Put') {
      const body = input.Body;
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      fake.bucket.set(key, buf);
      return {};
    }
    if (name === 'Get') {
      const buf = fake.bucket.get(key);
      if (!buf) throw new Error('NoSuchKey');
      return { Body: Readable.from(buf) };
    }
    if (name === 'Delete') {
      fake.bucket.delete(key);
      return {};
    }
    if (name === 'Head') {
      return {};
    }
    throw new Error(`unknown fake command: ${name}`);
  });
}

const { createInMemoryAdapter } = await import('../../src/lib/storage.inmemory.js');
const { createS3Adapter } = await import('../../src/lib/storage.s3.js');

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ----------------------------------------------------------------------------
// Shared scenarios run against both adapters.
// ----------------------------------------------------------------------------

const adapters = [
  {
    name: 'inmemory',
    make: () => createInMemoryAdapter(),
    presignedSupported: false,
  },
  {
    name: 's3',
    make: () =>
      createS3Adapter({
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        bucket: 'prsi-uploads',
        accessKeyId: 'prsi',
        secretAccessKey: 'prsi_dev_minio',
        forcePathStyle: true,
      }),
    presignedSupported: true,
  },
] as const;

for (const adapter of adapters) {
  describe(`storage adapter — ${adapter.name}`, () => {
    beforeEach(() => {
      fake.bucket.clear();
      sendMock.mockReset();
      installDefaultSend();
    });

    it('putObject + getObject round-trip the same bytes', async () => {
      const a = adapter.make();
      const payload = Buffer.from('hello, world');
      const res = await a.putObject('docs/hello.txt', payload, { contentType: 'text/plain' });
      expect(res.key).toBe('docs/hello.txt');
      expect(res.size).toBe(payload.byteLength);

      const stream = await a.getObject('docs/hello.txt');
      const out = await readAll(stream);
      expect(out.toString('utf8')).toBe('hello, world');
    });

    it('deleteObject makes the key unfetchable', async () => {
      const a = adapter.make();
      await a.putObject('k', Buffer.from('x'));
      await a.deleteObject('k');
      await expect(a.getObject('k')).rejects.toThrow();
    });

    it('ping returns ok with the expected mode', async () => {
      const a = adapter.make();
      const res = await a.ping();
      expect(res.ok).toBe(true);
      expect(res.mode).toBe(adapter.name);
      expect(typeof res.latencyMs).toBe('number');
    });

    if (adapter.presignedSupported) {
      it('getPresignedPutUrl returns a signed URL', async () => {
        const a = adapter.make();
        const url = await a.getPresignedPutUrl('uploads/foo.bin', 60);
        expect(url).toContain('prsi-uploads');
        expect(url).toContain('uploads/foo.bin');
        expect(url).toContain('exp=60');
      });
    } else {
      it('getPresignedPutUrl throws a clear error directing to STORAGE_MODE=s3', async () => {
        const a = adapter.make();
        await expect(a.getPresignedPutUrl('k', 60)).rejects.toThrow(/STORAGE_MODE=s3/);
      });
    }
  });
}

describe('storage.inmemory — stream upload', () => {
  it('accepts a Readable stream body and buffers it', async () => {
    const a = createInMemoryAdapter();
    const stream = Readable.from([Buffer.from('part1-'), Buffer.from('part2')]);
    const res = await a.putObject('chunked', stream);
    expect(res.size).toBe('part1-part2'.length);
    const out = await readAll(await a.getObject('chunked'));
    expect(out.toString('utf8')).toBe('part1-part2');
  });
});
