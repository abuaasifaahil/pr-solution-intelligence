'use client';

export interface ChunkPayload { assistantMessageId: string; delta: string }
export interface NewMessagePayload {
  message: {
    id: string;
    chatId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata: { chips?: Array<{ label: string; value: string }> };
  };
}
export interface ErrorPayload { assistantMessageId?: string; message: string }

// ── Phase 2 (M7.4 / M7.5 / M7.7) — upload + flow + processing payloads ─────
export interface UploadProgressPayload {
  uploadId: string;
  percent: number;
  phase: string;
}
export interface UploadParsedPayload {
  uploadId: string;
  rowCount: number;
  columns: string[];
  dateRange: { start: string; end: string } | null;
  schema: unknown[];
}
export interface UploadErrorPayload {
  uploadId: string;
  error: string;
}
export interface FlowStateChangePayload {
  /** From / to are the FlowState enum string values; we keep them as plain
   *  strings here so the frontend doesn't have to import Prisma. */
  fromState: string;
  toState: string;
  nextPrompt?: string | null;
  chatId?: string;
}

/** Per-step pipeline event emitted by DataExtractAgent (M7.7). */
export interface ProcessingStepPayload {
  chatId: string;
  stepName: string;
  stepKey: string;
  status: 'done' | 'failed';
  /** Wall time of the step in ms. */
  duration: number;
  error?: string;
}

/** Terminal pipeline event emitted by DataExtractAgent (M7.7) after the
 *  last step succeeds. */
export interface ProcessingCompletePayload {
  chatId: string;
  totalArticles: number;
  domains: number;
  /** Total elapsed time across all steps, ms. */
  totalTime: number;
}

// ── Phase 3 (M8.x) — enrichment pipeline payloads ───────────────────────────

export interface EnrichmentStartPayload {
  jobId: string;
  totalArticles: number;
  batchCount: number;
  model: string;
}
export interface EnrichmentBatchStartPayload {
  jobId: string;
  batchNumber: number;
  articleCount: number;
  estimatedTokens: number;
}
export interface EnrichmentBatchCompletePayload {
  jobId: string;
  batchNumber: number;
  processedCount: number;
  tokensUsed: number;
  duration: number;
}
export interface EnrichmentBatchErrorPayload {
  jobId: string;
  batchNumber: number;
  error: string;
  retrying: boolean;
  retryCount: number;
}
export interface EnrichmentProgressPayload {
  jobId: string;
  processed: number;
  total: number;
  percent: number;
  tokensTotal: number;
  elapsed: number;
}
export interface EnrichmentReachStartPayload {
  jobId: string;
  chatId: string;
  domains: number;
}
export interface EnrichmentReachCompletePayload {
  jobId: string;
  resolved: number;
  total: number;
  coverage: number;
  duration: number;
}
export interface EnrichmentCompletePayload {
  jobId: string;
  totalArticles: number;
  totalTokens: number;
  duration: number;
  dimensions: string[];
  status: 'completed' | 'partial' | 'failed';
}
export interface EnrichmentJsonReadyPayload {
  chatId: string;
  artifactId: string;
  articleCount: number;
}

// ── Phase 3.5 (M9.4 / M9.5.5) — intent + reach probe payloads ──────────────
//
// M9.4 IntentExtractor + M9.5.5 reach-probe both feed the M9.8
// ProbingResultCard. The extracted intent / reach-absent payload is loose
// at the WS layer because the card receives the canonical `ProbingResult`
// via a follow-up `GET /chats/:id/probe` rather than from the WS event
// itself. The events here are purely signals that "something interesting
// happened — go fetch".

export interface IntentExtractingPayload {
  chatId: string;
}

export interface IntentExtractedPayload {
  chatId: string;
  /** Source of the intent — `chat_opening` (first user message) is the
   *  M9.4 case; `manual` covers wizard-driven re-extractions. */
  source?: 'chat_opening' | 'manual';
}

export interface ReachAbsentPayload {
  chatId: string;
  /** Detected-field-presence snapshot — opaque to the frontend, used
   *  only as a signal that the probe should surface. */
  missing: string[];
}

