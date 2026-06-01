import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'tok',
      refreshToken: 'r',
      clear: vi.fn(),
      setTokens: vi.fn(),
    }),
  },
}));

const { getProbe, resolveProbes } = await import('../../lib/probe');

interface MockFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

function setupFetch(responseBody: unknown, status = 200): MockFetch {
  const calls: MockFetch['calls'] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as MockFetch;
  Object.defineProperty(fn, 'calls', { get: () => calls });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('lib/probe — typed client', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('getProbe GETs /chats/:id/probe', async () => {
    const probingResult = {
      inferred: { brand: 'FreshSip' },
      confidence: { brand: 0.8 },
      probes: [],
      rationale: 'top mention',
      perSourceStats: [],
    };
    const fetchMock = setupFetch({ success: true, data: probingResult });
    const r = await getProbe('c1');
    expect(r.inferred.brand).toBe('FreshSip');
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/probe$/);
    expect(fetchMock.calls[0]?.init?.method).toBeUndefined();
  });

  it('resolveProbes POSTs the resolutions array', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: {
        updatedParams: { chatId: 'c1', brand: 'FreshSip' },
        remainingProbes: [],
      },
    });
    const res = await resolveProbes('c1', [
      { field: 'brand', value: 'FreshSip' },
    ]);
    expect(res.remainingProbes).toEqual([]);
    const call = fetchMock.calls[0];
    expect(call?.url).toMatch(/\/api\/v1\/chats\/c1\/probe\/resolve$/);
    expect(call?.init?.method).toBe('POST');
    const body = JSON.parse(call?.init?.body as string);
    expect(body.resolutions).toEqual([{ field: 'brand', value: 'FreshSip' }]);
  });

  it('resolveProbes carries multiple resolutions in one call', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: {
        updatedParams: { chatId: 'c1' },
        remainingProbes: [{
          field: 'enrichmentType',
          question: 'Which level?',
          chips: [{ value: 'enrichment', label: 'Enrichment' }],
          allowFreeText: false,
          rationale: '',
        }],
      },
    });
    const res = await resolveProbes('c1', [
      { field: 'brand', value: 'X' },
      { field: 'competitors', value: ['A', 'B'] },
      { field: 'dateRange', value: { start: '2026-04-01', end: '2026-05-01' } },
    ]);
    expect(res.remainingProbes.length).toBe(1);
    const body = JSON.parse(fetchMock.calls[0]?.init?.body as string);
    expect(body.resolutions).toHaveLength(3);
  });

  it('url-encodes the chat id', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { inferred: {}, confidence: {}, probes: [], rationale: '', perSourceStats: [] },
    });
    await getProbe('weird/id');
    expect(fetchMock.calls[0]?.url).toMatch(/\/chats\/weird%2Fid\/probe$/);
  });
});
