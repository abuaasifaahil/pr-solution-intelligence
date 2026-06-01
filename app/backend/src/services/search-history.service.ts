/**
 * Phase 3.5 (M9.5) — SearchAgent memory persistence.
 *
 * Owns the read+write surface for the `search_history` table. Every
 * SearchAgent run writes one row at the end of its `learn()` lifecycle
 * step. Future runs CAN read this table to short-circuit a re-fetch
 * when the same chat asks the same query a second time (M9.5 ships the
 * write path + the read helper; the actual cache-read shortcut inside
 * `SearchAgent.perceive()` is stubbed via a TODO — see search.agent.ts).
 *
 * RLS posture: the `search_history` table has no `user_id` column. RLS
 * scoping is by `chat_id IN (SELECT id FROM chats WHERE user_id = …)`
 * (matches the boolean_queries policy). Every call must run inside a
 * `withUser` transaction so the policy resolves.
 *
 * @file services/search-history.service.ts
 */
import { withUser } from '../lib/prisma-rls.js';

export interface RecordSearchInput {
  chatId: string;
  queryHash: string;
  /** OpenSearch _id list (NOT internal article UUIDs). */
  articleIds: string[];
  totalHits: number;
  indicesQueried: string[];
  /** Float in [0,1] — null when presence detection was skipped (zero-hits). */
  coverageReach: number | null;
}

export interface SearchHistoryRow {
  id: string;
  chatId: string;
  queryHash: string;
  articleIds: string[];
  totalHits: number;
  indicesQueried: string[];
  coverageReach: number | null;
  executedAt: Date;
}

/**
 * Insert one row into `search_history`. Returns the persisted row so the
 * caller can attach the `id` to a log line / outbound event if it wants.
 */
export async function recordSearchExecution(
  userId: string,
  input: RecordSearchInput,
): Promise<SearchHistoryRow> {
  return withUser(userId, async (tx) => {
    const row = await tx.searchHistory.create({
      data: {
        chatId: input.chatId,
        queryHash: input.queryHash,
        articleIds: input.articleIds,
        totalHits: input.totalHits,
        indicesQueried: input.indicesQueried,
        coverageReach: input.coverageReach,
      },
    });
    return row as SearchHistoryRow;
  });
}

/**
 * Look up the most-recent `search_history` row for a (chatId, queryHash)
 * pair. Returns `null` when no matching row exists (first execution).
 *
 * The READ path is the "memory" half of the M9.5 contract — currently
 * called by SearchAgent.perceive() for visibility/logging only. A
 * follow-up milestone can flip the short-circuit on by skipping the
 * fetch loop entirely when a recent row exists and its `articleIds`
 * still resolve to live rows in `articles`.
 */
export async function findCachedSearch(
  userId: string,
  chatId: string,
  queryHash: string,
): Promise<SearchHistoryRow | null> {
  return withUser(userId, async (tx) => {
    const row = await tx.searchHistory.findFirst({
      where: { chatId, queryHash },
      orderBy: { executedAt: 'desc' },
    });
    return (row as SearchHistoryRow | null) ?? null;
  });
}
