import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUser = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
const mockSession = {
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    user: mockUser,
    session: mockSession,
    $disconnect: vi.fn(),
  },
}));

const { login, refresh, logout } = await import('../../src/services/auth.service.js');
const { verifyAccess } = await import('../../src/lib/jwt.js');

describe('auth.service.login', () => {
  beforeEach(() => {
    mockUser.findUnique.mockReset();
    mockSession.create.mockReset();
  });

  it('returns access + refresh tokens and user on valid credentials', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'kb@test.local',
      passwordHash: hash,
      displayName: 'KhadarBasha',
      role: 'analyst',
      isActive: true,
      deletedAt: null,
    });
    mockSession.create.mockResolvedValue({ id: 's1' });

    const result = await login({ email: 'kb@test.local', password: 'hunter2', ip: '127.0.0.1', userAgent: 'vitest' });

    expect(result.user.email).toBe('kb@test.local');
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    const payload = verifyAccess(result.accessToken);
    expect(payload.userId).toBe('u1');
  });

  it('throws "Invalid credentials" on wrong password', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: hash,
      displayName: 'KB', role: 'analyst', isActive: true, deletedAt: null,
    });
    await expect(
      login({ email: 'kb@test.local', password: 'WRONG', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws "Invalid credentials" on unknown email (no enumeration)', async () => {
    mockUser.findUnique.mockResolvedValue(null);
    await expect(
      login({ email: 'ghost@test.local', password: 'whatever', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws on disabled (isActive=false) user', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: hash,
      displayName: 'KB', role: 'analyst', isActive: false, deletedAt: null,
    });
    await expect(
      login({ email: 'kb@test.local', password: 'hunter2', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow();
  });
});

describe('auth.service.refresh', () => {
  beforeEach(() => {
    mockSession.findFirst.mockReset();
    mockSession.findMany.mockReset();
    mockSession.update.mockReset();
    mockSession.create.mockReset();
    mockUser.findUnique.mockReset();
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const refreshPlain = 'a'.repeat(64);
    const refreshHash = await hashPassword(refreshPlain);

    mockSession.findMany.mockResolvedValue([
      {
        id: 's1', userId: 'u1', tokenHash: refreshHash,
        expiresAt: new Date(Date.now() + 1_000_000), isActive: true,
      },
    ]);
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: 'irrelevant',
      displayName: 'KB', role: 'analyst', isActive: true, deletedAt: null,
    });
    mockSession.update.mockResolvedValue({ id: 's1', isActive: false });
    mockSession.create.mockResolvedValue({ id: 's2' });

    const result = await refresh({ refreshToken: refreshPlain, ip: '127.0.0.1', userAgent: 'vitest' });
    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
    expect(result.refreshToken).not.toBe(refreshPlain);
    expect(mockSession.update).toHaveBeenCalled();
  });

  it('throws on expired refresh token', async () => {
    mockSession.findMany.mockResolvedValue([]);
    await expect(
      refresh({ refreshToken: 'b'.repeat(64), ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow();
  });
});

describe('auth.service.logout', () => {
  it('marks the session inactive', async () => {
    mockSession.update.mockResolvedValue({ id: 's1', isActive: false });
    await logout('s1');
    expect(mockSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { isActive: false },
    });
  });
});
