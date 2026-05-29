import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSkill = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
};
const mockUserSkill = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: { skill: mockSkill, userSkill: mockUserSkill, $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (_u, fn) => fn({ skill: mockSkill, userSkill: mockUserSkill })),
  asAdmin: vi.fn(async (fn) => fn({ skill: mockSkill, userSkill: mockUserSkill })),
}));

const { listSkillsForUser, createCustomSkill, toggleUserSkill } =
  await import('../../src/services/skill.service.js');

describe('skill.service', () => {
  beforeEach(() => {
    Object.values(mockSkill).forEach((f) => f.mockReset());
    Object.values(mockUserSkill).forEach((f) => f.mockReset());
  });

  it('listSkillsForUser merges default skills + user join rows; defaults always isEnabled=true', async () => {
    mockSkill.findMany.mockResolvedValue([
      { id: 's1', name: 'sentiment_analysis', description: 'd1', type: 'analysis', isDefault: true },
      { id: 's2', name: 'custom_foo',         description: 'd2', type: 'custom',   isDefault: false },
    ]);
    mockUserSkill.findMany.mockResolvedValue([
      { skillId: 's2', isEnabled: false },
    ]);
    const out = await listSkillsForUser('u1');
    const byName = Object.fromEntries(out.map((r) => [r.name, r]));
    expect(byName.sentiment_analysis!.isEnabled).toBe(true);  // default → forced on
    expect(byName.sentiment_analysis!.isDefault).toBe(true);
    expect(byName.custom_foo!.isEnabled).toBe(false);         // join row reflects state
  });

  it('createCustomSkill creates skill + user_skill enabled', async () => {
    mockSkill.create.mockResolvedValue({
      id: 's-new', name: 'my_skill', description: 'd', type: 'custom', isDefault: false,
    });
    mockUserSkill.create.mockResolvedValue({
      id: 'us-new', userId: 'u1', skillId: 's-new', isEnabled: true,
    });
    const out = await createCustomSkill('u1', {
      name: 'my_skill', description: 'd', type: 'custom', handlerConfig: {},
    });
    expect(mockSkill.create).toHaveBeenCalled();
    expect(mockUserSkill.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', skillId: 's-new', isEnabled: true }),
    }));
    expect(out.isEnabled).toBe(true);
  });

  it('toggleUserSkill rejects toggle on a default skill', async () => {
    mockSkill.findUnique.mockResolvedValue({
      id: 's1', name: 'sentiment_analysis', isDefault: true,
    });
    await expect(toggleUserSkill('u1', 's1', false))
      .rejects.toThrow(/default/i);
  });

  it('toggleUserSkill toggles a custom skill via upsert', async () => {
    mockSkill.findUnique.mockResolvedValue({ id: 's2', isDefault: false });
    mockUserSkill.upsert.mockResolvedValue({
      id: 'us', userId: 'u1', skillId: 's2', isEnabled: false,
    });
    const out = await toggleUserSkill('u1', 's2', false);
    expect(out.isEnabled).toBe(false);
    expect(mockUserSkill.upsert).toHaveBeenCalled();
  });

  it('toggleUserSkill throws on unknown skill id', async () => {
    mockSkill.findUnique.mockResolvedValue(null);
    await expect(toggleUserSkill('u1', 'sX', true)).rejects.toThrow(/not found/i);
  });
});
