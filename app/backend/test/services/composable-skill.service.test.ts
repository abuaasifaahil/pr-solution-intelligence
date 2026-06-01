/**
 * M9.6c — composable-skill service unit tests.
 *
 * Pure-unit suite. `withUser` is mocked to call the inner function with
 * an in-memory `composableSkill` Prisma surface. The fake store
 * simulates the RLS SELECT policy (first_party + community-enabled +
 * own user_private) so we can assert visibility AND write-scope rules
 * without a live Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  id: string;
  name: string;
  version: string;
  kind: string;
  manifest: Record<string, unknown>;
  scope: 'first_party' | 'workspace' | 'user_private' | 'community';
  userId: string | null;
  workspaceId: string | null;
  trustLevel: string;
  enabled: boolean;
  createdAt: Date;
}

const store: FakeRow[] = [];
let userIdCtx = '';

/**
 * RLS-equivalent visibility filter used by every read in the mock.
 * Matches the SELECT policy in the migration: first_party rows
 * visible to all; community rows visible when enabled; user_private
 * visible only to the owner; workspace deferred (treated as invisible
 * here, mirroring the migration's omission of a workspace branch).
 */
function visibleToCtx(r: FakeRow): boolean {
  if (r.scope === 'first_party') return true;
  if (r.scope === 'community' && r.enabled) return true;
  if (r.scope === 'user_private' && r.userId === userIdCtx) return true;
  return false;
}

const mockComposableSkill = {
  findMany: vi.fn(
    async ({
      where,
      orderBy: _orderBy,
    }: {
      where?: {
        kind?: string;
        scope?: string;
        enabled?: boolean;
      };
      orderBy?: unknown;
    } = {}) => {
      let rows = store.filter(visibleToCtx);
      if (where?.kind !== undefined) {
        rows = rows.filter((r) => r.kind === where.kind);
      }
      if (where?.scope !== undefined) {
        rows = rows.filter((r) => r.scope === where.scope);
      }
      if (where?.enabled !== undefined) {
        rows = rows.filter((r) => r.enabled === where.enabled);
      }
      // Stable sort matches service `orderBy: [scope, name, version]`.
      rows = [...rows].sort((a, b) => {
        if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return a.version.localeCompare(b.version);
      });
      return rows.map((r) => ({ ...r }));
    },
  ),
  findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
    const row = store.find(
      (r) => visibleToCtx(r) && (where.id === undefined || r.id === where.id),
    );
    return row ? { ...row } : null;
  }),
  create: vi.fn(async ({ data }: { data: Omit<FakeRow, 'id' | 'createdAt'> }) => {
    // Simulate the unique (scope, user_id, workspace_id, name, version)
    // index from the migration.
    const dup = store.find(
      (r) =>
        r.scope === data.scope &&
        r.userId === data.userId &&
        r.workspaceId === data.workspaceId &&
        r.name === data.name &&
        r.version === data.version,
    );
    if (dup) {
      throw new Error('Unique constraint failed on composable_skill_unique_per_scope');
    }
    const row: FakeRow = {
      id: `sk-${store.length + 1}`,
      createdAt: new Date(),
      ...data,
      version: data.version ?? '1.0.0',
      trustLevel: data.trustLevel ?? 'first_party',
      enabled: data.enabled ?? true,
    } as FakeRow;
    store.push(row);
    return { ...row };
  }),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<Omit<FakeRow, 'id' | 'createdAt'>>;
    }) => {
      // Per RLS write policy: only own user_private rows.
      const idx = store.findIndex(
        (r) =>
          r.id === where.id &&
          r.scope === 'user_private' &&
          r.userId === userIdCtx,
      );
      if (idx < 0) {
        const err = new Error('Record to update not found.');
        (err as Error & { code: string }).code = 'P2025';
        throw err;
      }
      const updated: FakeRow = { ...store[idx]!, ...data } as FakeRow;
      store[idx] = updated;
      return { ...updated };
    },
  ),
  delete: vi.fn(async ({ where }: { where: { id: string } }) => {
    const idx = store.findIndex(
      (r) =>
        r.id === where.id &&
        r.scope === 'user_private' &&
        r.userId === userIdCtx,
    );
    if (idx < 0) {
      const err = new Error('Record to delete does not exist.');
      (err as Error & { code: string }).code = 'P2025';
      throw err;
    }
    const [removed] = store.splice(idx, 1);
    return { ...removed! };
  }),
};

