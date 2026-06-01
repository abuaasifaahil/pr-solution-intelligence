/**
 * M9.9 — opensearch.routes.test.ts
 *
 * Smoke tests for POST /api/v1/opensearch/probe. We mock the
 * `@opensearch-project/opensearch` Client so the test never makes a
 * real HTTPS call — the unit tests live here; integration is a manual
 * step against the real cluster (documented in PR description).
 *
 * @file backend/test/routes/opensearch.routes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ─── Mocked OpenSearch Client ────────────────────────────────────────────
// The route imports `Client` directly from the SDK; we replace the module
// before `buildServer` is imported. The mock's behavior is controlled per
// test via `clusterHealthImpl`.

let clusterHealthImpl: () => Promise<unknown> = async () => ({
  body: {
    cluster_name: 'mock-cluster',
    status: 'green',
    number_of_nodes: 3,
  },
});

vi.mock('@opensearch-project/opensearch', () => {
  return {
    Client: class MockClient {
      cluster = {
        health: async (_args: unknown) => clusterHealthImpl(),
      };
    },
  };
});

// ─── Stub out the rest of the server's runtime deps ──────────────────────
// We don't want the test server to try to talk to a real DB / Redis / etc.
vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(
    async (_uid: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  ),
  asAdmin: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const token = signAccess({
  userId: 'user-a',
  email: 'a@test.local',
  role: 'analyst',
  sessionId: 's',
});

describe('POST /api/v1/opensearch/probe', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    // Reset to the green-cluster impl each test.
    clusterHealthImpl = async () => ({
      body: {
        cluster_name: 'mock-cluster',
        status: 'green',
        number_of_nodes: 3,
      },
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      payload: { url: 'https://os.example.com', username: 'u', password: 'p' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns ok:true + cluster metadata on a successful health call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        url: 'https://os.example.com',
        username: 'admin-uat',
        password: 'secret',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.clusterName).toBe('mock-cluster');
    expect(body.data.clusterStatus).toBe('green');
    expect(body.data.numberOfNodes).toBe(3);
    expect(typeof body.data.latencyMs).toBe('number');
  });

  it('returns ok:false + error message when the health call throws', async () => {
    clusterHealthImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        url: 'https://os.example.com',
        username: 'u',
        password: 'p',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toBe('ECONNREFUSED');
  });

  it('400s when the body is missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://os.example.com' /* missing user + pass */ },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('400s when the URL is not a URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'not-a-url', username: 'u', password: 'p' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an optional indexName field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opensearch/probe',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        url: 'https://os.example.com',
        username: 'u',
        password: 'p',
        indexName: 'amx-data-*',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
  });
});
