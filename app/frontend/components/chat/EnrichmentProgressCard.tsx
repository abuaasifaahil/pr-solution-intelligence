'use client';

import type { JSX } from 'react';
import { AgentActionPanel, type AgentActionResult } from './AgentActionPanel';
import type { AgentStep, AgentStepStatus } from './ProcessingSteps';
import { BatchGrid } from './BatchGrid';
import { ReachAgentCard } from './ReachAgentCard';
import type { EnrichmentSessionState } from '../../hooks/useEnrichmentSession';

/**
 * Phase 3 — In-progress enrichment surface (M8.8).
 *
 * Composes three primitives:
 *
 *   • AgentActionPanel (M7.9)  → 5 or 6 high-level dimension steps that
 *                                flip to a CompletionSummary on isDone.
 *   • BatchGrid                → N tiles, one per batch.
 *   • ReachAgentCard           → only when enrichmentType === 'reach'.
 *
 * The 6 dimension states are derived synthetically from the run lifecycle
 * (we don't actually emit per-dimension events) — all 5 LLM dimensions
 * march in lockstep. The 'reach' dimension follows its own state because
 * SimilarWebAgent runs independently of the LLM batches.
 *
 * @file components/chat/EnrichmentProgressCard.tsx
 */

const DIMENSIONS: ReadonlyArray<{ key: string; name: string; reach?: boolean }> = [
  { key: 'sentiment', name: 'Sentiment Analysis' },
  { key: 'themes', name: 'Theme Classification' },
  { key: 'emotion', name: 'Emotion Detection' },
  { key: 'entities', name: 'Entity Extraction' },
  { key: 'signals', name: 'Signal Detection' },
  { key: 'reach', name: 'Publisher Reach (Similar Web)', reach: true },
];

interface Props {
  state: EnrichmentSessionState;
}

export function EnrichmentProgressCard({ state }: Props): JSX.Element {
  const showReach = state.job?.enrichmentType === 'reach';

  const llmStatus: AgentStepStatus = state.isDone
    ? state.job?.status === 'failed'
      ? 'failed'
      : 'done'
    : state.job
      ? 'running'
      : 'pending';

  const reachStatus: AgentStepStatus =
    state.reachState === 'done'
      ? 'done'
      : state.reachState === 'failed'
        ? 'failed'
        : state.reachState === 'fetching'
          ? 'running'
          : 'pending';

  const steps: AgentStep[] = DIMENSIONS.filter((d) => !d.reach || showReach).map(
    (d) => ({
      key: d.key,
      name: d.name,
      status: d.reach ? reachStatus : llmStatus,
    }),
  );

  const result: AgentActionResult | null =
    state.isDone && state.job
      ? {
          stats: {
            Articles: state.progress.total,
            Batches: state.job.batchCount,
            Tokens: state.progress.tokensTotal.toLocaleString(),
            Duration: `${(state.progress.elapsedMs / 1000).toFixed(1)}s`,
            Model: state.job.modelUsed,
          },
          summaryText:
            `${state.progress.total} articles · ` +
            `${state.job.batchCount} batches · ` +
            `${state.progress.tokensTotal.toLocaleString()} tokens · ` +
            `${(state.progress.elapsedMs / 1000).toFixed(1)}s`,
        }
      : null;

  const agentName = `Enrichment Agent — ${state.job?.modelUsed ?? 'thinking…'}`;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="enrichment-progress-card"
    >
      <AgentActionPanel
        agentName={agentName}
        steps={steps}
        result={result}
        defaultSummaryOpen={state.isDone}
      />
      {state.job && state.batches.length > 0 && (
        <BatchGrid batches={state.batches} />
      )}
      {showReach && (
        <ReachAgentCard
          state={state.reachState}
          coverage={state.reachCoverage}
        />
      )}
    </div>
  );
}
