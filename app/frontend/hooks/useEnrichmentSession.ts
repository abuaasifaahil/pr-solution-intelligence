'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getEnrichStatus,
  type EnrichmentJob,
  type EnrichmentBatchView,
} from '../lib/enrichment';
import type { ChatStream } from '../lib/chat-stream';

/**
 * Phase 3 — single hook owning all the enrichment state for a chat (M8.8).
 *
 * Mirrors `useChatSession`'s pattern: initial REST snapshot, then a flock of
 * WS handlers that mutate per-event. Re-polls /enrich/status every 5s while
 * we haven't reached the terminal state as a safety net against dropped WS
 * frames.
 *
 * Consumers (`EnrichmentProgressCard`, `BatchGrid`, `ReachAgentCard`, and
 * M8.9's `ChipUpArtifact`) read the consolidated state object and render
 * accordingly.
 *
 * @file hooks/useEnrichmentSession.ts
 */

export type ReachState = 'idle' | 'fetching' | 'done' | 'failed';

export interface EnrichmentSessionState {
  job: EnrichmentJob | null;
  batches: EnrichmentBatchView[];
  progress: {
    processed: number;
    total: number;
    percent: number;
    tokensTotal: number;
    elapsedMs: number;
  };
  reachState: ReachState;
  reachCoverage: { resolved: number; total: number; percent: number } | null;
  /** Combined LLM + reach gate: terminal for the active enrichment type. */
  isDone: boolean;
  /** Cue for M8.9 ChipUp — flips when `enrichment:json-ready` lands. */
  isJsonReady: boolean;
  jsonArtifactId: string | null;
}

const POLL_INTERVAL_MS = 5_000;

function emptyState(): EnrichmentSessionState {
  return {
    job: null,
    batches: [],
    progress: { processed: 0, total: 0, percent: 0, tokensTotal: 0, elapsedMs: 0 },
    reachState: 'idle',
    reachCoverage: null,
    isDone: false,
    isJsonReady: false,
    jsonArtifactId: null,
  };
}

/**
 * `job.status in ['completed','partial','failed']` AND — when the active
 * enrichment is reach-based — the SimilarWeb side has also terminated
 * (`done` or `failed`). Failures still count as "done" so the UI can show
 * its partial / failure state instead of spinning forever.
 */
function computeIsDone(
  job: EnrichmentJob | null,
  reachState: ReachState,
): boolean {
  if (!job) return false;
  const llmDone =
    job.status === 'completed' || job.status === 'partial' || job.status === 'failed';
  if (!llmDone) return false;
  if (job.enrichmentType !== 'reach') return true;
  return reachState === 'done' || reachState === 'failed';
}

