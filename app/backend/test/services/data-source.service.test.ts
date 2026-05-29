import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const mockDS = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { dataSource: mockDS, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_uid, fn) => fn({ dataSource: mockDS })),
  asAdmin: vi.fn(),
}));

const {
  listDataSources,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  testDataSource,
} = await import('../../src/services/data-source.service.js');

describe('data-source.service', () => {
  beforeEach(() => Object.values(mockDS).forEach((f) => f.mockReset()));

  it('createDataSource encrypts api_key and persists row', async () => {
    mockDS.create.mockImplementation(async ({ data }) => ({
      id: 'ds1', userId: 'u1', ...data, createdAt: new Date(),
    }));
    const out = await createDataSource('u1', {
      sourceType: 'meltwater',
      displayName: 'Meltwater Main',
      apiKey: 'sk-test-123',
      endpointUrl: 'https://api.meltwater.com',
    });
    const created = mockDS.create.mock.calls[0]![0].data;
    expect(created.apiKeyEncrypted).not.toBe('sk-test-123');
    expect(created.apiKeyEncrypted.split(':')).toHaveLength(3); // iv:tag:ct
    // Returned shape NEVER includes plaintext key.
    expect(out).not.toHaveProperty('apiKey');
    expect(out.apiKeyEncrypted).toBe('***encrypted***');
  });

  it('listDataSources masks api_key in response', async () => {
    mockDS.findMany.mockResolvedValue([
      { id: 'ds1', userId: 'u1', sourceType: 'meltwater', displayName: 'A',
        apiKeyEncrypted: 'iv:tag:ct', endpointUrl: null, config: {}, isActive: true,
        lastTestedAt: null, createdAt: new Date() },
    ]);
    const out = await listDataSources('u1');
    expect(out[0]!.apiKeyEncrypted).toBe('***encrypted***');
  });

  it('updateDataSource re-encrypts api_key when provided', async () => {
    mockDS.findFirst.mockResolvedValue({ id: 'ds1', userId: 'u1' });
    mockDS.update.mockImplementation(async ({ data }) => ({
      id: 'ds1', userId: 'u1', ...data, sourceType: 'meltwater',
      displayName: 'X', endpointUrl: null, config: {}, isActive: true,
      lastTestedAt: null, createdAt: new Date(),
    }));
    await updateDataSource('u1', 'ds1', { apiKey: 'new-key', displayName: 'X' });
    const patch = mockDS.update.mock.calls[0]![0].data;
    expect(patch.apiKeyEncrypted).toBeDefined();
    expect(patch.apiKeyEncrypted).not.toBe('new-key');
  });

  it('updateDataSource leaves api_key alone when not in body', async () => {
    mockDS.findFirst.mockResolvedValue({ id: 'ds1', userId: 'u1' });
    mockDS.update.mockResolvedValue({ id: 'ds1', userId: 'u1', sourceType: 'meltwater',
      displayName: 'New', apiKeyEncrypted: 'iv:tag:ct', endpointUrl: null,
      config: {}, isActive: true, lastTestedAt: null, createdAt: new Date() });
    await updateDataSource('u1', 'ds1', { displayName: 'New' });
    const patch = mockDS.update.mock.calls[0]![0].data;
    expect(patch).not.toHaveProperty('apiKeyEncrypted');
  });

  it('updateDataSource throws when row not owned by user', async () => {
    mockDS.findFirst.mockResolvedValue(null);
    await expect(
      updateDataSource('u1', 'dsX', { displayName: 'X' }),
    ).rejects.toThrow('Data source not found');
  });

  it('deleteDataSource hard-deletes', async () => {
    mockDS.findFirst.mockResolvedValue({ id: 'ds1', userId: 'u1' });
    mockDS.delete.mockResolvedValue({});
    await deleteDataSource('u1', 'ds1');
    expect(mockDS.delete).toHaveBeenCalledWith({ where: { id: 'ds1' } });
  });

  it('testDataSource for unsupported type returns ok=false without probing', async () => {
    mockDS.findFirst.mockResolvedValue({
      id: 'ds1', userId: 'u1', sourceType: 'custom',
      apiKeyEncrypted: '00000000000000000000000000:0000000000000000:00', // bogus; probe never decrypts
    });
    const fetchSpy = vi.spyOn(global, 'fetch');
    const out = await testDataSource('u1', 'ds1');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not supported/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('testDataSource for known type probes the health URL with the decrypted key', async () => {
    const { encrypt } = await import('../../src/lib/encryption.js');
    const apiKeyEncrypted = encrypt('sk-real-key');
    mockDS.findFirst.mockResolvedValue({
      id: 'ds1', userId: 'u1', sourceType: 'meltwater', apiKeyEncrypted,
    });
    mockDS.update.mockResolvedValue({});
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const out = await testDataSource('u1', 'ds1');
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0]!;
    // The Authorization header carries the decrypted key — but the result
    // returned to the caller does NOT.
    const hdrs = new Headers(init!.headers);
    expect(hdrs.get('Authorization')).toBe('Bearer sk-real-key');
    expect(JSON.stringify(out)).not.toContain('sk-real-key');
    fetchSpy.mockRestore();
  });

  it('testDataSource probe failure returns generic message (no key leak)', async () => {
    const { encrypt } = await import('../../src/lib/encryption.js');
    const apiKeyEncrypted = encrypt('sk-leak-bait');
    mockDS.findFirst.mockResolvedValue({
      id: 'ds1', userId: 'u1', sourceType: 'meltwater', apiKeyEncrypted,
    });
    mockDS.update.mockResolvedValue({});
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED sk-leak-bait'));
    const out = await testDataSource('u1', 'ds1');
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sk-leak-bait');
    fetchSpy.mockRestore();
  });
});
