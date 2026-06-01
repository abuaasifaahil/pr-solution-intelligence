/**
 * M9.7 — source-snapshot helper unit tests.
 *
 * Verifies the helper's branching behavior:
 *   - empty array when no chat_params row
 *   - empty array when csv_upload + no uploadId
 *   - one snapshot when csv_upload + uploadId
 *   - empty array when opensearch + no resolvable config
 *   - one snapshot when opensearch + resolvable config
 *   - adapter is constructed via createAdapter() (mock + verify)
 *
 * @file backend/test/lib/source-snapshot.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────

interface ParamsRow {
  chatId: string;
  userId: string;
  dataSource: 'csv_upload' | 'opensearch';
  uploadId: string | null;
}

const paramsStore: ParamsRow[] = [];
let userIdCtx = '';

const chatParamsMock = {
  findUnique: vi.fn(async ({ where }: { where: { chatId: string } }) =>
    paramsStore.find((r) => r.chatId === where.chatId && r.userId === userIdCtx) ?? null,
  ),
};

vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try {
      return await fn({ chatParams: chatParamsMock });
    } finally {
      userIdCtx = '';
    }
  }),
  asAdmin: vi.fn(),
}));

const sampleArticles = [
  {
    sourceArticleId: '1',
    title: 'Hello',
    content: 'Body',
    description: null,
    source: null,
    author: null,
    publishedDate: null,
    url: null,
    publisherDomain: null,
    language: 'en',
    country: null,
    reach: null,
    sources: null,
    rawData: {},
    sourceKind: 'csv_upload' as const,
  },
];

const declaredCapabilities = {
  hasReach: 'never' as const,
  hasArticleSentiment: 'never' as const,
  hasEntities: 'never' as const,
  hasThemes: 'never' as const,
  hasEngagement: 'never' as const,
  hasCountry: 'never' as const,
  hasAuthor: 'never' as const,
};

const createAdapterMock = vi.fn();

vi.mock('../../src/data-sources/registry.js', () => ({
  createAdapter: (input: unknown) => createAdapterMock(input),
}));

const resolveOpenSearchConfigMock = vi.fn();

vi.mock('../../src/data-sources/opensearch/config-resolver.js', () => ({
  resolveOpenSearchConfig: (uid: string) => resolveOpenSearchConfigMock(uid),
}));

function makeFakeAdapter(kind: 'csv_upload' | 'opensearch') {
  return {
    kind,
    declaredCapabilities: () => declaredCapabilities,
    // eslint-disable-next-line @typescript-eslint/require-await
    fetch: async function* () {
      yield {
        articles: sampleArticles.map((a) => ({ ...a, sourceKind: kind })),
        progress: { page: 1, cumulativeArticles: 1, isLastPage: true },
      };
    },
    meta: () => ({ totalHits: 1, retriesUsed: 0, latencyMsTotal: 1 }),
  };
}

const { collectAdapterSamples } = await import('../../src/lib/source-snapshot.js');

describe('collectAdapterSamples', () => {
  beforeEach(() => {
    paramsStore.length = 0;
    createAdapterMock.mockReset();
    resolveOpenSearchConfigMock.mockReset();
  });

  it('returns empty array when no chat_params row exists', async () => {
    const out = await collectAdapterSamples('user-a', 'chat-x');
    expect(out).toEqual([]);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('returns empty array when csv_upload and no uploadId', async () => {
    paramsStore.push({
      chatId: 'chat-1',
      userId: 'user-a',
      dataSource: 'csv_upload',
      uploadId: null,
    });
    const out = await collectAdapterSamples('user-a', 'chat-1');
    expect(out).toEqual([]);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('returns one snapshot when csv_upload + uploadId', async () => {
    paramsStore.push({
      chatId: 'chat-2',
      userId: 'user-a',
      dataSource: 'csv_upload',
      uploadId: 'upload-99',
    });
    createAdapterMock.mockReturnValueOnce(makeFakeAdapter('csv_upload'));
    const out = await collectAdapterSamples('user-a', 'chat-2');
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('csv_upload');
    expect(out[0]!.sourceId).toBe('chat-2:csv_upload');
    expect(out[0]!.sampleArticles).toHaveLength(1);
    expect(out[0]!.declaredCapabilities).toEqual(declaredCapabilities);
    expect(createAdapterMock).toHaveBeenCalledWith({
      kind: 'csv_upload',
      config: { uploadId: 'upload-99' },
    });
  });

  it('returns empty array when opensearch + no resolvable config', async () => {
    paramsStore.push({
      chatId: 'chat-3',
      userId: 'user-a',
      dataSource: 'opensearch',
      uploadId: null,
    });
    resolveOpenSearchConfigMock.mockResolvedValueOnce(null);
    const out = await collectAdapterSamples('user-a', 'chat-3');
    expect(out).toEqual([]);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('returns one snapshot when opensearch + resolvable config', async () => {
    paramsStore.push({
      chatId: 'chat-4',
      userId: 'user-a',
      dataSource: 'opensearch',
      uploadId: null,
    });
    const osConfig = { host: 'localhost', username: 'u', password: 'p' };
    resolveOpenSearchConfigMock.mockResolvedValueOnce(osConfig);
    createAdapterMock.mockReturnValueOnce(makeFakeAdapter('opensearch'));
    const out = await collectAdapterSamples('user-a', 'chat-4');
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('opensearch');
    expect(out[0]!.sourceId).toBe('chat-4:opensearch');
    expect(createAdapterMock).toHaveBeenCalledWith({
      kind: 'opensearch',
      config: osConfig,
    });
  });
});
