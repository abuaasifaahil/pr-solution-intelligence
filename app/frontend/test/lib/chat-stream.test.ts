import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket on globalThis.
class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0; // CONNECTING
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
    // Defer open so the caller can wire handlers.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }
  send(data: string) { this.sent.push(data); }
  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  }
  receive(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  triggerClose(code: number) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

vi.stubGlobal('WebSocket', MockSocket);

const { ChatStream } = await import('../../lib/chat-stream');

describe('ChatStream', () => {
  beforeEach(() => { MockSocket.instances.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('connects to /ws/chat/:id with token query param', async () => {
    const cs = new ChatStream({ apiUrl: 'http://localhost:3001', chatId: 'c1', accessToken: 'tok' });
    cs.open();
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(MockSocket.instances[0]?.url).toBe('ws://localhost:3001/ws/chat/c1?token=tok');
    cs.close();
  });

  it('routes typed events to handlers', async () => {
    const cs = new ChatStream({ apiUrl: 'http://localhost:3001', chatId: 'c1', accessToken: 'tok' });
    const chunks: Array<{ assistantMessageId: string; delta: string }> = [];
    const messages: unknown[] = [];
    const typings: boolean[] = [];
    cs.onChunk((p) => chunks.push(p));
    cs.onMessage((p) => messages.push(p));
    cs.onTyping((start) => typings.push(start));
    cs.open();
    await new Promise((r) => queueMicrotask(() => r(null)));

    const sock = MockSocket.instances[0]!;
    sock.receive(JSON.stringify({ type: 'typing:start', payload: { assistantMessageId: 'a' } }) + '\n');
    sock.receive(JSON.stringify({ type: 'message:chunk', payload: { assistantMessageId: 'a', delta: 'Hi' } }) + '\n');
    sock.receive(JSON.stringify({ type: 'typing:stop', payload: { assistantMessageId: 'a' } }) + '\n');
    sock.receive(JSON.stringify({ type: 'message:new', payload: { message: { id: 'a', content: 'Hi' } } }) + '\n');

    expect(typings).toEqual([true, false]);
    expect(chunks).toEqual([{ assistantMessageId: 'a', delta: 'Hi' }]);
    expect(messages).toHaveLength(1);
    cs.close();
  });

  it('reconnects with exponential backoff on abnormal close', async () => {
    vi.useFakeTimers();
    const cs = new ChatStream({ apiUrl: 'http://localhost:3001', chatId: 'c1', accessToken: 'tok' });
    cs.open();
    await new Promise((r) => queueMicrotask(() => r(null)));
    MockSocket.instances[0]!.triggerClose(1006);
    // First retry at 1s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockSocket.instances.length).toBe(2);
    MockSocket.instances[1]!.triggerClose(1006);
    // Second retry at 2s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockSocket.instances.length).toBe(3);
    cs.close();
  });

  it('does NOT reconnect after explicit close()', async () => {
    vi.useFakeTimers();
    const cs = new ChatStream({ apiUrl: 'http://localhost:3001', chatId: 'c1', accessToken: 'tok' });
    cs.open();
    await new Promise((r) => queueMicrotask(() => r(null)));
    cs.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockSocket.instances.length).toBe(1);
  });
});
