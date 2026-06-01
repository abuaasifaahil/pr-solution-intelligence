import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the typed client through a mocked global fetch. The auth-store is
// hit by apiFetch — we stub it to return a stable token so each request is
// reproducible.
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

const {
  enrichChat,
  getEnrichStatus,
  getEnrichResult,
  getEnrichJson,
  getEnrichSummary,
  triggerReachFetch,
  retryFailedBatches,
} = await import('../../lib/enrichment');

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

describe('lib/enrichment — typed client', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('enrichChat POSTs /enrich with no body when no enrichmentType', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { jobId: null, message: 'queued', enrichmentType: 'standard' },
    });
    const res = await enrichChat('c1');
    expect(res.message).toBe('queued');
    const call = fetchMock.calls[0]!;
    expect(call.url).toMatch(/\/api\/v1\/chats\/c1\/enrich$/);
    expect(call.init?.method).toBe('POST');
    // We always send a JSON body so apiFetch attaches the content-type header.
    const headers = call.init?.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
    expect(call.init?.body).toBe(JSON.stringify({}));
  });

  it('enrichChat includes enrichmentType in the JSON body when supplied', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { jobId: null, message: 'queued', enrichmentType: 'reach' },
    });
    await enrichChat('c1', 'reach');
    const body = fetchMock.calls[0]?.init?.body;
    expect(JSON.parse(body as string)).toEqual({ enrichmentType: 'reach' });
  });

  it('getEnrichStatus GETs /enrich/status', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: {
        job: null,
        batches: [],
        progress: { processed: 0, total: 0, percent: 0 },
      },
    });
    const res = await getEnrichStatus('c1');
    expect(res.job).toBeNull();
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/enrich\/status$/);
    expect(fetchMock.calls[0]?.init?.method).toBeUndefined();
  });

  it('getEnrichResult passes page + pageSize query params', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { articles: [], page: 2, pageSize: 25, total: 0 },
    });
    await getEnrichResult('c1', 2, 25);
    expect(fetchMock.calls[0]?.url).toMatch(
      /\/api\/v1\/chats\/c1\/enrich\/result\?page=2&pageSize=25$/,
    );
  });

  it('getEnrichResult defaults page=1 + pageSize=50', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { articles: [], page: 1, pageSize: 50, total: 0 },
    });
    await getEnrichResult('c1');
    expect(fetchMock.calls[0]?.url).toMatch(/\?page=1&pageSize=50$/);
  });

  it('getEnrichJson GETs /enrich/json', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { dashboard: { chatId: 'c1', jobId: 'j1' }, cached: true },
    });
    const res = await getEnrichJson('c1');
    expect(res.cached).toBe(true);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/enrich\/json$/);
  });

  it('getEnrichSummary GETs /enrich/summary', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: {
        totalArticles: 0,
        sentimentDistribution: { positive: 0, neutral: 0, negative: 0 },
        topThemes: [],
        topEntities: [],
        topSignals: [],
      },
    });
    const res = await getEnrichSummary('c1');
    expect(res.totalArticles).toBe(0);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/enrich\/summary$/);
  });

  it('triggerReachFetch POSTs /reach/fetch', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { jobId: 'reach-1', domains: 12 },
    });
    const res = await triggerReachFetch('c1');
    expect(res.jobId).toBe('reach-1');
    expect(res.domains).toBe(12);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/reach\/fetch$/);
    expect(fetchMock.calls[0]?.init?.method).toBe('POST');
  });

  it('retryFailedBatches POSTs /enrich/retry', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { retriedBatches: 2 },
    });
    const res = await retryFailedBatches('c1');
    expect(res.retriedBatches).toBe(2);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/chats\/c1\/enrich\/retry$/);
    expect(fetchMock.calls[0]?.init?.method).toBe('POST');
  });

  it('url-encodes the chat id', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { job: null, batches: [], progress: { processed: 0, total: 0, percent: 0 } },
    });
    await getEnrichStatus('weird/id');
    expect(fetchMock.calls[0]?.url).toMatch(/\/chats\/weird%2Fid\/enrich\/status$/);
  });
});
