import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────
// We drive the WS handlers directly off a fake ChatStream — no socket.

interface Handlers {
  start?: (p: { jobId: string; totalArticles: number; batchCount: number; model: string }) => void;
  batchStart?: (p: { jobId: string; batchNumber: number; articleCount: number; estimatedTokens: number }) => void;
  batchComplete?: (p: { jobId: string; batchNumber: number; processedCount: number; tokensUsed: number; duration: number }) => void;
  batchError?: (p: { jobId: string; batchNumber: number; error: string; retrying: boolean; retryCount: number }) => void;
  progress?: (p: { jobId: string; processed: number; total: number; percent: number; tokensTotal: number; elapsed: number }) => void;
  reachStart?: (p: { jobId: string; chatId: string; domains: number }) => void;
  reachComplete?: (p: { jobId: string; resolved: number; total: number; coverage: number; duration: number }) => void;
  complete?: (p: { jobId: string; totalArticles: number; totalTokens: number; duration: number; dimensions: string[]; status: 'completed' | 'partial' | 'failed' }) => void;
  jsonReady?: (p: { chatId: string; artifactId: string; articleCount: number }) => void;
}

function makeStream(): { stream: unknown; handlers: Handlers } {
  const handlers: Handlers = {};
  const stream = {
    onEnrichmentStart: (cb: NonNullable<Handlers['start']>) => { handlers.start = cb; },
    onEnrichmentBatchStart: (cb: NonNullable<Handlers['batchStart']>) => { handlers.batchStart = cb; },
    onEnrichmentBatchComplete: (cb: NonNullable<Handlers['batchComplete']>) => { handlers.batchComplete = cb; },
    onEnrichmentBatchError: (cb: NonNullable<Handlers['batchError']>) => { handlers.batchError = cb; },
    onEnrichmentProgress: (cb: NonNullable<Handlers['progress']>) => { handlers.progress = cb; },
    onEnrichmentReachStart: (cb: NonNullable<Handlers['reachStart']>) => { handlers.reachStart = cb; },
    onEnrichmentReachComplete: (cb: NonNullable<Handlers['reachComplete']>) => { handlers.reachComplete = cb; },
    onEnrichmentComplete: (cb: NonNullable<Handlers['complete']>) => { handlers.complete = cb; },
    onEnrichmentJsonReady: (cb: NonNullable<Handlers['jsonReady']>) => { handlers.jsonReady = cb; },
  };
  return { stream, handlers };
}

interface MockedStatus {
  job: unknown | null;
  batches: unknown[];
  progress: { processed: number; total: number; percent: number };
  reachCoverage?: { resolved: number; total: number; percent: number };
}

const getEnrichStatus = vi.fn(
  async (_chatId: string): Promise<MockedStatus> => ({
    job: null,
    batches: [],
    progress: { processed: 0, total: 0, percent: 0 },
  }),
);
vi.mock('../../lib/enrichment', () => ({
  getEnrichStatus,
}));

const { useEnrichmentSession } = await import('../../hooks/useEnrichmentSession');

beforeEach(() => {
  vi.clearAllMocks();
  getEnrichStatus.mockReset();
  getEnrichStatus.mockResolvedValue({
    job: null,
    batches: [],
    progress: { processed: 0, total: 0, percent: 0 },
  });
});
afterEach(() => { cleanup(); });

