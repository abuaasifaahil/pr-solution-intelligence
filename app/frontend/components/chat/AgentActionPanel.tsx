'use client';

import type { JSX } from 'react';
import { ProcessingSteps, type AgentStep } from './ProcessingSteps';
import { CompletionSummary } from './CompletionSummary';

/**
 * AgentActionPanel — generic primitive for "agent is doing work" UI.
 *
 * The whole reason ProcessingSteps + CompletionSummary live as separate
 * components is so they can be composed here AND independently reused by
 * future agents (e.g. the Phase 5.5 sandbox-tool experience tracked in
 * `docs/phase5.5-sandbox.md`).
 *
 * State transitions:
 *   - `result === null`  → render ProcessingSteps with the live step array
 *   - `result !== null`  → render CompletionSummary (collapsed by default
 *                          so the chat thread stays compact)
 *
 * Phase 2's DataExtractAgent is just the first consumer — `useChatSession`
 * feeds it the 7-step pipeline.
 *
 * @file components/chat/AgentActionPanel.tsx
 */

export interface AgentActionResult {
  stats: Record<string, string | number>;
  /** One-line summary used when the completion card is collapsed. */
  summaryText: string;
}

interface Props {
  agentName: string;
  steps: AgentStep[];
  /** Non-null = the run finished. Show the completion summary instead. */
  result: AgentActionResult | null;
  /** Default expansion state for the completion summary. False keeps the
   *  transcript compact; callers can force-open on initial reveal. */
  defaultSummaryOpen?: boolean;
}

export function AgentActionPanel({
  agentName,
  steps,
  result,
  defaultSummaryOpen = false,
}: Props): JSX.Element {
  if (result) {
    return (
      <CompletionSummary
        agentName={agentName}
        stats={result.stats}
        summaryText={result.summaryText}
        defaultOpen={defaultSummaryOpen}
      />
    );
  }
  return <ProcessingSteps agentName={agentName} steps={steps} />;
}
