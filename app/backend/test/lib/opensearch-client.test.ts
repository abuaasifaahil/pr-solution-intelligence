/**
 * M9.1 + M9.1.2 — OpenSearch client + probe + search wrapper unit tests.
 *
 * Mocks `@opensearch-project/opensearch` so no network is touched. Verifies
 * lazy singleton behavior, the "not configured" error path, probe
 * happy/sad/unconfigured paths, and the prod-aligned `search()` wrapper
 * (retry/backoff/cache/preference/shard-parse-error/400 mapping).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track the Client constructor so we can assert singleton + auth wiring.
const clusterHealthMock = vi.fn();
const searchMock = vi.fn();
const clientCtorMock = vi.fn().mockImplementation(() => ({
  cluster: { health: clusterHealthMock },
  search: searchMock,
}));

vi.mock('@opensearch-project/opensearch', () => ({
  Client: clientCtorMock,
}));

const {
  getOpenSearchClient,
  probeOpenSearch,
  _resetOpenSearchClientForTests,
} = await import('../../src/lib/opensearch-client.js');

// Snapshot the OpenSearch-related env vars so we can mutate them per-test
// without leaking state. Other required env (DB/JWT/Azure) comes from .env.
const ORIG: Record<string, string | undefined> = {
  OPENSEARCH_URL: process.env.OPENSEARCH_URL,
  OPENSEARCH_USERNAME: process.env.OPENSEARCH_USERNAME,
  OPENSEARCH_PASSWORD: process.env.OPENSEARCH_PASSWORD,
  OPENSEARCH_RETRIES: process.env.OPENSEARCH_RETRIES,
  OPENSEARCH_RETRY_BACKOFF_FACTOR: process.env.OPENSEARCH_RETRY_BACKOFF_FACTOR,
  OPENSEARCH_REQUEST_TIMEOUT_MS: process.env.OPENSEARCH_REQUEST_TIMEOUT_MS,
  OPENSEARCH_REQUEST_CACHE: process.env.OPENSEARCH_REQUEST_CACHE,
  OPENSEARCH_PREFERENCE: process.env.OPENSEARCH_PREFERENCE,
};

function setConfig(): void {
  process.env.OPENSEARCH_URL = 'https://os.example.com';
  process.env.OPENSEARCH_USERNAME = 'admin';
  process.env.OPENSEARCH_PASSWORD = 'secret';
}

function clearConfig(): void {
  delete process.env.OPENSEARCH_URL;
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
}

// IMPORTANT: env.ts caches loadEnv() per-module. Vitest runs each test file
// in its own fork (isolate=true, pool='forks'), so the cache lives for the
// whole file. We avoid the cache by reloading env.ts via vi.resetModules
// before each test — and re-import the client after, so its `loadEnv` import
// binding points at the fresh module.
beforeEach(async () => {
  vi.resetModules();
  clientCtorMock.mockClear();
  clusterHealthMock.mockReset();
  searchMock.mockReset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  _resetOpenSearchClientForTests();
  vi.useRealTimers();
});

describe('getOpenSearchClient', () => {
  it('throws when OPENSEARCH_URL/username/password missing', async () => {
    clearConfig();
    const mod = await import('../../src/lib/opensearch-client.js');
    expect(() => mod.getOpenSearchClient()).toThrow(/not configured/i);
  });

  it('returns a Client when configured + caches it on second call', async () => {
    setConfig();
    const mod = await import('../../src/lib/opensearch-client.js');
    const a = mod.getOpenSearchClient();
    const b = mod.getOpenSearchClient();
    expect(a).toBe(b); // same cached reference
    // Constructor was invoked exactly once across both calls.
    expect(clientCtorMock).toHaveBeenCalledTimes(1);
    // Auth was forwarded.
    const arg = clientCtorMock.mock.calls[0]![0];
    expect(arg.node).toBe('https://os.example.com');
    expect(arg.auth).toEqual({ username: 'admin', password: 'secret' });
  });
});

describe('probeOpenSearch', () => {
  it('returns ok:false + friendly message when not configured', async () => {
    clearConfig();
    const mod = await import('../../src/lib/opensearch-client.js');
    const res = await mod.probeOpenSearch();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not configured/i);
    expect(res.latencyMs).toBe(0);
  });

  it('returns ok:true + latency + cluster details when health succeeds', async () => {
    setConfig();
    clusterHealthMock.mockResolvedValue({
      body: {
        cluster_name: 'amx-data',
        status: 'green',
        number_of_nodes: 3,
      },
    });
    const mod = await import('../../src/lib/opensearch-client.js');
    const res = await mod.probeOpenSearch();
    expect(res.ok).toBe(true);
    expect(res.clusterName).toBe('amx-data');
    expect(res.clusterStatus).toBe('green');
    expect(res.numberOfNodes).toBe(3);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.error).toBeUndefined();
  });

  it('returns ok:false with err.message when health throws', async () => {
    setConfig();
    clusterHealthMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:9200'));
    const mod = await import('../../src/lib/opensearch-client.js');
    const res = await mod.probeOpenSearch();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ECONNREFUSED 10.0.0.5:9200');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------- M9.1.2: search() wrapper ----------

function happyBody(hits: Array<{ _id: string; _source: Record<string, unknown> }> = []) {
  return {
    body: {
      hits: { hits, total: hits.length },
      _shards: { failed: 0 },
    },
  };
}

describe('search()', () => {
  it('returns a flattened SearchOutcome on success', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce(happyBody([{ _id: 'a', _source: { title: 't' } }]));
    const mod = await import('../../src/lib/opensearch-client.js');
    const out = await mod.search({
      indices: ['amx-data-*'],
      body: { query: { match_all: {} } },
    });
    expect(out.hits).toHaveLength(1);
    expect(out.totalHits).toBe(1);
    expect(out.retriesUsed).toBe(0);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes request_cache: true and preference: _replica_first to the client', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce(happyBody([]));
    const mod = await import('../../src/lib/opensearch-client.js');
    await mod.search({ indices: ['idx1', 'idx2'], body: { query: { match_all: {} } } });
    const [callArg] = searchMock.mock.calls[0]!;
    expect(callArg.request_cache).toBe(true);
    expect(callArg.preference).toBe('_replica_first');
    // indices are comma-joined for the client
    expect(callArg.index).toBe('idx1,idx2');
  });

  it('includes body-level timeout matching env (default 300s)', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce(happyBody([]));
    const mod = await import('../../src/lib/opensearch-client.js');
    await mod.search({ indices: ['x'], body: { query: { match_all: {} } } });
    const [callArg] = searchMock.mock.calls[0]!;
    expect(callArg.body.timeout).toBe('300s');
  });

  it('flattens both number and {value: number} total shapes', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce({
      body: {
        hits: { hits: [], total: { value: 42 } },
        _shards: { failed: 0 },
      },
    });
    const mod = await import('../../src/lib/opensearch-client.js');
    const out = await mod.search({ indices: ['x'], body: {} });
    expect(out.totalHits).toBe(42);
  });

  it('on 400 throws fixed friendly message synchronously, no retry', async () => {
    setConfig();
    const err: Error & { statusCode?: number } = Object.assign(new Error('bad query'), {
      statusCode: 400,
    });
    searchMock.mockRejectedValueOnce(err);
    const mod = await import('../../src/lib/opensearch-client.js');
    await expect(
      mod.search({ indices: ['x'], body: {} }),
    ).rejects.toThrow('Invalid OpenSearch query syntax or parameters.');
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('on non-retryable 500 throws the original error without retry', async () => {
    setConfig();
    const err: Error & { statusCode?: number } = Object.assign(new Error('boom'), {
      statusCode: 500,
    });
    searchMock.mockRejectedValueOnce(err);
    const mod = await import('../../src/lib/opensearch-client.js');
    await expect(mod.search({ indices: ['x'], body: {} })).rejects.toThrow('boom');
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 then succeeds (retriesUsed === 1)', async () => {
    setConfig();
    process.env.OPENSEARCH_RETRIES = '3';
    process.env.OPENSEARCH_RETRY_BACKOFF_FACTOR = '2';
    // Use fake timers to skip the real backoff sleep.
    vi.useFakeTimers();
    const err: Error & { statusCode?: number } = Object.assign(new Error('overloaded'), {
      statusCode: 503,
    });
    searchMock.mockRejectedValueOnce(err).mockResolvedValueOnce(happyBody([]));
    const mod = await import('../../src/lib/opensearch-client.js');
    const promise = mod.search({ indices: ['x'], body: {} });
    // Advance through the 1s backoff.
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out.retriesUsed).toBe(1);
    expect(searchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries then throws the last error', async () => {
    setConfig();
    process.env.OPENSEARCH_RETRIES = '3';
    process.env.OPENSEARCH_RETRY_BACKOFF_FACTOR = '2';
    vi.useFakeTimers();
    // Have each rejection produce a *fresh* Error so PromiseRejectionHandled
    // warnings don't pile up on a single shared instance (each retry's
    // rejected promise gets its own object and is awaited in turn).
    const mk503 = () =>
      Object.assign(new Error('overloaded'), { statusCode: 503 });
    searchMock
      .mockRejectedValueOnce(mk503())
      .mockRejectedValueOnce(mk503())
      .mockRejectedValueOnce(mk503());
    const mod = await import('../../src/lib/opensearch-client.js');
    // Attach the assertion before driving timers so vitest's expect chain
    // owns the rejection from the first microtask tick.
    const promise = mod.search({ indices: ['x'], body: {} });
    const assertion = expect(promise).rejects.toThrow('overloaded');
    // Total backoff for 3 retries: 1s + 2s = 3s (the last attempt doesn't sleep).
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(searchMock).toHaveBeenCalledTimes(3);
  });

  it('detects shard-level "parse query" failure and throws the syntax error', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce({
      body: {
        hits: { hits: [], total: 0 },
        _shards: {
          failed: 1,
          failures: [{ reason: { reason: 'Failed to parse query [foo:bar]' } }],
        },
      },
    });
    const mod = await import('../../src/lib/opensearch-client.js');
    await expect(
      mod.search({ indices: ['x'], body: {} }),
    ).rejects.toThrow('Invalid OpenSearch query syntax or parameters.');
    // No retry: shard-parse is treated as a 400-class error.
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores shard failures whose reason does not mention "parse query"', async () => {
    setConfig();
    searchMock.mockResolvedValueOnce({
      body: {
        hits: { hits: [], total: 0 },
        _shards: {
          failed: 1,
          failures: [{ reason: { reason: 'shard temporarily unavailable' } }],
        },
      },
    });
    const mod = await import('../../src/lib/opensearch-client.js');
    const out = await mod.search({ indices: ['x'], body: {} });
    expect(out.totalHits).toBe(0);
  });
});
