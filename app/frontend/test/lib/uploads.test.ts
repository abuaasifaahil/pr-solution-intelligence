import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the typed client through a mocked global fetch. The auth-store is
// hit by apiFetch — we stub it to return a stable token so the request is
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

const { createUpload, getUpload, getUploadPreview, deleteUpload } = await import(
  '../../lib/uploads'
);

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
  // Attach calls so each assertion can reach them without re-typing the mock.
  Object.defineProperty(fn, 'calls', { get: () => calls });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('lib/uploads — typed client', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('createUpload posts FormData with file + chatId and no content-type header', async () => {
    const upload = {
      id: 'u1',
      filename: 'a.csv',
      mimeType: 'text/csv',
      sizeBytes: 12,
      rowCount: null,
      columnCount: null,
      schemaDetected: [],
      dateColumn: null,
      dateRangeStart: null,
      dateRangeEnd: null,
      status: 'uploading',
      errorMessage: null,
      parsedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const fetchMock = setupFetch({ success: true, data: { upload } });

    const file = new File(['a,b\n1,2'], 'a.csv', { type: 'text/csv' });
    const res = await createUpload(file, 'chat-1');
    expect(res.upload.id).toBe('u1');

    const call = fetchMock.calls[0]!;
    expect(call.url).toMatch(/\/api\/v1\/uploads$/);
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBeInstanceOf(FormData);

    const headers = call.init?.headers as Headers;
    // The browser fills in `content-type: multipart/form-data; boundary=...`
    // on the wire — apiFetch must NOT have stamped JSON onto it.
    expect(headers.get('content-type')).toBeNull();
    expect(headers.get('authorization')).toBe('Bearer tok');

    const fd = call.init!.body as FormData;
    expect(fd.get('chatId')).toBe('chat-1');
    expect(fd.get('file')).toBeInstanceOf(File);
  });

  it('getUpload GETs /api/v1/uploads/:id', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { upload: { id: 'u1', status: 'ready' } },
    });
    const res = await getUpload('u1');
    expect(res.upload.id).toBe('u1');
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/uploads\/u1$/);
    expect(fetchMock.calls[0]?.init?.method).toBeUndefined();
  });

  it('getUploadPreview passes the limit query', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { rows: [{ a: 1 }], columns: ['a'], total: 1 },
    });
    const res = await getUploadPreview('u1', 5);
    expect(res.total).toBe(1);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/uploads\/u1\/preview\?limit=5$/);
  });

  it('getUploadPreview defaults limit to 10', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { rows: [], columns: [], total: 0 },
    });
    await getUploadPreview('u1');
    expect(fetchMock.calls[0]?.url).toMatch(/\?limit=10$/);
  });

  it('deleteUpload issues DELETE', async () => {
    const fetchMock = setupFetch({ success: true, data: { message: 'Deleted' } });
    await deleteUpload('u1');
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/uploads\/u1$/);
    expect(fetchMock.calls[0]?.init?.method).toBe('DELETE');
  });
});
