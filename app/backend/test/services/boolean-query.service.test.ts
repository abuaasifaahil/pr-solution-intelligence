/**
 * M7.6 — boolean-query.service unit tests.
 *
 * In-memory mocks for chat_params, boolean_queries, chat. The shared
 * `phase2-jobs` BullMQ queue is replaced with a spy so we can assert the
 * 'data-extract' job is enqueued by confirmQuery. The chat-params service
 * (patchParams) is mocked too — its own state-advance logic is covered
 * in the M7.5 suite; here we just confirm confirmQuery calls it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// ───────────────────────────────────────────────────────────────────────
// In-memory stores
// ───────────────────────────────────────────────────────────────────────
interface ParamsRow {
  id: string;
  chatId: string;
  userId: string;
  brand: string | null;
  competitors: unknown;
  dateStart: Date | null;
  dateEnd: Date | null;
}

interface QueryRow {
  id: string;
  chatId: string;
  chatParamsId: string;
  queryText: string;
  queryStructured: unknown;
  version: number;
  isConfirmed: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
}

const paramsStore: ParamsRow[] = [];
const queryStore: QueryRow[] = [];

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

const chatParamsMock = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((r) => r.chatId === where.chatId) ?? null,
  ),
};

const booleanQueryMock = {
  findFirst: vi.fn(
    async ({
      where,
      orderBy,
    }: {
      where: { chatId: string; chatParamsId?: string; isConfirmed?: boolean };
      orderBy?: { version?: 'asc' | 'desc' } | Array<Record<string, 'asc' | 'desc'>>;
    }) => {
      const rows = queryStore.filter((q) => {
        if (q.chatId !== where.chatId) return false;
        if (where.chatParamsId !== undefined && q.chatParamsId !== where.chatParamsId) return false;
        if (where.isConfirmed !== undefined && q.isConfirmed !== where.isConfirmed) return false;
        return true;
      });
      if (rows.length === 0) return null;
      // Support the two orderBy shapes the service uses.
      if (Array.isArray(orderBy)) {
        // [{ isConfirmed: 'desc' }, { version: 'desc' }]
        rows.sort((a, b) => {
          for (const ob of orderBy) {
            if ('isConfirmed' in ob) {
              const diff = (b.isConfirmed ? 1 : 0) - (a.isConfirmed ? 1 : 0);
              if (diff !== 0) return ob.isConfirmed === 'desc' ? diff : -diff;
            }
            if ('version' in ob) {
              const diff = b.version - a.version;
              if (diff !== 0) return ob.version === 'desc' ? diff : -diff;
            }
          }
          return 0;
        });
      } else if (orderBy?.version) {
        rows.sort((a, b) => (orderBy.version === 'desc' ? b.version - a.version : a.version - b.version));
      }
      return rows[0]!;
    },
  ),
  create: vi.fn(async ({ data }: { data: Partial<QueryRow> }) => {
    const row: QueryRow = {
      id: nextId('q'),
      chatId: data.chatId!,
      chatParamsId: data.chatParamsId!,
      queryText: data.queryText!,
      queryStructured: data.queryStructured ?? {},
      version: data.version ?? 1,
      isConfirmed: data.isConfirmed ?? false,
      confirmedAt: data.confirmedAt ?? null,
      createdAt: new Date(),
    };
    queryStore.push(row);
    return row;
  }),
  update: vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<QueryRow> }) => {
      const r = queryStore.find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      Object.assign(r, data);
      return { ...r };
    },
  ),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    chatParams: chatParamsMock,
    booleanQuery: booleanQueryMock,
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ chatParams: chatParamsMock, booleanQuery: booleanQueryMock }),
  ),
  asAdmin: vi.fn(),
}));

const queueAddMock = vi.fn(
  async (_name: string, _payload: Record<string, unknown>) => ({ id: 'job-1' }),
);
vi.mock('../../src/lib/queue.js', () => ({
  getQueue: () => ({ add: queueAddMock }),
  startInlineWorker: vi.fn(),
  closeQueue: vi.fn(),
  QUEUE_NAME_PHASE2: 'phase2-jobs',
}));

// chat-params.service.patchParams is invoked by confirmQuery; mock it so
// this suite stays scoped to boolean-query behavior.
const patchParamsMock = vi.fn(
  async (_uid: string, _chatId: string, _patch: Record<string, unknown>) => ({
    params: {},
    nextPrompt: null,
  }),
);
vi.mock('../../src/services/chat-params.service.js', () => ({
  patchParams: patchParamsMock,
}));

const { generateQueryForChat, patchQueryText, confirmQuery, getLatestQuery } =
  await import('../../src/services/boolean-query.service.js');

const USER_A = '00000000-0000-0000-0000-00000000aaaa';
const CHAT_A = '00000000-0000-0000-0000-00000000bbbb';
const PARAMS_A = 'params-a';

function seedParams(overrides: Partial<ParamsRow> = {}): ParamsRow {
  const row: ParamsRow = {
    id: PARAMS_A,
    chatId: CHAT_A,
    userId: USER_A,
    brand: 'FreshSip',
    competitors: ['PepsiCo', 'Coca-Cola'],
    dateStart: new Date('2026-05-01T00:00:00.000Z'),
    dateEnd: new Date('2026-05-20T00:00:00.000Z'),
    ...overrides,
  };
  paramsStore.push(row);
  return row;
}

describe('boolean-query.service', () => {
  beforeEach(() => {
    paramsStore.length = 0;
    queryStore.length = 0;
    counter = 0;
    chatParamsMock.findUnique.mockClear();
    booleanQueryMock.findFirst.mockClear();
    booleanQueryMock.create.mockClear();
    booleanQueryMock.update.mockClear();
    queueAddMock.mockClear();
    patchParamsMock.mockClear();
  });

  // ─── generateQueryForChat ──────────────────────────────────────────
  it('generateQueryForChat — creates a v1 row from params', async () => {
    seedParams();
    const q = await generateQueryForChat(USER_A, CHAT_A);
    expect(q.version).toBe(1);
    expect(q.isConfirmed).toBe(false);
    expect(q.queryText).toContain('title:"FreshSip"');
    expect(q.queryText).toContain('date:[2026-05-01 TO 2026-05-20]');
    expect(queryStore).toHaveLength(1);
  });

  it('generateQueryForChat — re-running with same params reuses v1 (no bump)', async () => {
    seedParams();
    const q1 = await generateQueryForChat(USER_A, CHAT_A);
    const q2 = await generateQueryForChat(USER_A, CHAT_A);
    expect(q2.id).toBe(q1.id);
    expect(q2.version).toBe(1);
    expect(queryStore).toHaveLength(1);
  });

  it('generateQueryForChat — re-running after params change creates v2', async () => {
    seedParams();
    const q1 = await generateQueryForChat(USER_A, CHAT_A);
    // Mutate params and re-generate.
    paramsStore[0]!.competitors = ['Snapple'];
    const q2 = await generateQueryForChat(USER_A, CHAT_A);
    expect(q2.version).toBe(2);
    expect(q2.id).not.toBe(q1.id);
    expect(queryStore).toHaveLength(2);
  });

  it('generateQueryForChat — throws "Chat params not found" when params row missing', async () => {
    await expect(generateQueryForChat(USER_A, CHAT_A)).rejects.toThrow('Chat params not found');
  });

  it('generateQueryForChat — throws when brand is missing', async () => {
    seedParams({ brand: null });
    await expect(generateQueryForChat(USER_A, CHAT_A)).rejects.toThrow(/brand required/);
  });

  // ─── patchQueryText ────────────────────────────────────────────────
  it('patchQueryText — creates v2 with edited text', async () => {
    seedParams();
    const v1 = await generateQueryForChat(USER_A, CHAT_A);
    const v2 = await patchQueryText(USER_A, CHAT_A, 'manually edited query text');
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.queryText).toBe('manually edited query text');
    expect(v2.isConfirmed).toBe(false);
    expect(queryStore).toHaveLength(2);
  });

  it('patchQueryText — throws when no draft exists', async () => {
    await expect(patchQueryText(USER_A, CHAT_A, 'whatever')).rejects.toThrow(/No draft query to edit/);
  });

  it('patchQueryText — empty/whitespace text rejected', async () => {
    seedParams();
    await generateQueryForChat(USER_A, CHAT_A);
    await expect(patchQueryText(USER_A, CHAT_A, '   ')).rejects.toThrow(/cannot be empty/);
  });

  // ─── confirmQuery ──────────────────────────────────────────────────
  it('confirmQuery — flips is_confirmed, enqueues data-extract, calls patchParams', async () => {
    seedParams();
    const draft = await generateQueryForChat(USER_A, CHAT_A);
    const confirmed = await confirmQuery(USER_A, CHAT_A);

    expect(confirmed.id).toBe(draft.id);
    expect(confirmed.isConfirmed).toBe(true);
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [jobName, payload] = queueAddMock.mock.calls[0]!;
    expect(jobName).toBe('data-extract');
    expect(payload).toMatchObject({ chatId: CHAT_A, userId: USER_A, queryId: draft.id });

    // patchParams called with empty patch (to recompute snapshot).
    expect(patchParamsMock).toHaveBeenCalledTimes(1);
    expect(patchParamsMock.mock.calls[0]![1]).toBe(CHAT_A);
    expect(patchParamsMock.mock.calls[0]![2]).toEqual({});
  });

  it('confirmQuery — throws when no draft exists', async () => {
    await expect(confirmQuery(USER_A, CHAT_A)).rejects.toThrow(/No draft query to confirm/);
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(patchParamsMock).not.toHaveBeenCalled();
  });

  // ─── getLatestQuery ────────────────────────────────────────────────
  it('getLatestQuery — returns null when no queries exist', async () => {
    const q = await getLatestQuery(USER_A, CHAT_A);
    expect(q).toBeNull();
  });

  it('getLatestQuery — prefers confirmed row over higher-version draft', async () => {
    seedParams();
    const draft = await generateQueryForChat(USER_A, CHAT_A);
    // Manually mark it confirmed (simulates confirmQuery without invoking queue).
    draft.isConfirmed = true;
    draft.confirmedAt = new Date();
    // Add a higher-version draft afterward (shouldn't happen in practice).
    queryStore.push({
      id: 'q-99',
      chatId: CHAT_A,
      chatParamsId: PARAMS_A,
      queryText: 'newer draft',
      queryStructured: {},
      version: 99,
      isConfirmed: false,
      confirmedAt: null,
      createdAt: new Date(),
    });
    const latest = await getLatestQuery(USER_A, CHAT_A);
    expect(latest?.id).toBe(draft.id); // confirmed wins
  });
});
