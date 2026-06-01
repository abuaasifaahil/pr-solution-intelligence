/**
 * OpenSearch client factory + connection probe + prod-aligned search wrapper.
 *
 * Returns a singleton `@opensearch-project/opensearch` Client when config is
 * present; throws a clear error otherwise. DataExtractAgent's opensearch
 * path (M9.5) calls `getOpenSearchClient()`; M9.7's `/opensearch/probe`
 * endpoint calls `probeOpenSearch()`.
 *
 * The `search()` helper (M9.1.2) mirrors the AlphaMetricX production
 * retry/backoff/cache/preference behavior — see its docstring.
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

/**
 * Search options for the wrapped `search()` helper.
 *
 * `requestTimeoutMs` defaults to env.OPENSEARCH_REQUEST_TIMEOUT_MS (300_000 — 5
 * minutes — matches prod). The OpenSearch SDK's `requestTimeout` is the
 * per-request HTTP timeout; the body-level `timeout` parameter tells the
 * cluster how long it may spend executing the query before returning a
 * partial response. Prod sets both to 300s, so we do too.
 */
export interface SearchOptions {
  indices: string[];
  body: Record<string, unknown>;
  requestTimeoutMs?: number;
}

export interface SearchOutcome<TSource = Record<string, unknown>> {
  hits: Array<{ _id: string; _source: TSource; sort?: unknown[] }>;
  totalHits: number;
  retriesUsed: number;
  latencyMs: number;
  raw: unknown; // full response for callers that need _shards / aggregations
}

const RETRYABLE_STATUSES = new Set([429, 503, 504, 408]);

/**
 * Execute a search with prod-aligned retry, caching, and replica
 * preference. Returns a normalized `SearchOutcome` — callers shouldn't
 * need to touch the raw SDK shape.
 *
 * Failures:
 * - 400 → Error with message "Invalid OpenSearch query syntax or parameters."
 * - 429/503/504/408 → retried up to `OPENSEARCH_RETRIES` times with
 *   exponential backoff: `OPENSEARCH_RETRY_BACKOFF_FACTOR ** attempt` seconds
 * - Shard-level parse errors (response._shards.failed > 0 with "parse query"
 *   in the failure reason) → same as 400
 * - All other failures → rethrown as-is
 */
export async function search<TSource = Record<string, unknown>>(
  opts: SearchOptions,
): Promise<SearchOutcome<TSource>> {
  const env = loadEnv();
  const client = getOpenSearchClient();
  const start = Date.now();
  const retries = env.OPENSEARCH_RETRIES;
  const backoff = env.OPENSEARCH_RETRY_BACKOFF_FACTOR;
  const timeoutMs = opts.requestTimeoutMs ?? env.OPENSEARCH_REQUEST_TIMEOUT_MS;
  // Body-param timeout matches the request timeout (prod sets both to 300s).
  const bodyWithTimeout = {
    ...opts.body,
    timeout: `${Math.ceil(timeoutMs / 1000)}s`,
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await client.search(
        {
          index: opts.indices.join(','),
          body: bodyWithTimeout,
          request_cache: env.OPENSEARCH_REQUEST_CACHE,
          preference: env.OPENSEARCH_PREFERENCE,
        },
        { requestTimeout: timeoutMs },
      );
      assertNoShardParseError(res.body);
      const body = res.body as {
        hits: {
          hits: Array<{ _id: string; _source: TSource; sort?: unknown[] }>;
          total: number | { value: number };
        };
      };
      const totalHits =
        typeof body.hits.total === 'number' ? body.hits.total : body.hits.total.value;
      return {
        hits: body.hits.hits,
        totalHits,
        retriesUsed: attempt,
        latencyMs: Date.now() - start,
        raw: res.body,
      };
    } catch (err) {
      const status = extractStatus(err);
      if (status === 400) {
        throw new Error('Invalid OpenSearch query syntax or parameters.');
      }
      if (status !== undefined && !RETRYABLE_STATUSES.has(status)) {
        throw err;
      }
      // If err is an Error we threw ourselves (e.g. shard-parse), don't retry.
      if (
        err instanceof Error &&
        err.message === 'Invalid OpenSearch query syntax or parameters.'
      ) {
        throw err;
      }
      lastErr = err;
      if (attempt === retries - 1) break;
      const waitMs = backoff ** attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr ?? new Error('OpenSearch search failed after retries.');
}

/** Inspects response._shards.failed > 0 looking for "parse query" reasons. */
function assertNoShardParseError(body: unknown): void {
  const b = body as {
    _shards?: {
      failed?: number;
      failures?: Array<{ reason?: { reason?: string } | string }>;
    };
  };
  const failed = b._shards?.failed ?? 0;
  if (failed === 0) return;
  const failures = b._shards?.failures;
  if (!Array.isArray(failures) || failures.length === 0) return;
  const first = failures[0]?.reason;
  const text =
    typeof first === 'string'
      ? first
      : typeof first === 'object' && first !== null && 'reason' in first
        ? String((first as { reason?: string }).reason ?? '')
        : '';
  if (text.toLowerCase().includes('parse query')) {
    throw new Error('Invalid OpenSearch query syntax or parameters.');
  }
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { statusCode?: number; meta?: { statusCode?: number } };
    return e.statusCode ?? e.meta?.statusCode;
  }
  return undefined;
}

/** Test-only: clear the cached client so subsequent `getOpenSearchClient()` rebuilds. */
export function _resetOpenSearchClientForTests(): void {
  cachedClient = undefined;
}
