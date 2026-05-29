'use client';
import { useEffect, useRef, useState, use } from 'react';
import { Topbar } from '../../../../components/layout/Topbar';
import { MessageThread } from '../../../../components/chat/MessageThread';
import { ChatInput } from '../../../../components/chat/ChatInput';
import {
  getChat, listMessages, sendMessage,
  type ChatDetail, type ChatMessage, type ChipDef,
} from '../../../../lib/chats';
import { ApiError } from '../../../../lib/api-client';
import { useAuthStore } from '../../../../lib/auth-store';
import { ChatStream } from '../../../../lib/chat-stream';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface PageProps { params: Promise<{ id: string }> }

export default function ChatPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<ChatStream | null>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, m] = await Promise.all([getChat(id), listMessages(id)]);
        if (!cancelled) { setChat(c); setMessages(m); }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          router.replace('/');
          return;
        }
        if (!cancelled) setError('Failed to load chat.');
      }
    })();
    return () => { cancelled = true; };
  }, [id, router]);

  // Mount the WebSocket.
  useEffect(() => {
    if (!accessToken) return;
    const cs = new ChatStream({ apiUrl: API_URL, chatId: id, accessToken });
    streamRef.current = cs;

    cs.onTyping((start) => setBusy(start));

    cs.onChunk(({ assistantMessageId, delta }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: m.content + delta }
            : m,
        ),
      );
    });

    cs.onMessage(({ message }) => {
      // Server is authoritative — replace the placeholder/streamed bubble.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id
            ? { ...m, content: message.content, metadata: message.metadata }
            : m,
        ),
      );
    });

    cs.onError(({ message }) => {
      setError(message || 'Stream error.');
      setBusy(false);
    });

    cs.open();
    return () => { cs.close(); streamRef.current = null; };
  }, [id, accessToken]);

  async function handleSend(content: string, choice?: string): Promise<void> {
    if (busy) return;
    setError(null);
    try {
      const out = await sendMessage(id, content, choice);
      // Append user bubble + empty placeholder assistant bubble keyed by assistantMessageId.
      // Chips come back synchronously from the state machine.
      const placeholder: ChatMessage = {
        id: out.assistantMessageId,
        chatId: id,
        role: 'assistant',
        content: '',
        metadata: { chips: out.chips },
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, out.userMessage, placeholder]);
      // busy will be set true by typing:start on the WS.
    } catch {
      setError('Message failed. Try again.');
    }
  }

  function handleChip(chip: ChipDef): void {
    void handleSend(chip.label, chip.value);
  }

  return (
    <>
      <Topbar title={chat?.title ?? 'Chat'} badge="Online" />
      <div className="flex-1 flex flex-col overflow-hidden">
        {error && (
          <div role="alert" className="bg-red-50 border-b border-red-200 text-win-red text-sm px-5 py-2">
            {error}
          </div>
        )}
        <MessageThread messages={messages} onChipPick={handleChip} busy={busy} />
        <ChatInput onSend={(text) => handleSend(text)} disabled={busy} />
      </div>
    </>
  );
}
