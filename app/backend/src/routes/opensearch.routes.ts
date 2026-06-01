/**
 * M9.9 (Phase 3.5) — OpenSearch connection probe endpoint.
 *
 *   POST /api/v1/opensearch/probe
 *
 * Tests an arbitrary (url, username, password, indexName?) tuple by
 * issuing a single `cluster.health()` call against a freshly-built
 * one-shot Client. Used by the Settings → Data Sources → OpenSearch
 * override panel to verify creds BEFORE persisting them.
 *
 * Design notes:
 *  - **One-shot client.** This route does NOT use
 *    `getOpenSearchClientForConfig()` (the LRU cache) — a "Test
 *    connection" click should never silently reuse a previously-cached
 *    client (which would mask a creds change the user is testing).
 *  - **Never throws.** Connection failures return `{ok: false, error}`
 *    so the UI can surface the message without try/catch.
 *  - **Authenticated.** Requires a logged-in user — we don't expose an
 *    anonymous endpoint that lets the world probe arbitrary URLs.
 *  - **Password is never logged.** The request body is consumed locally
 *    and discarded; no log line includes it.
 *
 * Wire shape:
 *   Request:  { url: string, username: string, password: string, indexName?: string }
 *   Response: { ok: boolean, latencyMs: number,
 *               clusterName?, clusterStatus?, numberOfNodes?, error? }
 *
 * @file backend/src/routes/opensearch.routes.ts
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Client } from '@opensearch-project/opensearch';
import { loadEnv } from '../env.js';

const ProbeBodySchema = z.object({
  url: z.string().url().max(500),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(2000),
  indexName: z.string().min(1).max(200).optional(),
});

export interface OpenSearchProbeResult {
  ok: boolean;
  latencyMs: number;
  clusterName?: string;
  clusterStatus?: 'green' | 'yellow' | 'red' | string;
  numberOfNodes?: number;
  error?: string;
}

async function probeWithConfig(
  body: z.infer<typeof ProbeBodySchema>,
): Promise<OpenSearchProbeResult> {
  const env = loadEnv();
  const t0 = Date.now();
  // One-shot client. Not cached. Garbage-collected after this function
  // returns. Keeps the test-connection path isolated from the LRU
  // cache used by real searches.
  const client = new Client({
    node: body.url,
    auth: { username: body.username, password: body.password },
    requestTimeout: env.OPENSEARCH_TIMEOUT_MS,
    ssl: { rejectUnauthorized: true },
  });
  try {
    const health = await client.cluster.health({});
    const h = health.body as {
      cluster_name?: string;
      status?: string;
      number_of_nodes?: number;
    };
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      clusterName: h.cluster_name,
      clusterStatus: h.status,
      numberOfNodes: h.number_of_nodes,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      // The OpenSearch SDK error messages can occasionally surface URL
      // fragments but NOT the password — `auth` is set as a SDK option,
      // not appended to the URL. Still, keep the message surface tight.
      error: (err as Error).message,
    };
  }
}

export async function openSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/opensearch/probe', { preHandler: app.auth }, async (req, reply) => {
    const parsed = ProbeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        success: false,
        error: 'Invalid body',
        meta: parsed.error.flatten(),
      };
    }
    const result = await probeWithConfig(parsed.data);
    // Probe always returns 200 — failure goes in the body. Keeps the
    // UI's "Test connection" affordance simple (it just reads `ok`).
    return { success: true, data: result };
  });
}