export interface ReachResolvedPayload {
  chatId: string;
  /** What the user picked — 'enrichment' (no reach fetch) or 'enrichment_plus_reach'. */
  enrichmentType: 'enrichment' | 'enrichment_plus_reach' | 'standard' | 'reach';
}

export interface ChatStreamConfig {
  apiUrl: string;          // e.g. http://localhost:3001 or https://prsi-api.onrender.com
  chatId: string;
  accessToken: string;
}

type ServerEvent =
  | { type: 'typing:start'; payload: { assistantMessageId: string } }
  | { type: 'typing:stop'; payload: { assistantMessageId: string } }
  | { type: 'message:chunk'; payload: ChunkPayload }
  | { type: 'message:new'; payload: NewMessagePayload }
  | { type: 'agent:progress'; payload: unknown }
  | { type: 'error'; payload: ErrorPayload }
  | { type: 'upload:progress'; payload: UploadProgressPayload }
  | { type: 'upload:parsed'; payload: UploadParsedPayload }
  | { type: 'upload:error'; payload: UploadErrorPayload }
  | { type: 'flow:state-change'; payload: FlowStateChangePayload }
  | { type: 'processing:step'; payload: ProcessingStepPayload }
  | { type: 'processing:complete'; payload: ProcessingCompletePayload }
  | { type: 'enrichment:start'; payload: EnrichmentStartPayload }
  | { type: 'enrichment:batch-start'; payload: EnrichmentBatchStartPayload }
  | { type: 'enrichment:batch-complete'; payload: EnrichmentBatchCompletePayload }
  | { type: 'enrichment:batch-error'; payload: EnrichmentBatchErrorPayload }
  | { type: 'enrichment:progress'; payload: EnrichmentProgressPayload }
  | { type: 'enrichment:reach-start'; payload: EnrichmentReachStartPayload }
  | { type: 'enrichment:reach-complete'; payload: EnrichmentReachCompletePayload }
  | { type: 'enrichment:complete'; payload: EnrichmentCompletePayload }
  | { type: 'enrichment:json-ready'; payload: EnrichmentJsonReadyPayload }
  | { type: 'intent:extracting'; payload: IntentExtractingPayload }
  | { type: 'intent:extracted'; payload: IntentExtractedPayload }
  | { type: 'reach:absent'; payload: ReachAbsentPayload }
  | { type: 'reach:resolved'; payload: ReachResolvedPayload };

/**
 * Auto-reconnecting WebSocket client for /ws/chat/:chatId.
 *
 * Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap.
 * `close()` is permanent — no reconnect after the caller asks to close.
 */
export class ChatStream {
  private socket: WebSocket | null = null;
  private closedByCaller = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private chunkHandlers: Array<(p: ChunkPayload) => void> = [];
  private messageHandlers: Array<(p: NewMessagePayload) => void> = [];
  private typingHandlers: Array<(start: boolean, p: { assistantMessageId: string }) => void> = [];
  private errorHandlers: Array<(p: ErrorPayload) => void> = [];
  private uploadProgressHandlers: Array<(p: UploadProgressPayload) => void> = [];
  private uploadParsedHandlers: Array<(p: UploadParsedPayload) => void> = [];
  private uploadErrorHandlers: Array<(p: UploadErrorPayload) => void> = [];
  private flowStateHandlers: Array<(p: FlowStateChangePayload) => void> = [];
  private processingStepHandlers: Array<(p: ProcessingStepPayload) => void> = [];
  private processingCompleteHandlers: Array<(p: ProcessingCompletePayload) => void> = [];
  private enrichmentStartHandlers: Array<(p: EnrichmentStartPayload) => void> = [];
  private enrichmentBatchStartHandlers: Array<(p: EnrichmentBatchStartPayload) => void> = [];
  private enrichmentBatchCompleteHandlers: Array<(p: EnrichmentBatchCompletePayload) => void> = [];
  private enrichmentBatchErrorHandlers: Array<(p: EnrichmentBatchErrorPayload) => void> = [];
  private enrichmentProgressHandlers: Array<(p: EnrichmentProgressPayload) => void> = [];
  private enrichmentReachStartHandlers: Array<(p: EnrichmentReachStartPayload) => void> = [];
  private enrichmentReachCompleteHandlers: Array<(p: EnrichmentReachCompletePayload) => void> = [];
  private enrichmentCompleteHandlers: Array<(p: EnrichmentCompletePayload) => void> = [];
  private enrichmentJsonReadyHandlers: Array<(p: EnrichmentJsonReadyPayload) => void> = [];
  private intentExtractingHandlers: Array<(p: IntentExtractingPayload) => void> = [];
  private intentExtractedHandlers: Array<(p: IntentExtractedPayload) => void> = [];
  private reachAbsentHandlers: Array<(p: ReachAbsentPayload) => void> = [];
  private reachResolvedHandlers: Array<(p: ReachResolvedPayload) => void> = [];

