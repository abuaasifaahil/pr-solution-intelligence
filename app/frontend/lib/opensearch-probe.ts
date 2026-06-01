'use client';
import { apiFetch } from './api-client';

/**
 * M9.9 (Phase 3.5) — Frontend client for the OpenSearch test-connection
 * endpoint shipped by `backend/src/routes/opensearch.routes.ts`.
 *
 *   POST /api/v1/opensearch/probe   — probe an arbitrary cluster
 *
 * The endpoint expects the candidate connection config in the body and
 * returns a `ProbeResult` shape. Failure surfaces as `ok=false` (the
 * route never returns 5xx on a connection failure — it captures the
 * error and forwards the message), so the UI can branch on `ok`
 * without try/catch.
 *
 * Used by the Settings → Data Sources → OpenSearch override panel
 * (M9.9). The form values are sent verbatim — password lives in the
 * request body for one round-trip and is never persisted by this
 * client.
 *
 * @file lib/opensearch-probe.ts
 */

export interface OpenSearchProbeInput {
  url: string;
  username: string;
  password: string;
  indexName?: string;
}

export interface OpenSearchProbeResult {
  ok: boolean;
  latencyMs: number;
  clusterName?: string;
  clusterStatus?: 'green' | 'yellow' | 'red' | string;
  numberOfNodes?: number;
  error?: string;
}

/**
 * Send a `{url, username, password, indexName?}` tuple to the backend
 * and resolve with the probe outcome. Returns the result whether the
 * cluster is reachable or not — only network / 4xx surface as throws.
 */
export async function probeOpenSearchConnection(
  input: OpenSearchProbeInput,
): Promise<OpenSearchProbeResult> {
  return apiFetch<OpenSearchProbeResult>('/api/v1/opensearch/probe', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
