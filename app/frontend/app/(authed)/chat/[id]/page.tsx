'use client';
import { useEffect, useState } from 'react';
import { Topbar } from '../../../../components/layout/Topbar';
import { MessageThread } from '../../../../components/chat/MessageThread';
import { ChatInput } from '../../../../components/chat/ChatInput';
import { FlowDotIndicator } from '../../../../components/chat/FlowDotIndicator';
import { useAuthStore } from '../../../../lib/auth-store';
import { useChatSession } from '../../../../hooks/useChatSession';
import { useEnrichmentSession } from '../../../../hooks/useEnrichmentSession';
import { ChatStream } from '../../../../lib/chat-stream';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Next 14 passes `params` as a plain object. (Next 15 changed it to a Promise
// that needs `use()` — DO NOT switch to that pattern until the Next 15 upgrade.)
interface PageProps { params: { id: string } }

/**
 * Chat page — M7.9.
 *
 * Thin shell over `useChatSession` (M7.9). All chat / upload / params /
 * query / processing state lives in the hook; this component is purely
 * presentational, wiring callbacks into MessageThread.
 */
export default function ChatPage({ params }: PageProps) {
  const { id } = params;
  const accessToken = useAuthStore((s) => s.accessToken);
  const session = useChatSession(id, accessToken);

  // ── Phase 3 (M8.8) — dedicated WS subscription for enrichment events.
  // useChatSession owns its own ChatStream and doesn't expose it, so we
  // mount a second subscription here. The backend pub/sub layer multicasts
  // per-chat, so two listeners is supported by design.
  const [enrichStream, setEnrichStream] = useState<ChatStream | null>(null);
  useEffect(() => {
    if (!accessToken) return;
    const cs = new ChatStream({ apiUrl: API_URL, chatId: id, accessToken });
    cs.open();
    setEnrichStream(cs);
    return () => { cs.close(); setEnrichStream(null); };
  }, [id, accessToken]);

  const enrichment = useEnrichmentSession(id, enrichStream, {
    enabled: session.flowState === 'complete',
  });

  // Pre-compute the date-range payload so the per-preset handler stays
  // small. Backend accepts ISO strings — see lib/chat-params.ts.
  function presetToRange(preset: 'weekly' | 'ten_days' | 'twenty_days'): {
    start: string;
    end: string;
  } {
    const end = new Date();
    const days = preset === 'weekly' ? 7 : preset === 'ten_days' ? 10 : 20;
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  return (
    <>
      <Topbar title={session.chat?.title ?? 'Chat'} badge="Online" />
      <FlowDotIndicator currentState={session.flowState} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {session.error && (
          <div
            role="alert"
            className="bg-red-50 border-b border-red-200 text-win-red text-sm px-5 py-2"
          >
            {session.error}
          </div>
        )}
        <MessageThread
          chatId={id}
          messages={session.messages}
          onChipPick={session.pickChip}
          onCustomReply={(text) => void session.send(text)}
          busy={session.busy}
          upload={session.upload}
          uploadProgress={session.uploadProgress}
          uploadPreview={session.uploadPreview}
          onFileDrop={(f) => void session.uploadFile(f)}
          onUploadRemove={() => void session.removeUpload()}
          allowUpload
          // ── Phase 2 — flow + query + processing ───────────────────────
          flowState={session.flowState}
          params={session.params}
          query={session.query}
          competitorSuggestions={session.competitorSuggestions}
          competitorsLoading={session.competitorsLoading}
          agentSteps={session.agentSteps}
          agentResult={session.agentResult}
          queryBusy={session.queryBusy}
          onDatePreset={(preset) => {
            const range = presetToRange(preset);
            void session.patchParams({
              dateRangeType: preset,
              dateStart: range.start,
              dateEnd: range.end,
            });
          }}
          onCustomDate={(start, end) => {
            void session.patchParams({
              dateRangeType: 'custom',
              dateStart: start.toISOString(),
              dateEnd: end.toISOString(),
            });
          }}
          onEnrichmentPick={(kind, threshold) => {
            void session.patchParams({
              enrichmentType: kind,
              reachThreshold: kind === 'reach' ? threshold ?? null : null,
            });
          }}
          onBrandSubmit={(brand) => {
            void session.patchParams({ brand });
            void session.fetchCompetitorSuggestions(brand);
          }}
          onCompetitorsSubmit={(competitors, set) => {
            void session.patchParams({
              competitors,
              competitorSet: set,
            });
          }}
          onIntentionPick={(intention) => {
            void session.patchParams({ intention });
          }}
          onQueryEdit={(text) => void session.editQuery(text)}
          onQueryConfirm={() => void session.confirmQuery()}
          // ── Phase 3 (M8.8) — enrichment progress card ───────────────
          enrichment={enrichment}
        />
        <ChatInput
          onSend={(text) => session.send(text)}
          disabled={session.busy}
        />
      </div>
    </>
  );
}
