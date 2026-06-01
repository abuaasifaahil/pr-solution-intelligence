/**
 * BullMQ processor for `data-extract` jobs — M7.7.
 *
 * Thin wrapper that resolves the singleton DataExtractAgent from the registry
 * and invokes its `execute()` lifecycle. The agent itself owns the 7-step
 * pipeline (perceive → reason → plan → act → reflect).
 *
 * Jobs of this kind are enqueued by M7.6's `confirmQuery` once the user
 * confirms the generated Boolean query.
 *
 * @file workers/data-extract.worker.ts
 */
import type { Processor } from 'bullmq';
import { AgentRegistry } from '../agents/agent-registry.js';
import type { DataExtractAgent } from '../agents/data-extract.agent.js';

export interface DataExtractJobData {
  userId: string;
  chatId: string;
  queryId: string;
}

export const dataExtractProcessor: Processor<DataExtractJobData> = async (job) => {
  const agent = AgentRegistry.getByType('data_extract') as DataExtractAgent | null;
  if (!agent) throw new Error('DataExtractAgent not registered');

  return agent.execute({
    userId: job.data.userId,
    chatId: job.data.chatId,
    message: '',
    metadata: { queryId: job.data.queryId },
  });
};
