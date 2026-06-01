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

// ── Phase 2 (M7.4 / M7.5) — upload + flow event payloads ────────────────────
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
  // M7.7-era events — wired by M7.9, but tolerated here so they don't
  // produce noisy JSON-parse warnings on the console.
  | { type: 'processing:step'; payload: unknown }
  | { type: 'processing:complete'; payload: unknown };

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
      case 'agent:progress':
      case 'processing:step':
      case 'processing:complete':
        // Wired by M7.9 (processing UX). Acknowledged here so unknown-type
        // logs don't trip during the upload flow.
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
