/**
 * M9.7 — composable-skill routes integration test.
 *
 * In-memory store simulates the RLS visibility model:
 *   - first_party rows: visible to everyone, only writable by seed
 *   - user_private rows: visible/writable only to the owner
 *   - community rows (enabled=true): visible to everyone, not writable here
 *
 * Mock simulates RLS by gating reads/writes on the current userIdCtx.
 *
 * @file backend/test/routes/composable-skill.routes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

interface ComposableSkillRow {
  id: string;
  userId: string | null;
  name: string;
  version: string;
  kind: string;
  scope: 'first_party' | 'workspace' | 'user_private' | 'community';
  enabled: boolean;
  manifest: unknown;
}

const store: ComposableSkillRow[] = [];
let userIdCtx = '';

/** Visibility rule mirroring the M9.6c RLS policies. */
function isVisible(row: ComposableSkillRow, uid: string): boolean {
  if (row.scope === 'first_party') return true;
  if (row.scope === 'community' && row.enabled) return true;
  if (row.scope === 'user_private' && row.userId === uid) return true;
  return false;
}

/** Write rule — first_party / community / workspace not writable; only own user_private. */
function isWritable(row: ComposableSkillRow, uid: string): boolean {
  return row.scope === 'user_private' && row.userId === uid;
}

const composableSkillMock = {
  findMany: vi.fn(async ({ where }: { where: { kind?: string; scope?: string; enabled?: boolean } } = {} as any) => {
    let out = store.filter((r) => isVisible(r, userIdCtx));
    if (where?.kind) out = out.filter((r) => r.kind === where.kind);
    if (where?.scope) out = out.filter((r) => r.scope === where.scope);
    if (where?.enabled !== undefined) out = out.filter((r) => r.enabled === where.enabled);
    return out;
  }),
  findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
    const r = store.find((x) => x.id === where.id);
    if (!r) return null;
    return isVisible(r, userIdCtx) ? r : null;
  }),
  create: vi.fn(async ({ data }: { data: Partial<ComposableSkillRow> }) => {
    const row: ComposableSkillRow = {
      id: randomUUID(),
      userId: data.userId ?? null,
      name: data.name!,
      version: data.version ?? '1.0.0',
      kind: data.kind!,
      scope: (data.scope ?? 'user_private') as ComposableSkillRow['scope'],
      enabled: true,
      manifest: data.manifest,
    };
    store.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ComposableSkillRow> }) => {
    const r = store.find((x) => x.id === where.id);
    if (!r || !isWritable(r, userIdCtx)) {
      const err = Object.assign(new Error('Record not found'), { code: 'P2025' });
      throw err;
    }
    Object.assign(r, data);
    return { ...r };
  }),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const i = store.findIndex((x) => x.id === where.id);
    if (i < 0 || !isWritable(store[i]!, userIdCtx)) {
      const err = Object.assign(new Error('Record not found'), { code: 'P2025' });
      throw err;
    }
    const [removed] = store.splice(i, 1);
    return removed!;
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    composableSkill: composableSkillMock,
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ composableSkill: composableSkillMock });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

vi.mock('../../src/lib/storage.js', () => ({
  getStorage: () => ({
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    ping: vi.fn(),
  }),
  resetStorageForTests: vi.fn(),
}));

vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => ({ add: vi.fn() }),
  startInlineWorker: vi.fn(),
  closeQueue: vi.fn(),
  QUEUE_NAME_PHASE2: 'phase2-jobs',
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const userA = '00000000-0000-0000-0000-00000000aaaa';
const userB = '00000000-0000-0000-0000-00000000bbbb';
const tokenA = signAccess({ userId: userA, email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: userB, email: 'b@test.local', role: 'analyst', sessionId: 's' });

function seedDefaults(): void {
  store.length = 0;
  // One first-party row visible to everyone.
  store.push({
    id: 'fp-1',
    userId: null,
    name: 'sentiment-tagger',
    version: '1.0.0',
    kind: 'analysis_skill',
    scope: 'first_party',
    enabled: true,
    manifest: {},
  });
  // One user_private owned by Alice.
  store.push({
    id: 'priv-a',
    userId: userA,
    name: 'alice-private',
    version: '0.1.0',
    kind: 'enrichment_skill',
    scope: 'user_private',
    enabled: true,
    manifest: {},
  });
}

describe('Composable-skill routes (M9.7)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seedDefaults();
  });

  // ─── GET /composable-skills ───────────────────────────────────────
  it('GET — 200 with first-party + own user_private', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    const names = body.data.map((r: { name: string }) => r.name);
    expect(names).toContain('sentiment-tagger');
    expect(names).toContain('alice-private');
  });

  it('GET — Bob only sees first-party (Alice\'s private is hidden)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('sentiment-tagger');
  });

  it('GET ?scope=first_party — filters to first_party only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/composable-skills?scope=first_party',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.every((r: { scope: string }) => r.scope === 'first_party')).toBe(true);
  });

  it('GET ?kind=analysis_skill — filters by kind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/composable-skills?kind=analysis_skill',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.every((r: { kind: string }) => r.kind === 'analysis_skill')).toBe(true);
  });

  // ─── POST /composable-skills ──────────────────────────────────────
  it('POST scope=user_private — 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'my-skill',
        kind: 'analysis_skill',
        manifest: { foo: 'bar' },
        scope: 'user_private',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.name).toBe('my-skill');
    expect(body.data.scope).toBe('user_private');
    expect(body.data.userId).toBe(userA);
  });

  it('POST scope=first_party — 403 (service rejection)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'sneaky',
        kind: 'analysis_skill',
        manifest: {},
        scope: 'first_party',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/user_private/);
  });

  it('POST scope=workspace — 403 (service rejection)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'ws-attempt',
        kind: 'analysis_skill',
        manifest: {},
        scope: 'workspace',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST — 400 on invalid manifest (non-object)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/composable-skills',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: {
        name: 'bad',
        kind: 'analysis_skill',
        manifest: 'not-an-object',
        scope: 'user_private',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── PATCH /composable-skills/:id ─────────────────────────────────
  it('PATCH own user_private — 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/composable-skills/priv-a',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { name: 'alice-renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('alice-renamed');
  });

  it('PATCH first-party — 404 (RLS hides write)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/composable-skills/fp-1',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: { name: 'pwn3d' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── DELETE /composable-skills/:id ────────────────────────────────
  it('DELETE own — 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/composable-skills/priv-a',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(204);
    expect(store.find((r) => r.id === 'priv-a')).toBeUndefined();
  });

  it('DELETE first-party — 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/composable-skills/fp-1',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
    // Still present in store.
    expect(store.find((r) => r.id === 'fp-1')).toBeDefined();
  });

  it('GET — 401 unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/composable-skills',
    });
    expect(res.statusCode).toBe(401);
  });
});
