/**
 * M8.6 — SimilarWeb client unit tests.
 *
 * Pure-unit suite. Prisma/RLS replaced with in-memory mocks; global `fetch`
 * is stubbed per-test. Covers:
 *   - getSimilarWebKey: M5 data_sources lookup, env fallback, null path
 *   - fetchSimilarWeb: 200 happy path, 404 → nulls, 5xx throws
 *   - fetchSimilarWebBatch: concurrency cap + failure isolation
 *   - normalize (exercised indirectly): null fields, log-scale scoring
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt } from '../../src/lib/encryption.js';

// Set ENCRYPTION_KEY before encryption.ts caches the key. The same value is
// used everywhere else in the suite so encrypt/decrypt round-trips work.
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ───────────────────────────────────────────────────────────────────────
// Mocks
// ───────────────────────────────────────────────────────────────────────
interface DataSourceRow {
  userId: string;
  sourceType: string;
  displayName: string;
  apiKeyEncrypted: string;
}

const dataSourceStore: DataSourceRow[] = [];

const mockDataSource = {
  findFirst: vi.fn(
    async ({
      where,
    }: {
      where: {
        sourceType: string;
        displayName: { contains: string; mode: string };
      };
    }) => {
      return (
        dataSourceStore.find(
          (r) =>
            r.sourceType === where.sourceType &&
            r.displayName
              .toLowerCase()
              .includes(where.displayName.contains.toLowerCase()),
        ) ?? null
      );
    },
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { dataSource: mockDataSource, $disconnect: vi.fn() },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ dataSource: mockDataSource }),
  ),
  asAdmin: vi.fn(),
}));

const {
  fetchSimilarWeb,
  fetchSimilarWebBatch,
  getSimilarWebKey,
} = await import('../../src/lib/similarweb-client.js');

const USER = '00000000-0000-0000-0000-00000000aaaa';

beforeEach(() => {
  dataSourceStore.length = 0;
  mockDataSource.findFirst.mockClear();
  delete process.env.SIMILARWEB_API_KEY;
  // Reset global fetch between tests; specific tests install their own stub.
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────
// getSimilarWebKey
// ───────────────────────────────────────────────────────────────────────
describe('getSimilarWebKey', () => {
  it("finds the user's M5 data_sources row (case-insensitive displayName)", async () => {
    dataSourceStore.push({
      userId: USER,
      sourceType: 'custom',
      displayName: 'My SimilarWeb config',
      apiKeyEncrypted: encrypt('sw-real-key-42'),
    });
    const key = await getSimilarWebKey(USER);
    expect(key).toBe('sw-real-key-42');
    expect(mockDataSource.findFirst).toHaveBeenCalledTimes(1);
  });

  it('falls back to SIMILARWEB_API_KEY env when no data_sources row exists', async () => {
    process.env.SIMILARWEB_API_KEY = 'env-fallback-key';
    const key = await getSimilarWebKey(USER);
    expect(key).toBe('env-fallback-key');
  });

  it('falls back to env when stored ciphertext is malformed (decrypt throws)', async () => {
    dataSourceStore.push({
      userId: USER,
      sourceType: 'custom',
      displayName: 'SimilarWeb',
      apiKeyEncrypted: 'not:a:valid:ciphertext:at:all',
    });
    process.env.SIMILARWEB_API_KEY = 'env-after-decrypt-fail';
    const key = await getSimilarWebKey(USER);
    expect(key).toBe('env-after-decrypt-fail');
  });

  it('returns null when neither data_sources nor env supply a key', async () => {
    const key = await getSimilarWebKey(USER);
    expect(key).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// fetchSimilarWeb — single domain
// ───────────────────────────────────────────────────────────────────────
describe('fetchSimilarWeb', () => {
  it('normalizes a 200 response into the reach_cache shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          visits: 2_500_000,
          global_rank: 432,
          category: 'News and Media',
        }),
      })),
    );
    const r = await fetchSimilarWeb('nytimes.com', 'fake-key');
    expect(r.domain).toBe('nytimes.com');
    expect(r.monthly_visitors).toBe(2_500_000);
    expect(r.global_rank).toBe(432);
    expect(r.category).toBe('News and Media');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('returns null fields when SimilarWeb omits visits/rank', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    );
    const r = await fetchSimilarWeb('mystery.example', 'fake-key');
    expect(r.monthly_visitors).toBeNull();
    expect(r.global_rank).toBeNull();
    expect(r.category).toBeNull();
    expect(r.score).toBeNull();
  });

  it('computes a sane score across the log-scale anchor points', async () => {
    // 1M visitors → log10 = 6.0 → score = (6.0 - 2) * 12.5 = 50
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ visits: 1_000_000 }),
      })),
    );
    const r1 = await fetchSimilarWeb('mid.example', 'fake-key');
    expect(r1.score).toBe(50);

    // 100M visitors → log10 = 8.0 → score = (8.0 - 2) * 12.5 = 75
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ visits: 100_000_000 }),
      })),
    );
    const r2 = await fetchSimilarWeb('big.example', 'fake-key');
    expect(r2.score).toBe(75);
  });

  it('treats 404 as "no data" — returns nulls without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const r = await fetchSimilarWeb('dead.example', 'fake-key');
    expect(r.domain).toBe('dead.example');
    expect(r.monthly_visitors).toBeNull();
    expect(r.score).toBeNull();
  });

  it('throws on non-404 errors (e.g. 500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(fetchSimilarWeb('broken.example', 'k')).rejects.toThrow(
      /SimilarWeb 500/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// fetchSimilarWebBatch — concurrency + failure isolation
// ───────────────────────────────────────────────────────────────────────
describe('fetchSimilarWebBatch', () => {
  it('returns one result per domain (happy path)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          visits: url.includes('big') ? 50_000_000 : 1_000,
          global_rank: 1,
        }),
      })),
    );
    const out = await fetchSimilarWebBatch(
      ['big.example', 'small.example'],
      'fake-key',
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.domain).toBe('big.example');
    expect(out[0]!.monthly_visitors).toBe(50_000_000);
    expect(out[1]!.domain).toBe('small.example');
    expect(out[1]!.monthly_visitors).toBe(1_000);
  });

  it('respects the concurrency cap (no more than N fetches in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { ok: true, status: 200, json: async () => ({ visits: 1 }) };
      }),
    );
    const domains = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'];
    await fetchSimilarWebBatch(domains, 'k', 2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("a single failure doesn't poison the successes", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('boom')) {
          throw new Error('network down');
        }
        return { ok: true, status: 200, json: async () => ({ visits: 100 }) };
      }),
    );
    const out = await fetchSimilarWebBatch(
      ['ok.example', 'boom.example', 'fine.example'],
      'k',
      3,
    );
    expect(out).toHaveLength(3);
    const boomRow = out.find((r) => r.domain === 'boom.example');
    expect(boomRow).toBeDefined();
    expect(boomRow!.monthly_visitors).toBeNull();
    expect(boomRow!.score).toBeNull();
    // Successes still resolved.
    expect(out.find((r) => r.domain === 'ok.example')!.monthly_visitors).toBe(
      100,
    );
    expect(out.find((r) => r.domain === 'fine.example')!.monthly_visitors).toBe(
      100,
    );
  });
});
