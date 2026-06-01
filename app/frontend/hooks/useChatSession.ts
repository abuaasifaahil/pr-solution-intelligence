'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api-client';
import { useRouter } from 'next/navigation';
import { ChatStream } from '../lib/chat-stream';
import {
  getChat,
  listMessages,
  sendMessage,
  type ChatDetail,
  type ChatMessage,
  type ChipDef,
} from '../lib/chats';
import {
  createUpload,
  getUpload,
  getUploadPreview,
  deleteUpload,
  type UploadStatus,
  type UploadPreview,
} from '../lib/uploads';
import {
  getOrCreateParams,
  patchChatParams,
  suggestCompetitorsForBrand,
  type ChatParams,
  type ChatParamsPatch,
  type CompetitorSet,
  type CompetitorSuggestions,
} from '../lib/chat-params';
import {
  confirmQuery as confirmQueryApi,
  editQuery as editQueryApi,
  generateQuery as generateQueryApi,
  getLatestQuery as getLatestQueryApi,
  type BooleanQuery,
} from '../lib/boolean-query';
import {
  isFlowState,
  type FlowStateLiteral,
} from '../lib/flow-states';
import type { AgentStep } from '../components/chat/ProcessingSteps';
import type { AgentActionResult } from '../components/chat/AgentActionPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Phase 2 — DataExtractAgent's 7-step pipeline. Hardcoded here because the
 * spec fixes the step order; future agents will own their own step list.
 */
const PHASE2_DATA_EXTRACT_STEPS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'validate', name: 'Validate Schema' },
  { key: 'parse', name: 'Parse Articles' },
  { key: 'dates', name: 'Detect Date Range' },
  { key: 'domains', name: 'Extract Domains' },
  { key: 'normalize', name: 'Normalize Schema' },
  { key: 'insert', name: 'Insert to Database' },
  { key: 'handoff', name: 'Handoff Ready' },
];

function freshSteps(): AgentStep[] {
  return PHASE2_DATA_EXTRACT_STEPS.map((s) => ({ ...s, status: 'pending' }));
}

export interface ChatSession {
  // ── data
  chat: ChatDetail | null;
  messages: ChatMessage[];
  upload: UploadStatus | null;
  uploadProgress: number | undefined;
  uploadPreview: UploadPreview | null;
  params: ChatParams | null;
  flowState: FlowStateLiteral;
  query: BooleanQuery | null;
  agentSteps: AgentStep[];
  agentResult: AgentActionResult | null;
  competitorSuggestions: CompetitorSuggestions | null;
  competitorsLoading: boolean;
  busy: boolean;
  /** True while a query generate / confirm / patch call is in flight. */
  queryBusy: boolean;
  error: string | null;

  // ── actions
  send: (content: string, choice?: string) => Promise<void>;
  pickChip: (chip: ChipDef) => void;
  uploadFile: (file: File) => Promise<void>;
  removeUpload: () => Promise<void>;
  patchParams: (patch: ChatParamsPatch) => Promise<void>;
  fetchCompetitorSuggestions: (brand: string) => Promise<void>;
  generateQuery: () => Promise<void>;
  editQuery: (text: string) => Promise<void>;
  confirmQuery: () => Promise<void>;
  clearError: () => void;
}

/**
 * Central state container for a single chat session.
 *
 * Replaces the M7.8 `useState` cluster in the chat page with one cohesive
 * object: initial load (parallel), WS subscription (all upload + flow +
 * processing events), and every mutation. The chat page becomes a thin
 * shell over `const session = useChatSession(id, accessToken)`.
 *
 * @file hooks/useChatSession.ts
 */
