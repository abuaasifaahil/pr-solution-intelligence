/**
 * OpenSearch client factory + connection probe — M9.1.
 *
 * Returns a singleton `@opensearch-project/opensearch` Client when config is
 * present; throws a clear error otherwise. DataExtractAgent's opensearch
 * path (M9.5) calls `getOpenSearchClient()`; M9.7's `/opensearch/probe`
 * endpoint calls `probeOpenSearch()`.
 *
 * Boot posture: this module is import-safe even when OpenSearch isn't
 * configured. The Client is only constructed lazily on first `get` call.
 *
 * @file lib/opensearch-client.ts
 */
import { Client } from '@opensearch-project/opensearch';
import { loadEnv, hasOpenSearchConfig } from '../env.js';

let cachedClient: Client | undefined;

/**
 * Returns the cached OpenSearch client, constructing it on first call.
 * Throws when URL/username/password aren't all set — call
 * `hasOpenSearchConfig()` first if you need to branch.
 */
export function getOpenSearchClient(): Client {
  if (cachedClient) return cachedClient;
  const env = loadEnv();
  if (!hasOpenSearchConfig(env)) {
    throw new Error(
      'OpenSearch is not configured. Set OPENSEARCH_URL, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD env vars.',
    );
  }
  cachedClient = new Client({
    node: env.OPENSEARCH_URL!,
    auth: {
      username: env.OPENSEARCH_USERNAME!,
      password: env.OPENSEARCH_PASSWORD!,
    },
    requestTimeout: env.OPENSEARCH_TIMEOUT_MS,
    ssl: {
      // AWS managed OpenSearch is HTTPS with a valid cert chain.
      rejectUnauthorized: true,
    },
  });
  return cachedClient;
}

/** Result of a `probeOpenSearch()` call. Never throws — failure goes in `error`. */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  clusterName?: string;
  clusterStatus?: 'green' | 'yellow' | 'red' | string;
  numberOfNodes?: number;
  error?: string;
}

/**
 * Lightweight connection probe. Calls `cluster.health()` against the
 * configured node, times the round-trip, and reports back. Never throws
 * on connection failure — returns `{ok: false, error}` so callers can
 * surface the message to the user without try/catch.
 */
export async function probeOpenSearch(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    if (!hasOpenSearchConfig()) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'OpenSearch is not configured (URL/username/password missing)',
      };
    }
    const client = getOpenSearchClient();
    const health = await client.cluster.health({});
    const body = health.body as {
      cluster_name?: string;
      status?: string;
      number_of_nodes?: number;
    };
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      clusterName: body.cluster_name,
      clusterStatus: body.status,
      numberOfNodes: body.number_of_nodes,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

/** Test-only: clear the cached client so subsequent `getOpenSearchClient()` rebuilds. */
export function _resetOpenSearchClientForTests(): void {
  cachedClient = undefined;
}