  constructor(private readonly config: ChatStreamConfig) {}

  open(): void {
    if (this.socket || this.closedByCaller) return;
    const wsBase = this.config.apiUrl.replace(/^http/, 'ws');
    const url = `${wsBase}/ws/chat/${encodeURIComponent(this.config.chatId)}?token=${encodeURIComponent(this.config.accessToken)}`;
    const sock = new WebSocket(url);
    this.socket = sock;

    sock.onopen = () => {
      this.retryCount = 0;
    };
    sock.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      for (const line of raw.split('\n').filter(Boolean)) {
        let evt: ServerEvent | null = null;
        try { evt = JSON.parse(line) as ServerEvent; } catch { continue; }
        this.dispatch(evt);
      }
    };
    sock.onclose = (ev) => {
      this.socket = null;
      if (this.closedByCaller) return;
      // 1008 (policy violation: bad token / not owned) — don't reconnect.
      if (ev.code === 1008) return;
      this.scheduleReconnect();
    };
    sock.onerror = () => { /* swallow; onclose will follow */ };
  }

  close(): void {
    this.closedByCaller = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.socket) {
      try { this.socket.close(1000, 'caller closed'); } catch { /* */ }
      this.socket = null;
    }
  }

  onChunk(cb: (p: ChunkPayload) => void): void { this.chunkHandlers.push(cb); }
  onMessage(cb: (p: NewMessagePayload) => void): void { this.messageHandlers.push(cb); }
  onTyping(cb: (start: boolean, p: { assistantMessageId: string }) => void): void {
    this.typingHandlers.push(cb);
  }
  onError(cb: (p: ErrorPayload) => void): void { this.errorHandlers.push(cb); }

  // ── Phase 2 handler registrations ─────────────────────────────────────────
  onUploadProgress(cb: (p: UploadProgressPayload) => void): void {
    this.uploadProgressHandlers.push(cb);
  }
  onUploadParsed(cb: (p: UploadParsedPayload) => void): void {
    this.uploadParsedHandlers.push(cb);
  }
  onUploadError(cb: (p: UploadErrorPayload) => void): void {
    this.uploadErrorHandlers.push(cb);
  }
  onFlowStateChange(cb: (p: FlowStateChangePayload) => void): void {
    this.flowStateHandlers.push(cb);
  }
  onProcessingStep(cb: (p: ProcessingStepPayload) => void): void {
    this.processingStepHandlers.push(cb);
  }
  onProcessingComplete(cb: (p: ProcessingCompletePayload) => void): void {
    this.processingCompleteHandlers.push(cb);
  }

  // ── Phase 3 enrichment handler registrations ─────────────────────────────
  onEnrichmentStart(cb: (p: EnrichmentStartPayload) => void): void {
    this.enrichmentStartHandlers.push(cb);
  }
  onEnrichmentBatchStart(cb: (p: EnrichmentBatchStartPayload) => void): void {
    this.enrichmentBatchStartHandlers.push(cb);
  }
  onEnrichmentBatchComplete(cb: (p: EnrichmentBatchCompletePayload) => void): void {
    this.enrichmentBatchCompleteHandlers.push(cb);
  }
  onEnrichmentBatchError(cb: (p: EnrichmentBatchErrorPayload) => void): void {
    this.enrichmentBatchErrorHandlers.push(cb);
  }
  onEnrichmentProgress(cb: (p: EnrichmentProgressPayload) => void): void {
    this.enrichmentProgressHandlers.push(cb);
  }
  onEnrichmentReachStart(cb: (p: EnrichmentReachStartPayload) => void): void {
    this.enrichmentReachStartHandlers.push(cb);
  }
  onEnrichmentReachComplete(cb: (p: EnrichmentReachCompletePayload) => void): void {
    this.enrichmentReachCompleteHandlers.push(cb);
  }
  onEnrichmentComplete(cb: (p: EnrichmentCompletePayload) => void): void {
    this.enrichmentCompleteHandlers.push(cb);
  }
  onEnrichmentJsonReady(cb: (p: EnrichmentJsonReadyPayload) => void): void {
    this.enrichmentJsonReadyHandlers.push(cb);
  }

  // ── Phase 3.5 (M9.4 / M9.5.5 / M9.8) — intent + reach handlers ───────────
  onIntentExtracting(cb: (p: IntentExtractingPayload) => void): void {
    this.intentExtractingHandlers.push(cb);
  }
  onIntentExtracted(cb: (p: IntentExtractedPayload) => void): void {
    this.intentExtractedHandlers.push(cb);
  }
  onReachAbsent(cb: (p: ReachAbsentPayload) => void): void {
    this.reachAbsentHandlers.push(cb);
  }
  onReachResolved(cb: (p: ReachResolvedPayload) => void): void {
    this.reachResolvedHandlers.push(cb);
  }

  private dispatch(evt: ServerEvent): void {
    switch (evt.type) {
      case 'typing:start':
        for (const h of this.typingHandlers) h(true, evt.payload);
        return;
      case 'typing:stop':
        for (const h of this.typingHandlers) h(false, evt.payload);
        return;
      case 'message:chunk':
        for (const h of this.chunkHandlers) h(evt.payload);
        return;
      case 'message:new':
        for (const h of this.messageHandlers) h(evt.payload);
        return;
      case 'error':
        for (const h of this.errorHandlers) h(evt.payload);
        return;
      case 'upload:progress':
        for (const h of this.uploadProgressHandlers) h(evt.payload);
        return;
      case 'upload:parsed':
        for (const h of this.uploadParsedHandlers) h(evt.payload);
        return;
      case 'upload:error':
        for (const h of this.uploadErrorHandlers) h(evt.payload);
        return;
      case 'flow:state-change':
        for (const h of this.flowStateHandlers) h(evt.payload);
        return;
      case 'processing:step':
        for (const h of this.processingStepHandlers) h(evt.payload);
        return;
      case 'processing:complete':
        for (const h of this.processingCompleteHandlers) h(evt.payload);
        return;
      case 'enrichment:start':
        for (const h of this.enrichmentStartHandlers) h(evt.payload);
        return;
      case 'enrichment:batch-start':
        for (const h of this.enrichmentBatchStartHandlers) h(evt.payload);
        return;
      case 'enrichment:batch-complete':
        for (const h of this.enrichmentBatchCompleteHandlers) h(evt.payload);
        return;
      case 'enrichment:batch-error':
        for (const h of this.enrichmentBatchErrorHandlers) h(evt.payload);
        return;
      case 'enrichment:progress':
        for (const h of this.enrichmentProgressHandlers) h(evt.payload);
        return;
      case 'enrichment:reach-start':
        for (const h of this.enrichmentReachStartHandlers) h(evt.payload);
        return;
      case 'enrichment:reach-complete':
        for (const h of this.enrichmentReachCompleteHandlers) h(evt.payload);
        return;
      case 'enrichment:complete':
        for (const h of this.enrichmentCompleteHandlers) h(evt.payload);
        return;
      case 'enrichment:json-ready':
        for (const h of this.enrichmentJsonReadyHandlers) h(evt.payload);
        return;
      case 'intent:extracting':
        for (const h of this.intentExtractingHandlers) h(evt.payload);
        return;
      case 'intent:extracted':
        for (const h of this.intentExtractedHandlers) h(evt.payload);
        return;
      case 'reach:absent':
        for (const h of this.reachAbsentHandlers) h(evt.payload);
        return;
      case 'reach:resolved':
        for (const h of this.reachResolvedHandlers) h(evt.payload);
        return;
      case 'agent:progress':
        // Phase 1 / Phase 3 — Orchestrator + Strategy agents emit this. We
        // don't surface it yet; future milestones can add a handler list.
        return;
    }
  }

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.retryCount, delays.length - 1)] ?? 30000;
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }
}