export function useEnrichmentSession(
  chatId: string,
  stream: ChatStream | null,
  options?: { enabled?: boolean },
): EnrichmentSessionState {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<EnrichmentSessionState>(() => emptyState());

  // Mirror `enabled` + `state.isDone` into refs so the long-lived poller and
  // WS handlers see fresh values without re-subscribing every render.
  const isDoneRef = useRef(false);
  useEffect(() => { isDoneRef.current = state.isDone; }, [state.isDone]);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // ── Initial REST snapshot ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !chatId) return;
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await getEnrichStatus(chatId);
        if (cancelled) return;
        setState((prev) => mergeSnapshot(prev, snapshot));
      } catch {
        // 404 → no job yet; leave state empty.
      }
    })();
    return () => { cancelled = true; };
  }, [chatId, enabled]);

  // ── Periodic re-poll (WS-drop safety net) ─────────────────────────────
  useEffect(() => {
    if (!enabled || !chatId) return;
    const id = setInterval(async () => {
      if (isDoneRef.current) return;
      try {
        const snapshot = await getEnrichStatus(chatId);
        setState((prev) => mergeSnapshot(prev, snapshot));
      } catch {
        // Best-effort; the WS will catch us up.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [chatId, enabled]);

  // ── WebSocket wiring ──────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !stream) return;

    stream.onEnrichmentStart((p) => {
      setState((prev) => {
        // Seed N pending batches so the BatchGrid shows the full grid from
        // the moment the run kicks off.
        const seededBatches: EnrichmentBatchView[] = Array.from(
          { length: p.batchCount },
          (_, i) => ({
            batchNumber: i + 1,
            status: 'pending',
            retryCount: 0,
            estimatedTokens: 0,
            actualTokensIn: null,
            actualTokensOut: null,
            processingMs: null,
            error: null,
          }),
        );
        // If we already had a job (from snapshot), keep its identity; else
        // synthesize a minimal record we'll over-write on the next poll.
        const job: EnrichmentJob = prev.job ?? {
          id: p.jobId,
          chatId,
          totalArticles: p.totalArticles,
          processedCount: 0,
          batchCount: p.batchCount,
          batchesCompleted: 0,
          modelUsed: p.model,
          enrichmentType: 'standard',
          totalTokensInput: 0,
          totalTokensOutput: 0,
          status: 'processing',
          startedAt: new Date().toISOString(),
          completedAt: null,
          createdAt: new Date().toISOString(),
        };
        return {
          ...prev,
          job: {
            ...job,
            id: p.jobId,
            totalArticles: p.totalArticles,
            batchCount: p.batchCount,
            modelUsed: p.model,
            status: 'processing',
          },
          batches: prev.batches.length > 0 ? prev.batches : seededBatches,
          progress: { ...prev.progress, total: p.totalArticles },
        };
      });
    });

    stream.onEnrichmentBatchStart((p) => {
      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((b) =>
          b.batchNumber === p.batchNumber
            ? { ...b, status: 'processing', estimatedTokens: p.estimatedTokens }
            : b,
        ),
      }));
    });

    stream.onEnrichmentBatchComplete((p) => {
      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((b) =>
          b.batchNumber === p.batchNumber
            ? { ...b, status: 'completed', processingMs: p.duration }
            : b,
        ),
      }));
    });

    stream.onEnrichmentBatchError((p) => {
      setState((prev) => ({
        ...prev,
        batches: prev.batches.map((b) =>
          b.batchNumber === p.batchNumber
            ? {
                ...b,
                status: p.retrying ? 'retrying' : 'failed',
                retryCount: p.retryCount,
                error: p.error,
              }
            : b,
        ),
      }));
    });

    stream.onEnrichmentProgress((p) => {
      setState((prev) => ({
        ...prev,
        progress: {
          processed: p.processed,
          total: p.total,
          percent: p.percent,
          tokensTotal: p.tokensTotal,
          elapsedMs: p.elapsed,
        },
      }));
    });

    stream.onEnrichmentReachStart(() => {
      setState((prev) => ({ ...prev, reachState: 'fetching' }));
    });

    stream.onEnrichmentReachComplete((p) => {
      setState((prev) => {
        const reachState: ReachState = 'done';
        const reachCoverage = {
          resolved: p.resolved,
          total: p.total,
          percent: p.coverage,
        };
        const isDone = computeIsDone(prev.job, reachState);
        return { ...prev, reachState, reachCoverage, isDone };
      });
    });

    stream.onEnrichmentComplete((p) => {
      setState((prev) => {
        const job: EnrichmentJob | null = prev.job
          ? {
              ...prev.job,
              status: p.status,
              completedAt: new Date().toISOString(),
              processedCount: p.totalArticles,
            }
          : null;
        const progress = {
          ...prev.progress,
          processed: p.totalArticles,
          total: p.totalArticles,
          percent: 100,
          tokensTotal: p.totalTokens,
          elapsedMs: p.duration,
        };
        const isDone = computeIsDone(job, prev.reachState);
        return { ...prev, job, progress, isDone };
      });
    });

    stream.onEnrichmentJsonReady((p) => {
      setState((prev) => ({
        ...prev,
        isJsonReady: true,
        jsonArtifactId: p.artifactId,
      }));
    });
  }, [chatId, stream, enabled]);

  return state;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mergeSnapshot(
  prev: EnrichmentSessionState,
  snapshot: {
    job: EnrichmentJob | null;
    batches: EnrichmentBatchView[];
    progress: { processed: number; total: number; percent: number };
    reachCoverage?: { resolved: number; total: number; percent: number };
  },
): EnrichmentSessionState {
  // Don't clobber tokensTotal / elapsedMs the WS already gave us — the REST
  // endpoint doesn't expose them in its progress block.
  const progress = {
    processed: snapshot.progress.processed,
    total: snapshot.progress.total,
    percent: snapshot.progress.percent,
    tokensTotal: prev.progress.tokensTotal,
    elapsedMs: prev.progress.elapsedMs,
  };
  const reachState: ReachState = snapshot.reachCoverage
    ? snapshot.reachCoverage.percent >= 100
      ? 'done'
      : 'fetching'
    : prev.reachState;
  const job = snapshot.job;
  const isDone = computeIsDone(job, reachState);
  return {
    ...prev,
    job,
    batches: snapshot.batches.length > 0 ? snapshot.batches : prev.batches,
    progress,
    reachState,
    reachCoverage: snapshot.reachCoverage ?? prev.reachCoverage,
    isDone,
  };
}
