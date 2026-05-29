import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// In-memory skill store + user_skill join map.
type SkillRow = {
  id: string;
  name: string;
  description: string;
  type: string;
  handlerConfig: object;
  isDefault: boolean;
  isActive: boolean;
};
type UserSkillRow = {
  id: string;
  userId: string;
  skillId: string;
  isEnabled: boolean;
};

const skills: SkillRow[] = [];
const userSkills: UserSkillRow[] = [];
let userIdCtx = '';
let skillSeq = 0;
let userSkillSeq = 0;

const DEFAULT_SKILLS: Omit<SkillRow, 'id'>[] = [
  { name: 'sentiment_analysis',   description: 'Sentiment',  type: 'analysis',    handlerConfig: {}, isDefault: true, isActive: true },
  { name: 'theme_classification', description: 'Themes',     type: 'analysis',    handlerConfig: {}, isDefault: true, isActive: true },
  { name: 'emotion_detection',    description: 'Emotion',    type: 'analysis',    handlerConfig: {}, isDefault: true, isActive: true },
  { name: 'entity_extraction',    description: 'Entities',   type: 'extraction',  handlerConfig: {}, isDefault: true, isActive: true },
  { name: 'signal_detection',     description: 'Signals',    type: 'detection',   handlerConfig: {}, isDefault: true, isActive: true },
  { name: 'reach_analysis',       description: 'Reach',      type: 'measurement', handlerConfig: {}, isDefault: true, isActive: true },
];

function seedDefaults(): void {
  skills.length = 0;
  userSkills.length = 0;
  skillSeq = 0;
  userSkillSeq = 0;
  for (const d of DEFAULT_SKILLS) {
    skills.push({ id: `sk-${++skillSeq}`, ...d });
  }
}

const skillMock = {
  findMany: vi.fn(async ({ where, orderBy: _orderBy }: { where?: { isActive?: boolean }; orderBy?: unknown } = {}) => {
    let out = skills.slice();
    if (where?.isActive !== undefined) out = out.filter((s) => s.isActive === where.isActive);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.map((s) => ({ ...s }));
  }),
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
    return skills.find((s) => s.id === where.id) ?? null;
  }),
  create: vi.fn(async ({ data }: { data: Omit<SkillRow, 'id'> }) => {
    const row: SkillRow = { id: `sk-${++skillSeq}`, ...data } as SkillRow;
    skills.push(row);
    return { ...row };
  }),
};

const userSkillMock = {
  findMany: vi.fn(async ({ select: _select }: { where?: object; select?: object } = {}) => {
    return userSkills
      .filter((r) => r.userId === userIdCtx)
      .map((r) => ({ skillId: r.skillId, isEnabled: r.isEnabled }));
  }),
  create: vi.fn(async ({ data }: { data: { userId: string; skillId: string; isEnabled: boolean } }) => {
    const row: UserSkillRow = {
      id: `us-${++userSkillSeq}`,
      ...data,
    };
    userSkills.push(row);
    return { ...row };
  }),
  upsert: vi.fn(async ({
    where, update, create,
  }: {
    where: { userId_skillId: { userId: string; skillId: string } };
    update: { isEnabled: boolean };
    create: { userId: string; skillId: string; isEnabled: boolean };
  }) => {
    const { userId, skillId } = where.userId_skillId;
    const existing = userSkills.find((r) => r.userId === userId && r.skillId === skillId);
    if (existing) {
      existing.isEnabled = update.isEnabled;
      return { ...existing };
    }
    const row: UserSkillRow = {
      id: `us-${++userSkillSeq}`,
      ...create,
    };
    userSkills.push(row);
    return { ...row };
  }),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    skill: skillMock,
    userSkill: userSkillMock,
  },
}));
vi.mock('../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(async (uid: string, fn: (tx: unknown) => Promise<unknown>) => {
    userIdCtx = uid;
    try { return await fn({ skill: skillMock, userSkill: userSkillMock }); }
    finally { userIdCtx = ''; }
  }),
  asAdmin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ skill: skillMock, userSkill: userSkillMock }),
  ),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const tokenA = signAccess({ userId: 'user-a', email: 'a@test.local', role: 'analyst', sessionId: 's' });
const tokenB = signAccess({ userId: 'user-b', email: 'b@test.local', role: 'analyst', sessionId: 's' });

describe('Skill routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { seedDefaults(); });

  it('GET as Alice returns 6 default skills all enabled and locked', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.skills).toHaveLength(6);
    for (const s of body.data.skills) {
      expect(s.isDefault).toBe(true);
      expect(s.isEnabled).toBe(true);
    }
  });

  it('POST creates a custom skill; subsequent GET returns 7 skills with the new one enabled', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'my_custom_skill', description: 'mine', type: 'custom' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().data.skill.isDefault).toBe(false);
    expect(create.json().data.skill.isEnabled).toBe(true);

    const list = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.skills as Array<{ name: string; isDefault: boolean; isEnabled: boolean }>;
    expect(items).toHaveLength(7);
    const mine = items.find((s) => s.name === 'my_custom_skill')!;
    expect(mine.isDefault).toBe(false);
    expect(mine.isEnabled).toBe(true);
  });

  it('PATCH on a default skill returns 400 "Default skills cannot be toggled"', async () => {
    // Pick the first default skill.
    const list = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const defaultSkill = list.json().data.skills[0];
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/settings/skills/${defaultSkill.skillId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { isEnabled: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/default/i);
  });

  it('PATCH on a custom skill toggles isEnabled; GET reflects the new value', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'toggler', description: 'd', type: 'custom' },
    });
    const id = created.json().data.skill.skillId as string;

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/settings/skills/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { isEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.skill.isEnabled).toBe(false);

    const list = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const mine = (list.json().data.skills as Array<{ skillId: string; isEnabled: boolean }>)
      .find((s) => s.skillId === id)!;
    expect(mine.isEnabled).toBe(false);
  });

  it('RLS: Alice toggling a custom skill does not leak state to Bob', async () => {
    // Alice creates a custom skill (enabled by default).
    const created = await app.inject({
      method: 'POST', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'alice_only', description: 'd', type: 'custom' },
    });
    const id = created.json().data.skill.skillId as string;

    // Bob lists — the global skill row exists but Bob has no user_skills row,
    // so isEnabled must default to false for him.
    const bobList = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const fromBob = (bobList.json().data.skills as Array<{ skillId: string; isEnabled: boolean; isDefault: boolean }>)
      .find((s) => s.skillId === id)!;
    expect(fromBob.isDefault).toBe(false);
    expect(fromBob.isEnabled).toBe(false);

    // Alice still sees it as enabled.
    const aliceList = await app.inject({
      method: 'GET', url: '/api/v1/settings/skills',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const fromAlice = (aliceList.json().data.skills as Array<{ skillId: string; isEnabled: boolean }>)
      .find((s) => s.skillId === id)!;
    expect(fromAlice.isEnabled).toBe(true);
  });
});
