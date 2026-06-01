/**
 * BullMQ processor for `data-extract` jobs — M7.7 + M9.5.
 *
 * Thin wrapper that resolves the right singleton agent from the registry
 * and invokes its `execute()` lifecycle. The dispatch branches on
 * `chat_params.data_source`:
 *
 *   csv_upload (default) → DataExtractAgent (M7.7 CSV 7-step pipeline)
 *   opensearch           → SearchAgent (M9.5 paginated fetch + memory)
 *
 * Both agents share the same input shape (userId, chatId, queryId), so the
 * worker only changes WHICH agent it resolves. The job is enqueued by
 * M7.6's `confirmQuery` regardless of data source — keeping the trigger
 * contract intact across Phase 2 and Phase 3.5.
 *
 * The chat_params read happens outside any agent code: a misconfigured
 * chat (data_source=opensearch but missing OpenSearch env config) is
 * caught here and surfaced as a `search:error` event before any agent
 * actually runs.
 *
 * @file workers/data-extract.worker.ts
 */
import type { Processor } from 'bullmq';
import { AgentRegistry } from '../agents/agent-registry.js';
import type { DataExtractAgent } from '../agents/data-extract.agent.js';
import type { SearchAgent } from '../agents/search.agent.js';
import { withUser } from '../lib/prisma-rls.js';
import { hasOpenSearchConfig } from '../env.js';
import { publishChatEvent } from '../lib/event-bus.js';

export interface DataExtractJobData {
  userId: string;
  chatId: string;
  queryId: string;
}

export const dataExtractProcessor: Processor<DataExtractJobData> = async (job) => {
  const { userId, chatId, queryId } = job.data;

  // Read just the data_source column. Cheap; cached at the request level
  // would be overkill since each job runs once. Defaults to 'csv_upload'
  // when the row is missing (matches the Phase 2 default behavior).
  const dataSource = await withUser(userId, async (tx) => {
    const params = await tx.chatParams.findUnique({
      where: { chatId },
      select: { dataSource: true },
    });
    return params?.dataSource ?? 'csv_upload';
  });

  if (dataSource === 'opensearch') {
    // Phase 3.5 — M9.5: hand off to SearchAgent.
    if (!hasOpenSearchConfig()) {
      // Misconfigured environment. Surface a clear error to the frontend
      // and bail before dispatching the agent.
      await publishChatEvent(chatId, 'search:error', {
        chatId,
        message: 'OpenSearch is not configured.',
      });
      throw new Error('OpenSearch is not configured.');
    }
    const agent = AgentRegistry.getByType('search') as SearchAgent | null;
    if (!agent) throw new Error('SearchAgent not registered');
    return agent.execute({
      userId,
      chatId,
      message: '',
      metadata: { queryId },
    });
  }

  // csv_upload default path — unchanged from M7.7.
  const agent = AgentRegistry.getByType('data_extract') as DataExtractAgent | null;
  if (!agent) throw new Error('DataExtractAgent not registered');
  return agent.execute({
    userId,
    chatId,
    message: '',
    metadata: { queryId },
  });
};
