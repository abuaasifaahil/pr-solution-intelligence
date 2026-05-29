import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const mockMCP = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { mCPConnection: mockMCP, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_u, fn) => fn({ mCPConnection: mockMCP })),
  asAdmin: vi.fn(),
}));

const {
  listMCPConnections, createMCPConnection, updateMCPConnection,
  deleteMCPConnection, verifyMCPConnection,
} = await import('../../src/services/mcp.service.js');

describe('mcp.service', () => {
  beforeEach(() => Object.values(mockMCP).forEach((f) => f.mockReset()));

  it('createMCPConnection encrypts token + returns masked', async () => {
    mockMCP.create.mockImplementation(async ({ data }) => ({
      id: 'm1', userId: 'u1', status: 'inactive', availableTools: [],
      createdAt: new Date(), lastVerifiedAt: null, ...data,
    }));
    const out = await createMCPConnection('u1', {
      sourceName: 'JIRA', serverUrl: 'https://mcp.example.com', token: 't-secret',
    });
    expect(mockMCP.create.mock.calls[0]![0].data.tokenEncrypted).not.toBe('t-secret');
    expect(out.tokenEncrypted).toBe('***encrypted***');
  });

  it('verifyMCPConnection 200 OK → active + tools persisted', async () => {
    const { encrypt } = await import('../../src/lib/encryption.js');
    mockMCP.findFirst.mockResolvedValue({
      id: 'm1', userId: 'u1', sourceName: 'JIRA',
      serverUrl: 'https://mcp.example.com',
      tokenEncrypted: encrypt('t-secret'), status: 'inactive', availableTools: [],
    });
    mockMCP.update.mockResolvedValue({});
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tools: [{ name: 'createIssue' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const out = await verifyMCPConnection('u1', 'm1');
    expect(out.status).toBe('active');
    expect(out.availableTools).toEqual([{ name: 'createIssue' }]);
    const updateArg = mockMCP.update.mock.calls[0]![0];
    expect(updateArg.data.status).toBe('active');
    expect(JSON.stringify(out)).not.toContain('t-secret');
    fetchSpy.mockRestore();
  });

  it('verifyMCPConnection 401 → error status', async () => {
    const { encrypt } = await import('../../src/lib/encryption.js');
    mockMCP.findFirst.mockResolvedValue({
      id: 'm1', userId: 'u1', serverUrl: 'https://mcp.example.com',
      tokenEncrypted: encrypt('t'), status: 'inactive', availableTools: [],
    });
    mockMCP.update.mockResolvedValue({});
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    const out = await verifyMCPConnection('u1', 'm1');
    expect(out.status).toBe('error');
  });

  it('verifyMCPConnection network failure does not leak token', async () => {
    const { encrypt } = await import('../../src/lib/encryption.js');
    mockMCP.findFirst.mockResolvedValue({
      id: 'm1', userId: 'u1', serverUrl: 'https://mcp.example.com',
      tokenEncrypted: encrypt('leak-bait'), status: 'inactive', availableTools: [],
    });
    mockMCP.update.mockResolvedValue({});
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('boom leak-bait'));
    const out = await verifyMCPConnection('u1', 'm1');
    expect(out.status).toBe('error');
    expect(JSON.stringify(out)).not.toContain('leak-bait');
  });
});
