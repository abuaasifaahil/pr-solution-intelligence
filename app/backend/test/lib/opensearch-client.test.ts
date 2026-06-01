/**
 * M9.1 — OpenSearch client + probe unit tests.
 *
 * Mocks `@opensearch-project/opensearch` so no network is touched. Verifies
 * lazy singleton behavior, the "not configured" error path, and probe
 * happy/sad/unconfigured paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track the Client constructor so we can assert singleton + auth wiring.
const clusterHealthMock = vi.fn();
const clientCtorMock = vi.fn().mockImplementation(() => ({
  cluster: { health: clusterHealthMock },
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
});

afterEach(() => {
  process.env.OPENSEARCH_URL = ORIG.OPENSEARCH_URL;
  process.env.OPENSEARCH_USERNAME = ORIG.OPENSEARCH_USERNAME;
  process.env.OPENSEARCH_PASSWORD = ORIG.OPENSEARCH_PASSWORD;
  _resetOpenSearchClientForTests();
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
