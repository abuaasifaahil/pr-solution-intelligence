import { prisma } from '@prsi/shared/db';
import type { Prisma } from '@prsi/shared/db';

/**
 * Run a callback inside a transaction with the Postgres session var
 * `app.user_id` set to the given user id, so RLS policies scope all
 * queries. The callback receives the transaction client.
 *
 * The helper also switches to the `prsi_app` role (NOBYPASSRLS, non-superuser)
 * so that row-level security policies are enforced. The connection user `prsi`
 * is a superuser which bypasses RLS by default; SET LOCAL ROLE drops those
 * privileges for the duration of the transaction.
 *
 * Usage:
 *   const chats = await withUser(req.user.userId, (tx) => tx.chat.findMany());
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Switch to the non-superuser app role so RLS policies are enforced.
    await tx.$executeRawUnsafe(`SET LOCAL ROLE prsi_app`);
    // Set the user-scoping session variable for RLS policy checks.
    await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${userId.replace(/'/g, "''")}'`);
    return fn(tx);
  });
}

/** For admin / system contexts that need to bypass RLS. Use sparingly. */
export async function asAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Stay as superuser (bypasses RLS) but set an empty user_id for clarity.
    await tx.$executeRawUnsafe(`SET LOCAL app.user_id = ''`);
    return fn(tx);
  });
}
