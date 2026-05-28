import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@prsi/shared/db';
import { withUser } from '../../src/lib/prisma-rls.js';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';

const A_EMAIL = 'rls-a@test.local';
const B_EMAIL = 'rls-b@test.local';

describe('RLS isolation between users', () => {
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    // Cleanup any leftovers from prior runs.
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.session.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });

    // Create A + B + 1 chat each.
    const a = await prisma.user.create({
      data: { email: A_EMAIL, passwordHash: await hashPassword('x'), displayName: 'A', role: 'analyst' },
    });
    const b = await prisma.user.create({
      data: { email: B_EMAIL, passwordHash: await hashPassword('x'), displayName: 'B', role: 'analyst' },
    });
    aId = a.id;
    bId = b.id;
    await prisma.chat.create({ data: { userId: aId, agentType: 'pr_impact', title: 'A chat' } });
    await prisma.chat.create({ data: { userId: bId, agentType: 'pr_impact', title: 'B chat' } });
  });

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });
    await closeRedis();
    await prisma.$disconnect();
  });

  it('user A only sees their own chat', async () => {
    const aChats = await withUser(aId, (tx) => tx.chat.findMany());
    expect(aChats).toHaveLength(1);
    expect(aChats[0]?.title).toBe('A chat');
  });

  it('user B only sees their own chat', async () => {
    const bChats = await withUser(bId, (tx) => tx.chat.findMany());
    expect(bChats).toHaveLength(1);
    expect(bChats[0]?.title).toBe('B chat');
  });

  it('user A cannot SELECT user B\'s row by id', async () => {
    const found = await withUser(aId, (tx) => tx.chat.findFirst({ where: { user: { email: B_EMAIL } } }));
    expect(found).toBeNull();
  });

  it('user A cannot UPDATE user B\'s row', async () => {
    await expect(
      withUser(aId, (tx) =>
        tx.chat.updateMany({
          where: { user: { email: B_EMAIL } },
          data: { title: 'hijacked' },
        }),
      ),
    ).resolves.toHaveProperty('count', 0);
  });
});
