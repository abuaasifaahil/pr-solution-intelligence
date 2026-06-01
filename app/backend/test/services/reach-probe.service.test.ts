/**
 * Phase 3.5 (M9.5.5) — reach-probe service unit tests.
 *
 * Pure-unit suite. `patchParams`, the chat-state DB writer, and the
 * event-bus surfaces are all mocked. Tests exercise:
 *
 *   - `enterReachProbe` emits `reach:absent` + pins chat state
 *   - idempotent re-entry (state already set) is a no-op state write
 *   - `resolveReachProbe('upgrade_similarweb')` patches enrichmentType,
 *     emits `reach:resolved`, sets state=enriching, dispatches enrichment
 *   - `resolveReachProbe('continue_without_reach')` patches intention,
 *     emits `reach:resolved`, sets state=enriching, dispatches enrichment
 *   - each branch leaves the OTHER field untouched
 *   - errors from `patchParams` propagate (no silent swallow)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Programmable mock state ─────────────────────────────────────────────
interface FakeChatRow {
  id: string;
  context: Record<string, unknown>;
}
const chatStore: FakeChatRow[] = [];

let paramsEnrichmentType: 'standard' | 'reach' = 'standard';
let paramsIntention: 'intention_based' | 'comment_based' = 'intention_based';

// ─── chat-params.service ─────────────────────────────────────────────────
const patchParamsMock = vi.fn(
  async (
    _userId: string,
    _chatId: string,
    patch: { enrichmentType?: 'standard' | 'reach'; intention?: 'intention_based' | 'comment_based' },
  ) => {
    if (patch.enrichmentType) paramsEnrichmentType = patch.enrichmentType;
    if (patch.intention) paramsIntention = patch.intention;
    return { params: {}, nextPrompt: '' };
  },
);
vi.mock('../../src/services/chat-params.service.js', () => ({
  patchParams: patchParamsMock,
}));

// ─── event-bus ───────────────────────────────────────────────────────────
const publishChatEventMock = vi.fn(
  async (_chatId: string, _type: string, _payload: unknown) => {},
);
const publishAgentBusMock = vi.fn(async (_channel: string, _payload: unknown) => {});
vi.mock('../../src/lib/event-bus.js', () => ({
  publishChatEvent: publishChatEventMock,
  publishAgentBus: publishAgentBusMock,
  subscribeChatEvents: vi.fn(),
}));

// ─── prisma-rls.asAdmin ──────────────────────────────────────────────────
// The service uses `asAdmin` for both reading chat_params back AND
// updating `chats.context`. Provide an in-memory tx that satisfies both
// surfaces.
const mockChat = {
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
    chatStore.find((c) => c.id === where.id) ?? null,
  ),
  update: vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { context: Record<string, unknown> };
    }) => {
      const row = chatStore.find((c) => c.id === where.id);
      if (row) row.context = data.context;
      return row;
    },
  ),
};
const mockChatParams = {
  findUnique: vi.fn(async () => ({ enrichmentType: paramsEnrichmentType })),
};
const asAdminMock = vi.fn(
  async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ chat: mockChat, chatParams: mockChatParams }),
);
vi.mock('../../src/lib/prisma-rls.js', () => ({
  asAdmin: asAdminMock,
  withUser: vi.fn(),
}));

// Stub the shared db import — `@prsi/shared/db` is the source of the
// `prisma` re-export; the service uses it only via `asAdmin`.
vi.mock('@prsi/shared/db', () => ({
  prisma: {},
}));

const { enterReachProbe, resolveReachProbe } = await import(
  '../../src/services/reach-probe.service.js'
);

// ─── Helpers ─────────────────────────────────────────────────────────────
const USER = '00000000-0000-0000-0000-00000000aaaa';
const CHAT = '00000000-0000-0000-0000-00000000bbbb';

function seedChat(initialState?: string) {
  chatStore.length = 0;
  chatStore.push({
    id: CHAT,
    context: initialState ? { state: initialState } : {},
  });
}

function eventsOfType(type: string) {
  return publishChatEventMock.mock.calls.filter((c) => c[1] === type);
}

// ─── Lifecycle reset ─────────────────────────────────────────────────────
beforeEach(() => {
  chatStore.length = 0;
  paramsEnrichmentType = 'standard';
  paramsIntention = 'intention_based';
  patchParamsMock.mockClear();
  publishChatEventMock.mockClear();
  publishAgentBusMock.mockClear();
  asAdminMock.mockClear();
  mockChat.findUnique.mockClear();
  mockChat.update.mockClear();
  mockChatParams.findUnique.mockClear();
});

// ─── enterReachProbe ─────────────────────────────────────────────────────
describe('reach-probe.service — enterReachProbe', () => {
  it('emits reach:absent with the correct payload shape', async () => {
    seedChat();
    await enterReachProbe({ chatId: CHAT, coverageReach: 0.23, sampleSize: 50 });

    const absentEvts = eventsOfType('reach:absent');
    expect(absentEvts).toHaveLength(1);
    expect(absentEvts[0]![2]).toEqual({
      chatId: CHAT,
      coverageReach: 0.23,
      sampleSize: 50,
      suggestUpgrade: true,
    });
  });

  it('sets chat.context.state to "awaiting_reach_upgrade_consent"', async () => {
    seedChat();
    await enterReachProbe({ chatId: CHAT, coverageReach: 0.1, sampleSize: 50 });

    expect(mockChat.update).toHaveBeenCalledTimes(1);
    expect(chatStore[0]!.context).toMatchObject({
      state: 'awaiting_reach_upgrade_consent',
    });
  });

  it('preserves existing chat.context fields when patching state', async () => {
    seedChat();
    chatStore[0]!.context = { brand: 'FreshSip', dateRange: { type: 'weekly' } };

    await enterReachProbe({ chatId: CHAT, coverageReach: 0.1, sampleSize: 50 });

    expect(chatStore[0]!.context).toMatchObject({
      brand: 'FreshSip',
      dateRange: { type: 'weekly' },
      state: 'awaiting_reach_upgrade_consent',
    });
  });

  it('idempotent: second call on a chat already in probe state is a no-op state write', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await enterReachProbe({ chatId: CHAT, coverageReach: 0.1, sampleSize: 50 });

    // Even though we publish the WS event each time (the channel is
    // at-least-once), the DB update is skipped when state is already set.
    expect(mockChat.update).not.toHaveBeenCalled();
    // WS event still fires — frontend dedupes by chatId.
    expect(eventsOfType('reach:absent')).toHaveLength(1);
  });

  it('handles missing chat gracefully (no throw, no update)', async () => {
    // chatStore left empty — chat.findUnique returns null.
    chatStore.length = 0;

    await expect(
      enterReachProbe({ chatId: CHAT, coverageReach: 0.1, sampleSize: 50 }),
    ).resolves.toBeUndefined();
    expect(mockChat.update).not.toHaveBeenCalled();
  });
});

// ─── resolveReachProbe — upgrade branch ──────────────────────────────────
describe('reach-probe.service — resolveReachProbe (upgrade_similarweb)', () => {
  it('patches enrichmentType=reach (and does NOT touch intention)', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'upgrade_similarweb');

    expect(patchParamsMock).toHaveBeenCalledTimes(1);
    expect(patchParamsMock.mock.calls[0]![2]).toEqual({ enrichmentType: 'reach' });
    // The single patch call must NOT carry an `intention` field.
    expect(patchParamsMock.mock.calls[0]![2]).not.toHaveProperty('intention');
  });

  it('emits reach:resolved with the chosen value', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'upgrade_similarweb');

    const evts = eventsOfType('reach:resolved');
    expect(evts).toHaveLength(1);
    expect(evts[0]![2]).toEqual({ chatId: CHAT, choice: 'upgrade_similarweb' });
  });

  it('transitions chat state to "enriching"', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'upgrade_similarweb');

    expect(chatStore[0]!.context).toMatchObject({ state: 'enriching' });
  });

  it('dispatches agent:enrichment:incoming with enrichmentType=reach', async () => {
    seedChat('awaiting_reach_upgrade_consent');
    // The patchParams mock updates `paramsEnrichmentType` so the
    // chatParams.findUnique re-read inside the service sees `reach`.
    await resolveReachProbe(USER, CHAT, 'upgrade_similarweb');

    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock.mock.calls[0]![0]).toBe('agent:enrichment:incoming');
    expect(publishAgentBusMock.mock.calls[0]![1]).toEqual({
      chatId: CHAT,
      userId: USER,
      articleIds: [],
      enrichmentType: 'reach',
    });
  });
});

// ─── resolveReachProbe — continue branch ─────────────────────────────────
describe('reach-probe.service — resolveReachProbe (continue_without_reach)', () => {
  it('patches intention=comment_based (and does NOT touch enrichmentType)', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'continue_without_reach');

    expect(patchParamsMock).toHaveBeenCalledTimes(1);
    expect(patchParamsMock.mock.calls[0]![2]).toEqual({ intention: 'comment_based' });
    expect(patchParamsMock.mock.calls[0]![2]).not.toHaveProperty('enrichmentType');
  });

  it('emits reach:resolved with the chosen value', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'continue_without_reach');

    const evts = eventsOfType('reach:resolved');
    expect(evts).toHaveLength(1);
    expect(evts[0]![2]).toEqual({ chatId: CHAT, choice: 'continue_without_reach' });
  });

  it('transitions chat state to "enriching"', async () => {
    seedChat('awaiting_reach_upgrade_consent');

    await resolveReachProbe(USER, CHAT, 'continue_without_reach');

    expect(chatStore[0]!.context).toMatchObject({ state: 'enriching' });
  });

  it('dispatches agent:enrichment:incoming with enrichmentType=standard (no SimilarWeb)', async () => {
    seedChat('awaiting_reach_upgrade_consent');
    // continue_without_reach leaves enrichmentType at 'standard' — the
    // fixture default — so the bus dispatch payload should reflect that.

    await resolveReachProbe(USER, CHAT, 'continue_without_reach');

    expect(publishAgentBusMock).toHaveBeenCalledTimes(1);
    expect(publishAgentBusMock.mock.calls[0]![1]).toEqual({
      chatId: CHAT,
      userId: USER,
      articleIds: [],
      enrichmentType: 'standard',
    });
  });
});

// ─── Error propagation ───────────────────────────────────────────────────
describe('reach-probe.service — error propagation', () => {
  it('resolveReachProbe propagates patchParams errors (does NOT silent-swallow)', async () => {
    seedChat('awaiting_reach_upgrade_consent');
    patchParamsMock.mockRejectedValueOnce(new Error('chat_params write failed'));

    await expect(
      resolveReachProbe(USER, CHAT, 'upgrade_similarweb'),
    ).rejects.toThrow(/chat_params write failed/);

    // No downstream state mutation when patchParams threw.
    expect(publishAgentBusMock).not.toHaveBeenCalled();
    expect(eventsOfType('reach:resolved')).toHaveLength(0);
  });
});