const withUserMock = vi.fn(
  async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ composableSkill: mockComposableSkill });
    } finally {
      userIdCtx = '';
    }
  },
);
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: withUserMock,
  asAdmin: vi.fn(),
}));

const { listSkills, getSkill, createSkill, updateSkill, deleteSkill } =
  await import('../../src/services/composable-skill.service.js');

beforeEach(() => {
  store.length = 0;
  userIdCtx = '';
  mockComposableSkill.findMany.mockClear();
  mockComposableSkill.findFirst.mockClear();
  mockComposableSkill.create.mockClear();
  mockComposableSkill.update.mockClear();
  mockComposableSkill.delete.mockClear();
  withUserMock.mockClear();
});

// Helper: seed a row outside RLS visibility for the current ctx (so
// tests can pre-populate "another user's" row or first-party rows).
function seedRow(partial: Partial<FakeRow> & Pick<FakeRow, 'scope' | 'kind'>): FakeRow {
  const row: FakeRow = {
    id: `sk-seed-${store.length + 1}`,
    name: partial.name ?? `skill-${store.length + 1}`,
    version: partial.version ?? '1.0.0',
    kind: partial.kind,
    manifest: partial.manifest ?? {},
    scope: partial.scope,
    userId: partial.userId ?? null,
    workspaceId: partial.workspaceId ?? null,
    trustLevel: partial.trustLevel ?? 'first_party',
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? new Date(),
  };
  store.push(row);
  return row;
}

describe('createSkill', () => {
  it('writes a user_private row with userId pinned', async () => {
    const row = await createSkill('u1', {
      name: 'my-skill',
      kind: 'analysis_skill',
      manifest: { description: 'mine' },
      scope: 'user_private',
    });
    expect(mockComposableSkill.create).toHaveBeenCalledTimes(1);
    expect(mockComposableSkill.create.mock.calls[0]![0].data).toMatchObject({
      name: 'my-skill',
      kind: 'analysis_skill',
      scope: 'user_private',
      userId: 'u1',
    });
    expect(row.userId).toBe('u1');
  });

  it('rejects scope=first_party (only seed can write first-party)', async () => {
    await expect(
      createSkill('u1', {
        name: 'illegal-first-party',
        kind: 'analysis_skill',
        manifest: {},
        scope: 'first_party',
      }),
    ).rejects.toThrow(/user_private/);
    expect(mockComposableSkill.create).not.toHaveBeenCalled();
  });

  it('rejects scope=workspace (Phase 6 admin path)', async () => {
    await expect(
      createSkill('u1', {
        name: 'illegal-workspace',
        kind: 'analysis_skill',
        manifest: {},
        scope: 'workspace',
      }),
    ).rejects.toThrow(/user_private/);
  });

  it('rejects scope=community (Phase 7 marketplace)', async () => {
    await expect(
      createSkill('u1', {
        name: 'illegal-community',
        kind: 'analysis_skill',
        manifest: {},
        scope: 'community',
      }),
    ).rejects.toThrow(/user_private/);
  });

  it('rejects an invalid skill kind (Zod)', async () => {
    await expect(
      createSkill('u1', {
        name: 'bad-kind',
        // @ts-expect-error — deliberate
        kind: 'not_a_kind',
        manifest: {},
        scope: 'user_private',
      }),
    ).rejects.toThrow();
  });

  it('preserves the manifest as-is (JSONB passthrough)', async () => {
    const manifest = {
      description: 'test',
      model_family: 'gpt-4-tier',
      requires: { chat_params: ['brand'] },
      produces: { dashboard_layout: 'custom' },
    };
    const row = await createSkill('u1', {
      name: 'manifest-test',
      kind: 'analysis_skill',
      manifest,
      scope: 'user_private',
    });
    expect(row.manifest).toEqual(manifest);
  });

  it('defaults version to 1.0.0 when not supplied', async () => {
    const row = await createSkill('u1', {
      name: 'no-version',
      kind: 'tool_skill',
      manifest: {},
      scope: 'user_private',
    });
    expect(row.version).toBe('1.0.0');
  });
});

