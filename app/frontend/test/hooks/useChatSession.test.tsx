import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────
// Capture the most-recent ChatStream instance so the test can drive its
// WebSocket handlers directly without standing up a real socket.

interface MockStream {
  open: () => void;
  close: () => void;
  fire: {
    typing?: (start: boolean, p: { assistantMessageId: string }) => void;
    chunk?: (p: { assistantMessageId: string; delta: string }) => void;
    message?: (p: unknown) => void;
    error?: (p: { message: string }) => void;
    uploadProgress?: (p: { uploadId: string; percent: number }) => void;
    uploadParsed?: (p: { uploadId: string }) => void;
    uploadError?: (p: { uploadId: string; error: string }) => void;
    flowState?: (p: { fromState: string; toState: string }) => void;
    processingStep?: (p: {
      chatId: string;
      stepName: string;
      stepKey: string;
      status: 'done' | 'failed';
      duration: number;
      error?: string;
    }) => void;
    processingComplete?: (p: {
      chatId: string;
      totalArticles: number;
      domains: number;
      totalTime: number;
    }) => void;
  };
}

const streams: MockStream[] = [];

vi.mock('../../lib/chat-stream', () => {
  class ChatStream {
    private fire: MockStream['fire'] = {};
    constructor() {
      const me: MockStream = {
        open: () => {},
        close: () => {},
        fire: this.fire,
      };
      streams.push(me);
    }
    open() {}
    close() {}
    onChunk(cb: NonNullable<MockStream['fire']['chunk']>) { this.fire.chunk = cb; }
    onMessage(cb: NonNullable<MockStream['fire']['message']>) { this.fire.message = cb; }
    onTyping(cb: NonNullable<MockStream['fire']['typing']>) { this.fire.typing = cb; }
    onError(cb: NonNullable<MockStream['fire']['error']>) { this.fire.error = cb; }
    onUploadProgress(cb: NonNullable<MockStream['fire']['uploadProgress']>) {
      this.fire.uploadProgress = cb;
    }
    onUploadParsed(cb: NonNullable<MockStream['fire']['uploadParsed']>) {
      this.fire.uploadParsed = cb;
    }
    onUploadError(cb: NonNullable<MockStream['fire']['uploadError']>) {
      this.fire.uploadError = cb;
    }
    onFlowStateChange(cb: NonNullable<MockStream['fire']['flowState']>) {
      this.fire.flowState = cb;
    }
    onProcessingStep(cb: NonNullable<MockStream['fire']['processingStep']>) {
      this.fire.processingStep = cb;
    }
    onProcessingComplete(cb: NonNullable<MockStream['fire']['processingComplete']>) {
      this.fire.processingComplete = cb;
    }
  }
  return { ChatStream };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock('../../lib/chats', () => ({
  getChat: vi.fn(async () => ({
    id: 'c1',
    agentType: 'pr',
    title: 'Test chat',
    status: 'active',
    context: {},
    updatedAt: '2026-01-01T00:00:00Z',
  })),
  listMessages: vi.fn(async () => []),
  sendMessage: vi.fn(),
}));

vi.mock('../../lib/uploads', () => ({
  createUpload: vi.fn(),
  getUpload: vi.fn(),
  getUploadPreview: vi.fn(),
  deleteUpload: vi.fn(),
}));

vi.mock('../../lib/chat-params', () => ({
  getOrCreateParams: vi.fn(async () => ({
    params: {
      id: 'p1',
      chatId: 'c1',
      userId: 'u1',
      flowState: 'init',
      dateRangeType: null,
      dateStart: null,
      dateEnd: null,
      enrichmentType: null,
      reachThreshold: null,
      brand: null,
      competitors: null,
      competitorSet: null,
      intention: null,
      hasUpload: false,
      uploadId: null,
      collectedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    flowState: 'init',
  })),
  patchChatParams: vi.fn(),
  suggestCompetitorsForBrand: vi.fn(),
}));

vi.mock('../../lib/boolean-query', () => ({
  generateQuery: vi.fn(),
  editQuery: vi.fn(),
  confirmQuery: vi.fn(),
  getLatestQuery: vi.fn(async () => null),
}));

const { useChatSession } = await import('../../hooks/useChatSession');
const chatsMod = await import('../../lib/chats');
const paramsMod = await import('../../lib/chat-params');
const queryMod = await import('../../lib/boolean-query');

beforeEach(() => {
  streams.length = 0;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); });

describe('useChatSession', () => {
  it('initial load fetches chat + messages + params + latest query in parallel', async () => {
    const { result } = renderHook(() => useChatSession('c1', 'tok'));

    await waitFor(() => expect(result.current.chat).not.toBeNull());

    expect(chatsMod.getChat).toHaveBeenCalledWith('c1');
    expect(chatsMod.listMessages).toHaveBeenCalledWith('c1');
    expect(paramsMod.getOrCreateParams).toHaveBeenCalledWith('c1');
    expect(queryMod.getLatestQuery).toHaveBeenCalledWith('c1');
    expect(result.current.flowState).toBe('init');
    expect(result.current.agentSteps).toHaveLength(7);
    expect(result.current.agentSteps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('flow:state-change updates flowState', async () => {
    const { result } = renderHook(() => useChatSession('c1', 'tok'));
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    act(() => {
      streams[0]!.fire.flowState?.({
        fromState: 'init',
        toState: 'collect_brand',
      });
    });

    expect(result.current.flowState).toBe('collect_brand');
  });

  it('processing:step marks the matching slot as done and advances the next one to running', async () => {
    const { result } = renderHook(() => useChatSession('c1', 'tok'));
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    act(() => {
      streams[0]!.fire.processingStep?.({
        chatId: 'c1',
        stepName: 'Validate Schema',
        stepKey: 'validate',
        status: 'done',
        duration: 42,
      });
    });

    const steps = result.current.agentSteps;
    expect(steps[0]!.status).toBe('done');
    expect(steps[0]!.durationMs).toBe(42);
    // Next pending step is now `running`.
    expect(steps[1]!.status).toBe('running');
    expect(steps[2]!.status).toBe('pending');
  });

  it('processing:step with status=failed surfaces error and does NOT advance the next slot', async () => {
    const { result } = renderHook(() => useChatSession('c1', 'tok'));
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    act(() => {
      streams[0]!.fire.processingStep?.({
        chatId: 'c1',
        stepName: 'Parse Articles',
        stepKey: 'parse',
        status: 'failed',
        duration: 100,
        error: 'Bad row',
      });
    });

    const steps = result.current.agentSteps;
    const parse = steps.find((s) => s.key === 'parse')!;
    expect(parse.status).toBe('failed');
    expect(parse.error).toBe('Bad row');
    // No subsequent step was promoted to running.
    expect(steps.filter((s) => s.status === 'running')).toHaveLength(0);
  });

  it('processing:complete populates agentResult with the canonical 3 stats', async () => {
    const { result } = renderHook(() => useChatSession('c1', 'tok'));
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    act(() => {
      streams[0]!.fire.processingComplete?.({
        chatId: 'c1',
        totalArticles: 1234,
        domains: 89,
        totalTime: 12300,
      });
    });

    expect(result.current.agentResult).not.toBeNull();
    expect(result.current.agentResult?.stats.Articles).toBe(1234);
    expect(result.current.agentResult?.stats.Domains).toBe(89);
    expect(result.current.agentResult?.stats['Total time']).toBe('12.3s');
    expect(result.current.agentResult?.summaryText).toMatch(/1234 articles · 89 domains · 12\.3s/);
  });
});
