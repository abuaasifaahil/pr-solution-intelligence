/**
 * Phase 3 (M8.1) — RLS isolation test for the 4 new enrichment tables.
 *
 * Mirrors the M2 / Phase 2 pattern: Alice creates one row per table, then Bob
 * (via withUser(bobId, …)) reads the same tables and MUST get empty results
 * for the 3 user-scoped tables (enrichments, enrichment_jobs, enrichment_batches).
 *
 * The `reach_cache` table is INTENTIONALLY GLOBAL — domain reach metrics are
 * public data shared across all users. This test verifies that divergence is
 * deliberate: both Alice and Bob see the same reach_cache row.
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

const A_EMAIL = 'phase3-rls-a@test.local';
const B_EMAIL = 'phase3-rls-b@test.local';
const CACHE_DOMAIN_A = 'phase3-rls-test-a.example.com';
const CACHE_DOMAIN_B = 'phase3-rls-test-b.example.com';

describe('Phase 3 RLS isolation between users', () => {
  let aId: string;
  let bId: string;
  let aChatId: string;
  let aArticleId: string;
  let aJobId: string;
  let aBatchId: string;
  let aEnrichmentId: string;

  beforeAll(async () => {
    // Cleanup any leftovers from prior runs. Cascade deletes will also drop
    // any phase-3 rows owned by these users.
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.session.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });
    await prisma.reachCache.deleteMany({
      where: { domain: { in: [CACHE_DOMAIN_A, CACHE_DOMAIN_B] } },
    });

    const a = await prisma.user.create({
      data: {
        email: A_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'A',
        role: 'analyst',
      },
    });
    const b = await prisma.user.create({
      data: {
        email: B_EMAIL,
        passwordHash: await hashPassword('x'),
        displayName: 'B',
        role: 'analyst',
      },
    });
    aId = a.id;
    bId = b.id;

    const aChat = await prisma.chat.create({
      data: { userId: aId, agentType: 'pr_impact', title: 'Alice phase3 chat' },
    });
    aChatId = aChat.id;

    // Create one row per Phase 3 user-scoped table owned by Alice, all inside a
    // single withUser(aId) transaction so RLS policies see the right user_id.
    await withUser(aId, async (tx) => {
      const article = await tx.article.create({
        data: {
          chatId: aChatId,
          userId: aId,
          title: 'Alice article for enrichment',
          publisherDomain: 'example.com',
        },
      });
      aArticleId = article.id;

      const job = await tx.enrichmentJob.create({
        data: {
          chatId: aChatId,
          userId: aId,
          totalArticles: 1,
          batchCount: 1,
          modelUsed: 'gpt-4.1',
          enrichmentType: 'standard',
        },
      });
      aJobId = job.id;

      const batch = await tx.enrichmentBatch.create({
        data: {
          jobId: aJobId,
          batchNumber: 1,
          articleIds: [aArticleId],
          estimatedTokens: 1000,
        },
      });
      aBatchId = batch.id;

      const enrichment = await tx.enrichment.create({
        data: {
          articleId: aArticleId,
          chatId: aChatId,
          userId: aId,
          batchId: aBatchId,
          sentiment: { label: 'positive', confidence: 0.9, reason: 'test' },
          themes: [{ level: 'main', name: 'tech', confidence: 0.8, reason: 'test' }],
          emotion: { label: 'joy', intensity: 0.7 },
          entities: [{ type: 'company', name: 'Alice Corp', mentions: 1 }],
          signals: [],
          modelUsed: 'gpt-4.1',
          tokensInput: 500,
          tokensOutput: 200,
          processingMs: 1234,
        },
      });
      aEnrichmentId = enrichment.id;
    });

    // Seed reach_cache with a row created by Alice. Since reach_cache is
    // global (no RLS), Bob should be able to read this too.
    await withUser(aId, async (tx) => {
      await tx.reachCache.create({
        data: {
          domain: CACHE_DOMAIN_A,
          monthlyVisitors: BigInt(1_000_000),
          globalRank: 500,
          category: 'news',
          score: 85,
          rawResponse: { source: 'test' },
        },
      });
    });
  });

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });
    await prisma.reachCache.deleteMany({
      where: { domain: { in: [CACHE_DOMAIN_A, CACHE_DOMAIN_B] } },
    });
    await closeRedis();
    await prisma.$disconnect();
  });

  // ─── 3 user-scoped tables: RLS must isolate ───────────────────────────

  it('Alice sees her own enrichments', async () => {
    const rows = await withUser(aId, (tx) =>
      tx.enrichment.findMany({ where: { id: aEnrichmentId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modelUsed).toBe('gpt-4.1');
  });

  it('Bob cannot see Alice enrichments (Prisma findMany)', async () => {
    const rows = await withUser(bId, (tx) => tx.enrichment.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Bob cannot see Alice enrichments (raw SELECT)', async () => {
    const rows = await withUser(bId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM enrichments WHERE id = '${aEnrichmentId}'::uuid`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('Alice sees her own enrichment_jobs', async () => {
    const rows = await withUser(aId, (tx) =>
      tx.enrichmentJob.findMany({ where: { id: aJobId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enrichmentType).toBe('standard');
  });

  it('Bob cannot see Alice enrichment_jobs', async () => {
    const rows = await withUser(bId, (tx) => tx.enrichmentJob.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Alice sees her own enrichment_batches', async () => {
    const rows = await withUser(aId, (tx) =>
      tx.enrichmentBatch.findMany({ where: { id: aBatchId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.batchNumber).toBe(1);
  });

  it('Bob cannot see Alice enrichment_batches (scoped via enrichment_jobs.user_id)', async () => {
    const rows = await withUser(bId, (tx) => tx.enrichmentBatch.findMany());
    expect(rows).toHaveLength(0);
  });

  it('Bob cannot UPDATE Alice enrichments via updateMany (WITH CHECK blocks)', async () => {
    const res = await withUser(bId, (tx) =>
      tx.enrichment.updateMany({
        where: { id: aEnrichmentId },
        data: { modelUsed: 'hijacked' },
      }),
    );
    expect(res.count).toBe(0);

    // Confirm Alice's row is untouched.
    const aRow = await withUser(aId, (tx) =>
      tx.enrichment.findUnique({ where: { id: aEnrichmentId } }),
    );
    expect(aRow?.modelUsed).toBe('gpt-4.1');
  });

  // ─── reach_cache: INTENTIONALLY GLOBAL (no RLS) ──────────────────────

  it('reach_cache is GLOBAL: both Alice and Bob can read the same row', async () => {
    const aRows = await withUser(aId, (tx) =>
      tx.reachCache.findMany({ where: { domain: CACHE_DOMAIN_A } }),
    );
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.score).toBe(85);

    const bRows = await withUser(bId, (tx) =>
      tx.reachCache.findMany({ where: { domain: CACHE_DOMAIN_A } }),
    );
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.id).toBe(aRows[0]?.id);
    expect(bRows[0]?.score).toBe(85);
  });

  it('reach_cache: Bob can INSERT a new domain row; Alice can read it', async () => {
    await withUser(bId, (tx) =>
      tx.reachCache.create({
        data: {
          domain: CACHE_DOMAIN_B,
          monthlyVisitors: BigInt(2_000_000),
          score: 92,
          rawResponse: { source: 'bob-test' },
        },
      }),
    );

    const aRows = await withUser(aId, (tx) =>
      tx.reachCache.findMany({ where: { domain: CACHE_DOMAIN_B } }),
    );
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.score).toBe(92);
  });
});
