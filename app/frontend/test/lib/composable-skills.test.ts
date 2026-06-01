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

const {
  listComposableSkills,
  createComposableSkill,
  updateComposableSkill,
  deleteComposableSkill,
  skillDisplayName,
  skillDescription,
} = await import('../../lib/composable-skills');

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

describe('lib/composable-skills — typed client', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listComposableSkills GETs /composable-skills with no query when no opts', async () => {
    const fetchMock = setupFetch({ success: true, data: [] });
    const rows = await listComposableSkills();
    expect(rows).toEqual([]);
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/composable-skills$/);
    expect(fetchMock.calls[0]?.init?.method).toBeUndefined();
  });

  it('listComposableSkills passes scope + kind + enabledOnly as query params', async () => {
    const fetchMock = setupFetch({ success: true, data: [] });
    await listComposableSkills({
      scope: 'first_party',
      kind: 'analysis_skill',
      enabledOnly: true,
    });
    const url = fetchMock.calls[0]?.url ?? '';
    expect(url).toContain('scope=first_party');
    expect(url).toContain('kind=analysis_skill');
    expect(url).toContain('enabledOnly=true');
  });

  it('createComposableSkill POSTs JSON body', async () => {
    const skill = {
      id: 's1', name: 'pr-impact', version: '1.0.0', kind: 'analysis_skill',
      manifest: { description: 'PR' }, scope: 'user_private', userId: 'u1',
      workspaceId: null, trustLevel: 'community', enabled: true,
      createdAt: '2026-06-01T00:00:00Z',
    };
    const fetchMock = setupFetch({ success: true, data: skill });
    const result = await createComposableSkill({
      name: 'pr-impact', kind: 'analysis_skill',
      manifest: { description: 'PR' }, scope: 'user_private',
    });
    expect(result.id).toBe('s1');
    expect(fetchMock.calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(fetchMock.calls[0]?.init?.body as string);
    expect(body.kind).toBe('analysis_skill');
    expect(body.scope).toBe('user_private');
  });

  it('updateComposableSkill PATCHes /composable-skills/:id', async () => {
    const fetchMock = setupFetch({
      success: true,
      data: { id: 's1', name: 'new', version: '1.0.0', kind: 'analysis_skill',
              manifest: {}, scope: 'user_private', userId: 'u1', workspaceId: null,
              trustLevel: 'community', enabled: true, createdAt: '2026-06-01T00:00:00Z' },
    });
    await updateComposableSkill('s1', { name: 'new' });
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/composable-skills\/s1$/);
    expect(fetchMock.calls[0]?.init?.method).toBe('PATCH');
  });

  it('deleteComposableSkill DELETEs /composable-skills/:id', async () => {
    // Backend returns 204 with empty body, but Response can't carry a body
    // at 204 — use 200 with a null payload in the test fixture (apiFetch's
    // unwrap accepts either shape).
    const fetchMock = setupFetch({ success: true, data: null });
    await deleteComposableSkill('s1');
    expect(fetchMock.calls[0]?.url).toMatch(/\/api\/v1\/composable-skills\/s1$/);
    expect(fetchMock.calls[0]?.init?.method).toBe('DELETE');
  });

  it('url-encodes the skill id', async () => {
    const fetchMock = setupFetch({ success: true, data: null });
    await deleteComposableSkill('weird/id');
    expect(fetchMock.calls[0]?.url).toMatch(/\/composable-skills\/weird%2Fid$/);
  });

  it('skillDisplayName falls back to row name when manifest has no displayName', () => {
    const skill = {
      id: 's1', name: 'pr-impact', version: '1.0.0', kind: 'analysis_skill' as const,
      manifest: {}, scope: 'first_party' as const, userId: null, workspaceId: null,
      trustLevel: 'first_party' as const, enabled: true,
      createdAt: '2026-06-01T00:00:00Z',
    };
    expect(skillDisplayName(skill)).toBe('pr-impact');
  });

  it('skillDisplayName prefers manifest.displayName when present', () => {
    const skill = {
      id: 's1', name: 'pr-impact', version: '1.0.0', kind: 'analysis_skill' as const,
      manifest: { displayName: 'PR Impact Analysis' }, scope: 'first_party' as const,
      userId: null, workspaceId: null, trustLevel: 'first_party' as const,
      enabled: true, createdAt: '2026-06-01T00:00:00Z',
    };
    expect(skillDisplayName(skill)).toBe('PR Impact Analysis');
  });

  it('skillDescription returns null when manifest has no description', () => {
    const skill = {
      id: 's1', name: 'x', version: '1.0.0', kind: 'analysis_skill' as const,
      manifest: {}, scope: 'first_party' as const, userId: null, workspaceId: null,
      trustLevel: 'first_party' as const, enabled: true,
      createdAt: '2026-06-01T00:00:00Z',
    };
    expect(skillDescription(skill)).toBeNull();
  });
});
