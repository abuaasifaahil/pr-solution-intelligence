import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { EnrichmentProgressCard } from '../../components/chat/EnrichmentProgressCard';
import type { EnrichmentSessionState } from '../../hooks/useEnrichmentSession';
import type {
  EnrichmentBatchView,
  EnrichmentJob,
} from '../../lib/enrichment';

afterEach(() => cleanup());

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'j1',
    chatId: 'c1',
    totalArticles: 50,
    processedCount: 0,
    batchCount: 12,
    batchesCompleted: 0,
    modelUsed: 'gpt-4o-mini',
    enrichmentType: 'standard',
    totalTokensInput: 0,
    totalTokensOutput: 0,
    status: 'processing',
    startedAt: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeState(
  overrides: Partial<EnrichmentSessionState> = {},
): EnrichmentSessionState {
  return {
    job: makeJob(),
    batches: Array.from({ length: 12 }, (_, i) => ({
      batchNumber: i + 1,
      status: 'pending' as EnrichmentBatchView['status'],
      retryCount: 0,
      estimatedTokens: 0,
      actualTokensIn: null,
      actualTokensOut: null,
      processingMs: null,
      error: null,
    })),
    progress: { processed: 0, total: 50, percent: 0, tokensTotal: 0, elapsedMs: 0 },
    reachState: 'idle',
    reachCoverage: null,
    isDone: false,
    isJsonReady: false,
    jsonArtifactId: null,
    ...overrides,
  };
}

describe('EnrichmentProgressCard', () => {
  it('renders 5 dimension steps in standard mode (no reach row)', () => {
    const state = makeState({
      job: makeJob({ enrichmentType: 'standard' }),
    });
    const { container } = render(<EnrichmentProgressCard state={state} />);
    const steps = container.querySelectorAll('[data-step-key]');
    expect(steps).toHaveLength(5);
    expect(container.querySelector('[data-step-key="reach"]')).toBeNull();
    // Reach sub-card stays hidden in standard mode.
    expect(container.querySelector('[data-testid="reach-agent-card"]')).toBeNull();
  });

  it('renders 6 dimension steps in reach mode and mounts the reach sub-card', () => {
    const state = makeState({
      job: makeJob({ enrichmentType: 'reach' }),
    });
    const { container } = render(<EnrichmentProgressCard state={state} />);
    const steps = container.querySelectorAll('[data-step-key]');
    expect(steps).toHaveLength(6);
    expect(container.querySelector('[data-step-key="reach"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="reach-agent-card"]')).not.toBeNull();
  });

  it('flips to CompletionSummary when isDone === true', () => {
    const state = makeState({
      job: makeJob({ status: 'completed' }),
      progress: {
        processed: 50,
        total: 50,
        percent: 100,
        tokensTotal: 12500,
        elapsedMs: 8200,
      },
      isDone: true,
    });
    render(<EnrichmentProgressCard state={state} />);
    // Completion view exists, processing view does not.
    expect(document.querySelector('[data-testid="completion-summary"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="processing-steps"]')).toBeNull();
    // Stats land in the summary body (defaultSummaryOpen=true on completion).
    expect(screen.getByText('Articles')).toBeTruthy();
    expect(screen.getByText('Batches')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
  });

  it('mounts the BatchGrid when a job is active and batches exist', () => {
    render(<EnrichmentProgressCard state={makeState()} />);
    expect(document.querySelector('[data-testid="batch-grid"]')).toBeTruthy();
  });

  it('omits the BatchGrid when the job is null', () => {
    const state = makeState({ job: null, batches: [] });
    render(<EnrichmentProgressCard state={state} />);
    expect(document.querySelector('[data-testid="batch-grid"]')).toBeNull();
  });

  it('shows the model name in the agent header', () => {
    const state = makeState({ job: makeJob({ modelUsed: 'gpt-4o' }) });
    render(<EnrichmentProgressCard state={state} />);
    expect(screen.getByText(/Enrichment Agent — gpt-4o/)).toBeTruthy();
  });
});
