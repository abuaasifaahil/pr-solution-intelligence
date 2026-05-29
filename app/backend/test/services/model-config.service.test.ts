import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const mockLLM = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { lLMConfig: mockLLM, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_u, fn) => fn({ lLMConfig: mockLLM })),
  asAdmin: vi.fn(),
}));

const { getDefaultModelConfig, upsertDefaultModelConfig } =
  await import('../../src/services/model-config.service.js');

describe('model-config.service', () => {
  beforeEach(() => Object.values(mockLLM).forEach((f) => f.mockReset()));

  it('getDefaultModelConfig returns masked row or null', async () => {
    mockLLM.findFirst.mockResolvedValue(null);
    expect(await getDefaultModelConfig('u1')).toBeNull();

    mockLLM.findFirst.mockResolvedValue({
      id: 'c1', userId: 'u1', provider: 'gpt', modelName: 'gpt-4.1',
      apiKeyEncrypted: 'iv:tag:ct', maxTokens: 4096, temperature: 0.3,
      isDefault: true, createdAt: new Date(),
    });
    const out = await getDefaultModelConfig('u1');
    expect(out?.apiKeyEncrypted).toBe('***encrypted***');
  });

  it('upsertDefaultModelConfig creates a new row on first call', async () => {
    mockLLM.findFirst.mockResolvedValue(null);
    mockLLM.updateMany.mockResolvedValue({ count: 0 });
    mockLLM.create.mockImplementation(async ({ data }) => ({
      id: 'new', ...data, createdAt: new Date(),
    }));
    const out = await upsertDefaultModelConfig('u1', {
      provider: 'claude', modelName: 'claude-3-5-sonnet',
      apiKey: 'sk-ant', maxTokens: 8000, temperature: 0.5,
    });
    expect(mockLLM.create).toHaveBeenCalled();
    const data = mockLLM.create.mock.calls[0]![0].data;
    expect(data.apiKeyEncrypted).not.toBe('sk-ant');
    expect(data.isDefault).toBe(true);
    expect(out.apiKeyEncrypted).toBe('***encrypted***');
  });

  it('upsertDefaultModelConfig updates existing default row, re-encrypts only if apiKey provided', async () => {
    mockLLM.findFirst.mockResolvedValue({
      id: 'c1', userId: 'u1', provider: 'gpt', modelName: 'gpt-4.1',
      apiKeyEncrypted: 'iv:tag:old', maxTokens: 4096, temperature: 0.3, isDefault: true,
    });
    mockLLM.updateMany.mockResolvedValue({ count: 0 });
    mockLLM.update.mockImplementation(async ({ data }) => ({
      id: 'c1', userId: 'u1', provider: 'gpt', modelName: 'gpt-4.1',
      apiKeyEncrypted: data.apiKeyEncrypted ?? 'iv:tag:old',
      maxTokens: 8000, temperature: 0.7, isDefault: true, createdAt: new Date(),
      ...data,
    }));
    // No apiKey → ciphertext unchanged.
    await upsertDefaultModelConfig('u1', {
      provider: 'gpt', modelName: 'gpt-4.1', maxTokens: 8000, temperature: 0.7,
    });
    expect(mockLLM.update.mock.calls[0]![0].data.apiKeyEncrypted).toBeUndefined();
  });

  it('upsertDefaultModelConfig clears is_default on the user\'s other rows', async () => {
    mockLLM.findFirst.mockResolvedValue(null);
    mockLLM.updateMany.mockResolvedValue({ count: 1 });
    mockLLM.create.mockResolvedValue({
      id: 'new', userId: 'u1', provider: 'claude', modelName: 'c', apiKeyEncrypted: 'iv:tag:ct',
      maxTokens: 4096, temperature: 0.3, isDefault: true, createdAt: new Date(),
    });
    await upsertDefaultModelConfig('u1', {
      provider: 'claude', modelName: 'c', apiKey: 'k', maxTokens: 4096, temperature: 0.3,
    });
    expect(mockLLM.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  });

  it('rejects temperature out of range', async () => {
    await expect(upsertDefaultModelConfig('u1', {
      provider: 'gpt', modelName: 'g', apiKey: 'k', maxTokens: 4096, temperature: 5,
    })).rejects.toThrow();
  });
});
