/**
 * BullMQ processor for `reach-fetch` jobs — M8.6.
 *
 * Thin wrapper that resolves the singleton SimilarWebAgent from the registry
 * and invokes its `execute()` lifecycle. The agent itself owns the parallel
 * reach pipeline (perceive → reason → plan → act → reflect).
 *
 * Jobs of this kind are enqueued by M8.4's EnrichmentAgent when
 * `enrichmentType === 'reach'`. Exactly one `reach-fetch` lands per
 * enrichment job, alongside the per-batch `enrich-batch` jobs that drive
 * the LLM pipeline (M8.5). The two pipelines run independently.
 *
 * @file backend/src/workers/reach-fetch.worker.ts
 */
import type { Processor } from 'bullmq';
import { AgentRegistry } from '../agents/agent-registry.js';
import type { SimilarWebAgent } from '../agents/similarweb.agent.js';

export interface ReachFetchJobData {
  jobId: string;
  chatId: string;
  userId: string;
}

export const reachFetchProcessor: Processor<ReachFetchJobData> = async (job) => {
  const agent = AgentRegistry.getByType('similarweb') as SimilarWebAgent | null;
  if (!agent) throw new Error('SimilarWebAgent not registered');

  return agent.execute({
    userId: job.data.userId,
    chatId: job.data.chatId,
    message: '',
    metadata: { jobId: job.data.jobId },
  });
};
