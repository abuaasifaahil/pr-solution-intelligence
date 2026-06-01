/**
 * M9.6c — user-agent service unit tests.
 *
 * Pure-unit suite. `withUser` is mocked to call the inner function with
 * an in-memory `userAgent` Prisma surface; the suite asserts the row
 * shapes + RLS isolation pattern (every method threads through
 * withUser with the caller's userId).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  id: string;
  userId: string;
  name: string;
  baseAgentKind: string;
  customization: Record<string, unknown>;
  scope: string;
  createdAt: Date;
}

const store: FakeRow[] = [];
let userIdCtx = '';

const mockUserAgent = {
  findMany: vi.fn(
    async ({
      where,
      orderBy: _orderBy,
    }: {
      where?: { userId?: string };
      orderBy?: unknown;
    } = {}) => {
      // RLS simulation: only rows whose userId matches the current
      // `userIdCtx` are visible. The `where.userId` predicate is
      // belt-and-suspenders but exercised separately below.
      let rows = store.filter((r) => r.userId === userIdCtx);
      if (where?.userId !== undefined) {
        rows = rows.filter((r) => r.userId === where.userId);
      }
      return rows.map((r) => ({ ...r }));
    },
  ),
  findFirst: vi.fn(
    async ({
      where,
    }: {
      where: { id?: string; userId?: string };
    }) => {
      const row = store.find(
        (r) =>
          r.userId === userIdCtx &&
          (where.id === undefined || r.id === where.id) &&
          (where.userId === undefined || r.userId === where.userId),
      );
      return row ? { ...row } : null;
    },
  ),
  create: vi.fn(async ({ data }: { data: Omit<FakeRow, 'id' | 'createdAt'> }) => {
    // Simulate the (user_id, name) unique constraint.
    const conflict = store.find(
      (r) => r.userId === data.userId && r.name === data.name,
    );
    if (conflict) {
      throw new Error(
        'Unique constraint failed on the fields: (`user_id`,`name`)',
      );
    }
    const row: FakeRow = {
      id: `ua-${store.length + 1}`,
      createdAt: new Date(),
      ...data,
    };
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
      const idx = store.findIndex(
        (r) => r.id === where.id && r.userId === userIdCtx,
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
      (r) => r.id === where.id && r.userId === userIdCtx,
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
      return await fn({ userAgent: mockUserAgent });
    } finally {
      userIdCtx = '';
    }
  },
);
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: withUserMock,
  asAdmin: vi.fn(),
}));

const {
  listUserAgents,
  getUserAgent,
  createUserAgent,
  updateUserAgent,
  deleteUserAgent,
} = await import('../../src/services/user-agent.service.js');

beforeEach(() => {
  store.length = 0;
  userIdCtx = '';
  mockUserAgent.findMany.mockClear();
  mockUserAgent.findFirst.mockClear();
  mockUserAgent.create.mockClear();
  mockUserAgent.update.mockClear();
  mockUserAgent.delete.mockClear();
  withUserMock.mockClear();
});

describe('createUserAgent', () => {
  it('writes a row with the calling userId pinned', async () => {
    const row = await createUserAgent('u1', {
      name: 'My PR Agent',
      baseAgentKind: 'pr_impact',
      customization: { promptPrefix: 'You are a pharma analyst' },
    });
    expect(mockUserAgent.create).toHaveBeenCalledTimes(1);
    expect(mockUserAgent.create.mock.calls[0]![0].data).toMatchObject({
      userId: 'u1',
      name: 'My PR Agent',
      baseAgentKind: 'pr_impact',
      scope: 'user_private', // default
    });
    expect(row.id).toBe('ua-1');
    expect(row.userId).toBe('u1');
  });

  it('runs inside withUser (RLS scope)', async () => {
    await createUserAgent('u1', {
      name: 'agent-a',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    expect(withUserMock).toHaveBeenCalledTimes(1);
    expect(withUserMock.mock.calls[0]![0]).toBe('u1');
  });

  it('respects an explicit scope override', async () => {
    await createUserAgent('u1', {
      name: 'workspace-agent',
      baseAgentKind: 'brand_sentinel',
      customization: {},
      scope: 'workspace_shared',
    });
    expect(mockUserAgent.create.mock.calls[0]![0].data.scope).toBe(
      'workspace_shared',
    );
  });

  it('rejects an invalid baseAgentKind (Zod)', async () => {
    await expect(
      createUserAgent('u1', {
        name: 'bad-kind',
        // @ts-expect-error — deliberate Zod-failure input
        baseAgentKind: 'not_a_real_kind',
        customization: {},
      }),
    ).rejects.toThrow();
    expect(mockUserAgent.create).not.toHaveBeenCalled();
  });

  it('rejects an empty name', async () => {
    await expect(
      createUserAgent('u1', {
        name: '',
        baseAgentKind: 'pr_impact',
        customization: {},
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (userId, name) pair', async () => {
    await createUserAgent('u1', {
      name: 'duplicate',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    await expect(
      createUserAgent('u1', {
        name: 'duplicate',
        baseAgentKind: 'crisis_watch',
        customization: {},
      }),
    ).rejects.toThrow(/unique constraint/i);
  });
});

describe('listUserAgents', () => {
  it('returns only the calling user’s rows (RLS-scoped)', async () => {
    await createUserAgent('u1', {
      name: 'alice-1',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    await createUserAgent('u1', {
      name: 'alice-2',
      baseAgentKind: 'brand_sentinel',
      customization: {},
    });
    // Bob's row is hidden by RLS — seed it directly with userIdCtx swapped.
    userIdCtx = 'u2';
    store.push({
      id: 'ua-bob',
      userId: 'u2',
      name: 'bob-1',
      baseAgentKind: 'pr_impact',
      customization: {},
      scope: 'user_private',
      createdAt: new Date(),
    });
    userIdCtx = '';

    const aliceRows = await listUserAgents('u1');
    expect(aliceRows.map((r) => r.name).sort()).toEqual([
      'alice-1',
      'alice-2',
    ]);
    const bobRows = await listUserAgents('u2');
    expect(bobRows.map((r) => r.name)).toEqual(['bob-1']);
  });

  it('returns [] when the user has no agents yet', async () => {
    const rows = await listUserAgents('u1');
    expect(rows).toEqual([]);
  });
});

describe('getUserAgent', () => {
  it('returns the row when the caller owns it', async () => {
    const created = await createUserAgent('u1', {
      name: 'my-agent',
      baseAgentKind: 'pr_impact',
      customization: { x: 1 },
    });
    const fetched = await getUserAgent('u1', created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.userId).toBe('u1');
  });

  it('returns null when the agent belongs to another user (RLS hidden)', async () => {
    const created = await createUserAgent('u1', {
      name: 'alice-only',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    const fetched = await getUserAgent('u2', created.id);
    expect(fetched).toBeNull();
  });

  it('returns null when the id does not exist', async () => {
    const fetched = await getUserAgent('u1', 'no-such-id');
    expect(fetched).toBeNull();
  });
});

describe('updateUserAgent', () => {
  it('patches name, customization, and scope selectively', async () => {
    const created = await createUserAgent('u1', {
      name: 'orig-name',
      baseAgentKind: 'pr_impact',
      customization: { a: 1 },
    });
    const updated = await updateUserAgent('u1', created.id, {
      name: 'new-name',
      customization: { b: 2 },
    });
    expect(updated.name).toBe('new-name');
    expect(updated.customization).toEqual({ b: 2 });
    // baseAgentKind + scope untouched
    expect(updated.baseAgentKind).toBe('pr_impact');
    expect(updated.scope).toBe('user_private');
  });

  it('throws when another user tries to patch (RLS → no rows matched)', async () => {
    const created = await createUserAgent('u1', {
      name: 'alice-private',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    await expect(
      updateUserAgent('u2', created.id, { name: 'hijacked' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('deleteUserAgent', () => {
  it('removes the row when the caller owns it', async () => {
    const created = await createUserAgent('u1', {
      name: 'to-delete',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    await deleteUserAgent('u1', created.id);
    const rows = await listUserAgents('u1');
    expect(rows).toEqual([]);
  });

  it('throws when another user tries to delete (RLS hides the row)', async () => {
    const created = await createUserAgent('u1', {
      name: 'alice-only',
      baseAgentKind: 'pr_impact',
      customization: {},
    });
    await expect(deleteUserAgent('u2', created.id)).rejects.toThrow();
  });
});
