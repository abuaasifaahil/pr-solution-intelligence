'use client';
import { useEffect, useRef, useState } from 'react';
import { Topbar } from '../../../../components/layout/Topbar';
import { MessageThread } from '../../../../components/chat/MessageThread';
import { ChatInput } from '../../../../components/chat/ChatInput';
import { FlowDotIndicator, type FlowStateLiteral } from '../../../../components/chat/FlowDotIndicator';
import {
  getChat, listMessages, sendMessage,
  type ChatDetail, type ChatMessage, type ChipDef,
} from '../../../../lib/chats';
import {
  createUpload, getUpload, getUploadPreview,
  type UploadStatus, type UploadPreview,
} from '../../../../lib/uploads';
import { ApiError } from '../../../../lib/api-client';
import { useAuthStore } from '../../../../lib/auth-store';
import { ChatStream } from '../../../../lib/chat-stream';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Next 14 passes `params` as a plain object. (Next 15 changed it to a Promise
// that needs `use()` — DO NOT switch to that pattern until the Next 15 upgrade.)
interface PageProps { params: { id: string } }

export default function ChatPage({ params }: PageProps) {
  const { id } = params;
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<ChatStream | null>(null);

  // ── Phase 2 upload state (M7.8) ───────────────────────────────────────────
  const [upload, setUpload] = useState<UploadStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | undefined>(undefined);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [currentFlowState, setCurrentFlowState] = useState<FlowStateLiteral>('init');
  // Mirror the latest upload ID into a ref so WS handlers (created once per
  // chat mount) can match incoming events without going stale on state.
  const uploadIdRef = useRef<string | null>(null);
  useEffect(() => { uploadIdRef.current = upload?.id ?? null; }, [upload?.id]);

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

    // ── Phase 2 upload events ───────────────────────────────────────────────
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

    // M7.9 will lean on this to drive the chip flow + processing card. For
    // M7.8 we just keep the indicator in sync with whatever the engine emits.
    cs.onFlowStateChange(({ toState }) => {
      setCurrentFlowState(toState as FlowStateLiteral);
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

  async function handleFileDrop(file: File): Promise<void> {
    setError(null);
    setUploadProgress(0);
    setUploadPreview(null);
    try {
      const { upload: u } = await createUpload(file, id);
      setUpload(u);
      // WS `upload:parsed` / `upload:error` will take over from here.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setError(message);
      setUploadProgress(undefined);
    }
  }

  function handleUploadRemove(): void {
    // Local-only dismiss for now — backend cleanup (DELETE) wires in M7.9
    // alongside the chip-driven flow. The user can re-drop a new file.
    setUpload(null);
    setUploadPreview(null);
    setUploadProgress(undefined);
  }

  return (
    <>
      <Topbar title={chat?.title ?? 'Chat'} badge="Online" />
      <FlowDotIndicator currentState={currentFlowState} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {error && (
          <div role="alert" className="bg-red-50 border-b border-red-200 text-win-red text-sm px-5 py-2">
            {error}
          </div>
        )}
        <MessageThread
          messages={messages}
          onChipPick={handleChip}
          onCustomReply={(text) => void handleSend(text)}
          busy={busy}
          upload={upload}
          uploadProgress={uploadProgress}
          uploadPreview={uploadPreview}
          onFileDrop={(f) => void handleFileDrop(f)}
          onUploadRemove={handleUploadRemove}
          allowUpload
        />
        <ChatInput onSend={(text) => handleSend(text)} disabled={busy} />
      </div>
    </>
  );
}
