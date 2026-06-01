/**
 * Phase 2 (M7.1) — RLS isolation test for the 4 new tables.
 *
 * Mirrors the M2 pattern in test/rls/rls.integration.test.ts: Alice creates
 * one row per Phase 2 table, then Bob (via withUser(bobId, …)) reads the
 * same tables and MUST get empty results. RLS — not app-side filters —
 * is what enforces isolation.
 *
 * Requires a live Postgres. Falls back to the docker-compose dev URL so
 * `pnpm test` works without manually exporting DATABASE_URL.
 */
process.env.DATABASE_URL ??= 'postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@prsi/shared/db';
import { withUser } from '../../src/lib/prisma-rls.js';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';

const A_EMAIL = 'phase2-rls-a@test.local';
const B_EMAIL = 'phase2-rls-b@test.local';

describe('Phase 2 RLS isolation between users', () => {
  let aId: string;
  let bId: string;
  let aChatId: string;
  let bChatId: string;
  let aUploadId: string;
  let aChatParamsId: string;

  beforeAll(async () => {
    // Cleanup any leftovers from prior runs. Cascade deletes will also drop
    // any phase-2 rows owned by these users.
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.session.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });

    const a = await prisma.user.create({
      data: { email: A_EMAIL, passwordHash: await hashPassword('x'), displayName: 'A', role: 'analyst' },
    });
    const b = await prisma.user.create({
      data: { email: B_EMAIL, passwordHash: await hashPassword('x'), displayName: 'B', role: 'analyst' },
    });
    aId = a.id;
    bId = b.id;

    const aChat = await prisma.chat.create({
      data: { userId: aId, agentType: 'pr_impact', title: 'Alice chat' },
    });
    const bChat = await prisma.chat.create({
      data: { userId: bId, agentType: 'pr_impact', title: 'Bob chat' },
    });
    aChatId = aChat.id;
    bChatId = bChat.id;

    // Create one row per Phase 2 table owned by Alice, all inside a single
    // withUser(aId) transaction so RLS policies see the right user_id.
    await withUser(aId, async (tx) => {
      const upload = await tx.upload.create({
        data: {
          userId: aId,
          chatId: aChatId,
          filename: 'alice.csv',
          mimeType: 'text/csv',
          filePath: 's3://bucket/alice.csv',
          sizeBytes: BigInt(1024),
          status: 'ready',
        },
      });
      aUploadId = upload.id;

      const params = await tx.chatParams.create({
        data: {
          chatId: aChatId,
          userId: aId,
          flowState: 'collect_brand',
          hasUpload: true,
          uploadId: aUploadId,
        },
      });
      aChatParamsId = params.id;

      await tx.article.create({
        data: {
          uploadId: aUploadId,
          chatId: aChatId,
          userId: aId,
          title: 'Alice article',
          publisherDomain: 'example.com',
        },
      });

      await tx.booleanQuery.create({
        data: {
          chatId: aChatId,
          chatParamsId: aChatParamsId,
          queryText: '(Alice) AND ("brand")',
          queryStructured: { brand: 'Alice', competitors: [], fields: ['title'], language: 'en' },
        },
      });
    });
  });

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });
    await closeRedis();
    await prisma.$disconnect();
  });

  it('Alice sees her own uploads', async () => {
    const rows = await withUser(aId, (tx) => tx.upload.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe('alice.csv');
  });

  it('Bob cannot see Alice uploads', async () => {
    const rows = await withUser(bId, (tx) => tx.upload.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Alice sees her own articles', async () => {
    const rows = await withUser(aId, (tx) => tx.article.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Alice article');
  });

  it('Bob cannot see Alice articles', async () => {
    const rows = await withUser(bId, (tx) => tx.article.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Alice sees her own chat_params', async () => {
    const rows = await withUser(aId, (tx) => tx.chatParams.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flowState).toBe('collect_brand');
  });

  it('Bob cannot see Alice chat_params', async () => {
    const rows = await withUser(bId, (tx) => tx.chatParams.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Alice sees her own boolean_queries (scoped via chats.user_id)', async () => {
    const rows = await withUser(aId, (tx) => tx.booleanQuery.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queryText).toContain('Alice');
  });

  it('Bob cannot see Alice boolean_queries', async () => {
    const rows = await withUser(bId, (tx) => tx.booleanQuery.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Bob cannot UPDATE Alice uploads via updateMany (WITH CHECK blocks)', async () => {
    const res = await withUser(bId, (tx) =>
      tx.upload.updateMany({ where: { id: aUploadId }, data: { filename: 'hijacked.csv' } }),
    );
    expect(res.count).toBe(0);
  });

  it('Bob cannot UPDATE Alice articles', async () => {
    const res = await withUser(bId, (tx) =>
      tx.article.updateMany({ where: { chatId: aChatId }, data: { title: 'hijacked' } }),
    );
    expect(res.count).toBe(0);
  });
});