export function useChatSession(
  chatId: string,
  accessToken: string | null,
): ChatSession {
  const router = useRouter();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [upload, setUpload] = useState<UploadStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | undefined>(undefined);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [params, setParams] = useState<ChatParams | null>(null);
  const [flowState, setFlowState] = useState<FlowStateLiteral>('init');
  const [query, setQuery] = useState<BooleanQuery | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>(() => freshSteps());
  const [agentResult, setAgentResult] = useState<AgentActionResult | null>(null);
  const [competitorSuggestions, setCompetitorSuggestions] =
    useState<CompetitorSuggestions | null>(null);
  const [competitorsLoading, setCompetitorsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queryBusy, setQueryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The WS subscription is registered once per chat-mount; mirror IDs into
  // refs so handlers don't go stale.
  const uploadIdRef = useRef<string | null>(null);
  useEffect(() => { uploadIdRef.current = upload?.id ?? null; }, [upload?.id]);
  const lastBrandRef = useRef<string | null>(null);

  // ── Initial load (parallel) ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, m, p, q] = await Promise.all([
          getChat(chatId),
          listMessages(chatId),
          getOrCreateParams(chatId).catch(() => null),
          getLatestQueryApi(chatId).catch(() => null),
        ]);
        if (cancelled) return;
        setChat(c);
        setMessages(m);
        if (p) {
          setParams(p.params);
          setFlowState(p.flowState);
        }
        setQuery(q ?? null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          router.replace('/');
          return;
        }
        if (!cancelled) setError('Failed to load chat.');
      }
    })();
    return () => { cancelled = true; };
  }, [chatId, router]);

  // ── WebSocket wiring ────────────────────────────────────────────────────
  useEffect(() => {
    if (!accessToken) return;
    const cs = new ChatStream({ apiUrl: API_URL, chatId, accessToken });

    cs.onTyping((start) => setBusy(start));

    cs.onChunk(({ assistantMessageId, delta }) => {
      setMessages((prev) =>
        prev.map((mm) =>
          mm.id === assistantMessageId
            ? { ...mm, content: mm.content + delta }
            : mm,
        ),
      );
    });

    cs.onMessage(({ message }) => {
      setMessages((prev) =>
        prev.map((mm) =>
          mm.id === message.id
            ? { ...mm, content: message.content, metadata: message.metadata }
            : mm,
        ),
      );
    });

    cs.onError(({ message }) => {
      setError(message || 'Stream error.');
      setBusy(false);
    });

    cs.onUploadProgress(({ uploadId, percent }) => {
      if (uploadIdRef.current !== uploadId) return;
      setUploadProgress(percent);
    });

    cs.onUploadParsed(async ({ uploadId }) => {
      if (uploadIdRef.current !== uploadId) return;
      try {
        const [full, prev] = await Promise.all([
          getUpload(uploadId),
          getUploadPreview(uploadId, 5),
        ]);
        setUpload(full.upload);
        setUploadPreview(prev);
        setUploadProgress(100);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to load parsed upload.');
      }
    });

    cs.onUploadError(({ uploadId, error: errMsg }) => {
      if (uploadIdRef.current !== uploadId) return;
      setUpload((u) => (u ? { ...u, status: 'error', errorMessage: errMsg } : u));
    });

    cs.onFlowStateChange(({ toState }) => {
      if (isFlowState(toState)) setFlowState(toState);
    });

    cs.onProcessingStep(({ stepKey, status, duration, error: stepErr }) => {
      setAgentSteps((prev) => {
        let advanceNext = false;
        const out = prev.map((s) => {
          if (s.key === stepKey) {
            advanceNext = status === 'done';
            return { ...s, status, durationMs: duration, error: stepErr };
          }
          return s;
        });
        if (!advanceNext) return out;
        // Move the next pending step into 'running' so the spinner stays
        // ahead of the green checks. Order matches PHASE2_DATA_EXTRACT_STEPS.
        const nextIdx = out.findIndex((s) => s.status === 'pending');
        const nextStep = nextIdx >= 0 ? out[nextIdx] : undefined;
        if (nextStep) {
          out[nextIdx] = { ...nextStep, status: 'running' };
        }
        return out;
      });
    });

    cs.onProcessingComplete(({ totalArticles, domains, totalTime }) => {
      setAgentResult({
        stats: {
          'Articles': totalArticles,
          'Domains': domains,
          'Total time': `${(totalTime / 1000).toFixed(1)}s`,
        },
        summaryText:
          `${totalArticles} articles · ${domains} domains · ` +
          `${(totalTime / 1000).toFixed(1)}s`,
      });
    });

    cs.open();
    return () => cs.close();
  }, [chatId, accessToken]);

  // ── Actions ────────────────────────────────────────────────────────────

  const send = useCallback<ChatSession['send']>(
    async (content, choice) => {
      if (busy) return;
      setError(null);
      try {
        const out = await sendMessage(chatId, content, choice);
        const placeholder: ChatMessage = {
          id: out.assistantMessageId,
          chatId,
          role: 'assistant',
          content: '',
          metadata: { chips: out.chips },
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, out.userMessage, placeholder]);
      } catch {
        setError('Message failed. Try again.');
      }
    },
    [busy, chatId],
  );

  const pickChip = useCallback<ChatSession['pickChip']>(
    (chip) => { void send(chip.label, chip.value); },
    [send],
  );

  const uploadFile = useCallback<ChatSession['uploadFile']>(
    async (file) => {
      setError(null);
      setUploadProgress(0);
      setUploadPreview(null);
      try {
        const { upload: u } = await createUpload(file, chatId);
        setUpload(u);
        // PATCH the params row so the flow advances once the upload exists.
        await patchChatParams(chatId, { hasUpload: true, uploadId: u.id })
          .then((res) => {
            setParams(res.params);
            setFlowState(res.params.flowState);
          })
          .catch(() => { /* WS state-change will catch us up */ });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setError(message);
        setUploadProgress(undefined);
      }
    },
    [chatId],
  );

  const removeUpload = useCallback<ChatSession['removeUpload']>(
    async () => {
      const id = upload?.id;
      setUpload(null);
      setUploadPreview(null);
      setUploadProgress(undefined);
      if (!id) return;
      try {
        await deleteUpload(id);
      } catch {
        // Server cleanup is best-effort; local state has already been cleared.
      }
      try {
        await patchChatParams(chatId, { hasUpload: false, uploadId: null });
      } catch { /* */ }
    },
    [upload?.id, chatId],
  );

  const patchParamsAction = useCallback<ChatSession['patchParams']>(
    async (patch) => {
      setError(null);
      try {
        const res = await patchChatParams(chatId, patch);
        setParams(res.params);
        setFlowState(res.params.flowState);
      } catch (err) {
        setError((err as Error).message ?? 'Failed to update chat params.');
      }
    },
    [chatId],
  );

  const fetchCompetitorSuggestions = useCallback<
    ChatSession['fetchCompetitorSuggestions']
  >(
    async (brand) => {
      if (!brand || lastBrandRef.current === brand) return;
      lastBrandRef.current = brand;
      setCompetitorsLoading(true);
      try {
        const c = await suggestCompetitorsForBrand(chatId, brand);
        setCompetitorSuggestions(c);
      } catch {
        setCompetitorSuggestions({ top5: [], top3: [], top2: [] });
      } finally {
        setCompetitorsLoading(false);
      }
    },
    [chatId],
  );

  // When we reach `collect_competitors` with a brand, auto-fetch the LLM
  // suggestions so the CompetitorTags component has something to show.
  useEffect(() => {
    if (flowState === 'collect_competitors' && params?.brand) {
      void fetchCompetitorSuggestions(params.brand);
    }
  }, [flowState, params?.brand, fetchCompetitorSuggestions]);

  const generateQuery = useCallback<ChatSession['generateQuery']>(
    async () => {
      setError(null);
      setQueryBusy(true);
      try {
        const q = await generateQueryApi(chatId);
        setQuery(q);
      } catch (err) {
        setError((err as Error).message ?? 'Query generation failed.');
      } finally {
        setQueryBusy(false);
      }
    },
    [chatId],
  );

  // Auto-generate the first draft as soon as the flow lands at
  // `generate_query` and we don't already have one (e.g. fresh chat).
  useEffect(() => {
    if (flowState === 'generate_query' && !query && !queryBusy) {
      void generateQuery();
    }
  }, [flowState, query, queryBusy, generateQuery]);

  const editQuery = useCallback<ChatSession['editQuery']>(
    async (text) => {
      setError(null);
      setQueryBusy(true);
      try {
        const q = await editQueryApi(chatId, text);
        setQuery(q);
      } catch (err) {
        setError((err as Error).message ?? 'Query edit failed.');
      } finally {
        setQueryBusy(false);
      }
    },
    [chatId],
  );

  const confirmQuery = useCallback<ChatSession['confirmQuery']>(
    async () => {
      setError(null);
      setQueryBusy(true);
      try {
        const q = await confirmQueryApi(chatId);
        setQuery(q);
        // Prime the step list so the processing card mounts immediately
        // rather than waiting for the first `processing:step` event. Mark
        // the first step as `running` so the spinner is visible right away.
        setAgentResult(null);
        setAgentSteps(() => {
          const arr = freshSteps();
          const first = arr[0];
          if (first) arr[0] = { ...first, status: 'running' };
          return arr;
        });
      } catch (err) {
        setError((err as Error).message ?? 'Query confirm failed.');
      } finally {
        setQueryBusy(false);
      }
    },
    [chatId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    chat,
    messages,
    upload,
    uploadProgress,
    uploadPreview,
    params,
    flowState,
    query,
    agentSteps,
    agentResult,
    competitorSuggestions,
    competitorsLoading,
    busy,
    queryBusy,
    error,
    send,
    pickChip,
    uploadFile,
    removeUpload,
    patchParams: patchParamsAction,
    fetchCompetitorSuggestions,
    generateQuery,
    editQuery,
    confirmQuery,
    clearError,
  };
}
