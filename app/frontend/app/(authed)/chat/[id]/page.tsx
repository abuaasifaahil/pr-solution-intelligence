'use client';
import { useEffect, useState, use } from 'react';
import { Topbar } from '../../../../components/layout/Topbar';
import { MessageThread } from '../../../../components/chat/MessageThread';
import { ChatInput } from '../../../../components/chat/ChatInput';
import {
  getChat, listMessages, sendMessage,
  type ChatDetail, type ChatMessage, type ChipDef,
} from '../../../../lib/chats';
import { ApiError } from '../../../../lib/api-client';
import { useRouter } from 'next/navigation';

interface PageProps { params: Promise<{ id: string }> }

export default function ChatPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, m] = await Promise.all([getChat(id), listMessages(id)]);
        if (!cancelled) {
          setChat(c);
          setMessages(m);
        }
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

  async function handleSend(content: string, choice?: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await sendMessage(id, content, choice);
      setMessages((prev) => [...prev, out.userMessage, out.aiMessage]);
    } catch {
      setError('Message failed. Try again.');
    } finally {
      setBusy(false);
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
