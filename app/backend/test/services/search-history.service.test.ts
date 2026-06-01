/**
 * M9.5 — search-history service unit tests.
 *
 * Pure-unit suite. `withUser` is mocked to call the inner function with
 * an in-memory `searchHistory` Prisma surface; the suite asserts the
 * row shapes + ordering contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  id: string;
  chatId: string;
  queryHash: string;
  articleIds: string[];
  totalHits: number;
  indicesQueried: string[];
  coverageReach: number | null;
  executedAt: Date;
}

const store: FakeRow[] = [];

const mockSearchHistory = {
  create: vi.fn(async ({ data }: { data: Omit<FakeRow, 'id' | 'executedAt'> }) => {
    const row: FakeRow = {
      id: `sh-${store.length + 1}`,
      executedAt: new Date(),
      ...data,
    };
    store.push(row);
    return row;
  }),
  findFirst: vi.fn(
    async ({
      where,
      orderBy,
    }: {
      where: { chatId: string; queryHash: string };
      orderBy?: { executedAt: 'asc' | 'desc' };
    }) => {
      let rows = store.filter(
        (r) => r.chatId === where.chatId && r.queryHash === where.queryHash,
      );
      if (orderBy?.executedAt === 'desc') {
        rows = [...rows].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
      }
      return rows[0] ?? null;
    },
  ),
};

const withUserMock = vi.fn(
  async (_uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    return fn({ searchHistory: mockSearchHistory });
  },
);
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: withUserMock,
  asAdmin: vi.fn(),
}));

const { recordSearchExecution, findCachedSearch } = await import(
  '../../src/services/search-history.service.js'
);

beforeEach(() => {
  store.length = 0;
  mockSearchHistory.create.mockClear();
  mockSearchHistory.findFirst.mockClear();
  withUserMock.mockClear();
});

describe('recordSearchExecution', () => {
  it('writes a row with the exact shape SearchAgent provides', async () => {
    const row = await recordSearchExecution('u1', {
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: ['os-1', 'os-2'],
      totalHits: 42,
      indicesQueried: ['amx-data-2026-05-01*'],
      coverageReach: 0.9,
    });
    expect(mockSearchHistory.create).toHaveBeenCalledTimes(1);
    expect(mockSearchHistory.create.mock.calls[0]![0].data).toMatchObject({
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: ['os-1', 'os-2'],
      totalHits: 42,
      indicesQueried: ['amx-data-2026-05-01*'],
      coverageReach: 0.9,
    });
    expect(row.id).toBe('sh-1');
  });

  it('runs inside withUser (RLS scope)', async () => {
    await recordSearchExecution('u1', {
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: [],
      totalHits: 0,
      indicesQueried: [],
      coverageReach: null,
    });
    expect(withUserMock).toHaveBeenCalledTimes(1);
    expect(withUserMock.mock.calls[0]![0]).toBe('u1');
  });

  it('coverageReach=null is persisted as null (zero-hits run)', async () => {
    await recordSearchExecution('u1', {
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: [],
      totalHits: 0,
      indicesQueried: [],
      coverageReach: null,
    });
    expect(mockSearchHistory.create.mock.calls[0]![0].data.coverageReach).toBeNull();
  });
});

describe('findCachedSearch', () => {
  it('returns null when no matching row exists', async () => {
    const row = await findCachedSearch('u1', 'c1', 'h1');
    expect(row).toBeNull();
  });

  it('returns the latest row when multiple exist for the same (chatId, queryHash)', async () => {
    // Seed two rows with distinct executedAt.
    store.push({
      id: 'sh-A',
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: [],
      totalHits: 1,
      indicesQueried: [],
      coverageReach: null,
      executedAt: new Date('2026-05-01T10:00:00Z'),
    });
    store.push({
      id: 'sh-B',
      chatId: 'c1',
      queryHash: 'h1',
      articleIds: [],
      totalHits: 2,
      indicesQueried: [],
      coverageReach: null,
      executedAt: new Date('2026-05-02T10:00:00Z'),
    });
    const row = await findCachedSearch('u1', 'c1', 'h1');
    expect(row?.id).toBe('sh-B');
  });

  it('does not return rows for a different chatId', async () => {
    store.push({
      id: 'sh-A',
      chatId: 'c-other',
      queryHash: 'h1',
      articleIds: [],
      totalHits: 1,
      indicesQueried: [],
      coverageReach: null,
      executedAt: new Date(),
    });
    const row = await findCachedSearch('u1', 'c1', 'h1');
    expect(row).toBeNull();
  });

  it('runs inside withUser', async () => {
    await findCachedSearch('u1', 'c1', 'h1');
    expect(withUserMock).toHaveBeenCalledTimes(1);
    expect(withUserMock.mock.calls[0]![0]).toBe('u1');
  });
});