describe('listSkills', () => {
  it('returns first_party + community-enabled + own user_private', async () => {
    // Seed: 1 first_party, 1 community(enabled), 1 community(disabled),
    // 1 Alice user_private, 1 Bob user_private.
    seedRow({ name: 'first-party-1', kind: 'analysis_skill', scope: 'first_party' });
    seedRow({ name: 'community-on', kind: 'tool_skill', scope: 'community', enabled: true });
    seedRow({ name: 'community-off', kind: 'tool_skill', scope: 'community', enabled: false });
    seedRow({ name: 'alice-private', kind: 'analysis_skill', scope: 'user_private', userId: 'u-alice' });
    seedRow({ name: 'bob-private', kind: 'analysis_skill', scope: 'user_private', userId: 'u-bob' });

    const aliceRows = await listSkills('u-alice');
    const names = aliceRows.map((r) => r.name).sort();
    expect(names).toEqual([
      'alice-private',
      'community-on',
      'first-party-1',
    ]);
  });

  it('hides another user’s user_private rows (RLS)', async () => {
    seedRow({ name: 'bob-private', kind: 'analysis_skill', scope: 'user_private', userId: 'u-bob' });
    const aliceRows = await listSkills('u-alice');
    expect(aliceRows.map((r) => r.name)).toEqual([]);
  });

  it('filters by kind when supplied', async () => {
    seedRow({ name: 'analysis-1', kind: 'analysis_skill', scope: 'first_party' });
    seedRow({ name: 'tool-1', kind: 'tool_skill', scope: 'first_party' });
    const out = await listSkills('u1', { kind: 'tool_skill' });
    expect(out.map((r) => r.name)).toEqual(['tool-1']);
  });

  it('filters by enabledOnly=true', async () => {
    seedRow({ name: 'on', kind: 'analysis_skill', scope: 'first_party', enabled: true });
    seedRow({ name: 'off', kind: 'analysis_skill', scope: 'first_party', enabled: false });
    const out = await listSkills('u1', { enabledOnly: true });
    expect(out.map((r) => r.name)).toEqual(['on']);
  });
});

describe('getSkill', () => {
  it('returns first-party rows for any user', async () => {
    const seeded = seedRow({ name: 'fp', kind: 'analysis_skill', scope: 'first_party' });
    const row = await getSkill('u1', seeded.id);
    expect(row?.id).toBe(seeded.id);
  });

  it('returns null when fetching another user’s user_private skill', async () => {
    const bobs = seedRow({
      name: 'bob-private',
      kind: 'analysis_skill',
      scope: 'user_private',
      userId: 'u-bob',
    });
    const row = await getSkill('u-alice', bobs.id);
    expect(row).toBeNull();
  });
});

describe('updateSkill', () => {
  it('patches own user_private rows', async () => {
    const created = await createSkill('u1', {
      name: 'orig',
      kind: 'analysis_skill',
      manifest: { v: 1 },
      scope: 'user_private',
    });
    const updated = await updateSkill('u1', created.id, {
      name: 'new-name',
      manifest: { v: 2 },
    });
    expect(updated.name).toBe('new-name');
    expect(updated.manifest).toEqual({ v: 2 });
  });

  it('refuses to patch first-party rows (RLS write policy)', async () => {
    const fp = seedRow({
      name: 'fp',
      kind: 'analysis_skill',
      scope: 'first_party',
    });
    await expect(
      updateSkill('u1', fp.id, { name: 'hijack' }),
    ).rejects.toThrow();
  });

  it('refuses to patch another user’s user_private rows', async () => {
    const bobs = seedRow({
      name: 'bob-private',
      kind: 'analysis_skill',
      scope: 'user_private',
      userId: 'u-bob',
    });
    await expect(
      updateSkill('u-alice', bobs.id, { name: 'hijack' }),
    ).rejects.toThrow();
  });
});

describe('deleteSkill', () => {
  it('deletes own user_private rows', async () => {
    const created = await createSkill('u1', {
      name: 'to-delete',
      kind: 'analysis_skill',
      manifest: {},
      scope: 'user_private',
    });
    await deleteSkill('u1', created.id);
    const out = await listSkills('u1');
    expect(out.find((r) => r.id === created.id)).toBeUndefined();
  });

  it('cannot delete first-party rows', async () => {
    const fp = seedRow({
      name: 'fp',
      kind: 'analysis_skill',
      scope: 'first_party',
    });
    await expect(deleteSkill('u1', fp.id)).rejects.toThrow();
  });
});
