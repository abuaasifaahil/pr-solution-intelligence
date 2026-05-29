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
  | { type: 'error'; payload: ErrorPayload };

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
      case 'agent:progress':
        // Phase 3+ event; ignored in Phase 1.
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