describe('useEnrichmentSession', () => {
  it('fetches the initial enrichment status snapshot when enabled', async () => {
    const { stream } = makeStream();
    renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(getEnrichStatus).toHaveBeenCalledWith('c1'));
  });

  it('skips the initial fetch when disabled', async () => {
    const { stream } = makeStream();
    renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: false }),
    );
    // Wait one microtask + a beat so the (skipped) effect would have run.
    await new Promise((r) => setTimeout(r, 10));
    expect(getEnrichStatus).not.toHaveBeenCalled();
  });

  it('enrichment:start sets the job + seeds batches + total', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.start).toBeDefined());

    act(() => {
      handlers.start!({
        jobId: 'j1',
        totalArticles: 50,
        batchCount: 12,
        model: 'gpt-4o-mini',
      });
    });

    expect(result.current.job?.id).toBe('j1');
    expect(result.current.job?.modelUsed).toBe('gpt-4o-mini');
    expect(result.current.batches).toHaveLength(12);
    expect(result.current.batches.every((b) => b.status === 'pending')).toBe(true);
    expect(result.current.progress.total).toBe(50);
  });

  it('enrichment:batch-complete flips the matching tile to completed', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.start).toBeDefined());

    act(() => {
      handlers.start!({ jobId: 'j1', totalArticles: 50, batchCount: 3, model: 'gpt-4o-mini' });
    });
    act(() => {
      handlers.batchComplete!({
        jobId: 'j1',
        batchNumber: 2,
        processedCount: 17,
        tokensUsed: 800,
        duration: 1250,
      });
    });

    const b2 = result.current.batches.find((b) => b.batchNumber === 2)!;
    expect(b2.status).toBe('completed');
    expect(b2.processingMs).toBe(1250);
  });

  it('enrichment:batch-error flips to failed (retrying=false) or retrying (retrying=true)', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.start).toBeDefined());

    act(() => {
      handlers.start!({ jobId: 'j1', totalArticles: 10, batchCount: 2, model: 'gpt-4o-mini' });
    });
    act(() => {
      handlers.batchError!({
        jobId: 'j1', batchNumber: 1, error: 'rate limited', retrying: true, retryCount: 1,
      });
    });
    act(() => {
      handlers.batchError!({
        jobId: 'j1', batchNumber: 2, error: 'fatal', retrying: false, retryCount: 2,
      });
    });

    const b1 = result.current.batches.find((b) => b.batchNumber === 1)!;
    const b2 = result.current.batches.find((b) => b.batchNumber === 2)!;
    expect(b1.status).toBe('retrying');
    expect(b1.error).toBe('rate limited');
    expect(b2.status).toBe('failed');
  });

  it('enrichment:complete sets isDone for standard mode', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.start).toBeDefined());

    act(() => {
      handlers.start!({ jobId: 'j1', totalArticles: 50, batchCount: 12, model: 'gpt-4o-mini' });
    });
    expect(result.current.isDone).toBe(false);

    act(() => {
      handlers.complete!({
        jobId: 'j1',
        totalArticles: 50,
        totalTokens: 12000,
        duration: 9000,
        dimensions: ['sentiment', 'themes', 'emotion', 'entities', 'signals'],
        status: 'completed',
      });
    });

    expect(result.current.isDone).toBe(true);
    expect(result.current.job?.status).toBe('completed');
    expect(result.current.progress.tokensTotal).toBe(12000);
    expect(result.current.progress.elapsedMs).toBe(9000);
  });

  it('for reach mode, isDone requires BOTH enrichment:complete and enrichment:reach-complete', async () => {
    // Seed the initial REST snapshot with a reach-typed job so the hook
    // treats this run as reach-mode from frame 1.
    getEnrichStatus.mockResolvedValueOnce({
      job: {
        id: 'j1',
        chatId: 'c1',
        totalArticles: 20,
        processedCount: 0,
        batchCount: 4,
        batchesCompleted: 0,
        modelUsed: 'gpt-4o-mini',
        enrichmentType: 'reach',
        totalTokensInput: 0,
        totalTokensOutput: 0,
        status: 'processing',
        startedAt: null,
        completedAt: null,
        createdAt: '2026-06-01T00:00:00Z',
      },
      batches: [],
      progress: { processed: 0, total: 20, percent: 0 },
    });

    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(result.current.job?.enrichmentType).toBe('reach'));
    await waitFor(() => expect(handlers.complete).toBeDefined());

    // LLM-side done, reach side still idle/fetching → NOT done yet.
    act(() => {
      handlers.complete!({
        jobId: 'j1',
        totalArticles: 20,
        totalTokens: 5000,
        duration: 4000,
        dimensions: ['sentiment'],
        status: 'completed',
      });
    });
    expect(result.current.isDone).toBe(false);

    // Reach side completes → now done.
    act(() => {
      handlers.reachComplete!({
        jobId: 'j1',
        resolved: 18,
        total: 20,
        coverage: 90,
        duration: 2200,
      });
    });
    expect(result.current.isDone).toBe(true);
    expect(result.current.reachState).toBe('done');
    expect(result.current.reachCoverage).toEqual({ resolved: 18, total: 20, percent: 90 });
  });

  it('enrichment:reach-start flips reachState to fetching', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.reachStart).toBeDefined());

    act(() => {
      handlers.reachStart!({ jobId: 'j1', chatId: 'c1', domains: 24 });
    });
    expect(result.current.reachState).toBe('fetching');
  });

  it('enrichment:json-ready sets isJsonReady + jsonArtifactId', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.jsonReady).toBeDefined());

    act(() => {
      handlers.jsonReady!({ chatId: 'c1', artifactId: 'art-1', articleCount: 42 });
    });
    expect(result.current.isJsonReady).toBe(true);
    expect(result.current.jsonArtifactId).toBe('art-1');
  });

  it('enrichment:progress mirrors the payload into state', async () => {
    const { stream, handlers } = makeStream();
    const { result } = renderHook(() =>
      useEnrichmentSession('c1', stream as never, { enabled: true }),
    );
    await waitFor(() => expect(handlers.progress).toBeDefined());

    act(() => {
      handlers.progress!({
        jobId: 'j1',
        processed: 25,
        total: 50,
        percent: 50,
        tokensTotal: 4200,
        elapsed: 3300,
      });
    });
    expect(result.current.progress.processed).toBe(25);
    expect(result.current.progress.percent).toBe(50);
    expect(result.current.progress.tokensTotal).toBe(4200);
    expect(result.current.progress.elapsedMs).toBe(3300);
  });
});
