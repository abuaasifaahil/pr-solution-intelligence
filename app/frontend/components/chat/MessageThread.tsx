'use client';
import { useEffect, useMemo, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChatActionPrompt } from './ChatActionPrompt';
import type { ChatActionOption, ChatActionResult } from './ChatActionPrompt';
import { FileDropZone } from './FileDropZone';
import { UploadProgressCard } from './UploadProgressCard';
import { DataPreviewTable } from './DataPreviewTable';
import { FlowStepPrompt } from './FlowStepPrompt';
import { BooleanQueryPreview } from './BooleanQueryPreview';
import { AgentActionPanel } from './AgentActionPanel';
import type { ChatMessage, ChipDef } from '../../lib/chats';
import type { UploadStatus, UploadPreview } from '../../lib/uploads';
import type {
  ChatParams,
  CompetitorSet,
  CompetitorSuggestions,
} from '../../lib/chat-params';
import type { BooleanQuery } from '../../lib/boolean-query';
import type { FlowStateLiteral } from '../../lib/flow-states';
import type { AgentStep } from './ProcessingSteps';
import type { AgentActionResult } from './AgentActionPanel';

interface Props {
  messages: ChatMessage[];
  onChipPick: (chip: ChipDef) => void;
  onCustomReply?: (text: string) => void;
  busy?: boolean;

  // ── Phase 2 — upload state (M7.8) ────────────────────────────────────────
  upload?: UploadStatus | null;
  uploadProgress?: number;
  uploadPreview?: UploadPreview | null;
  onFileDrop?: (file: File) => void;
  onUploadRemove?: () => void;
  /** Enables the empty-state drop zone. Off by default. */
  allowUpload?: boolean;

  // ── Phase 2 — flow + query + processing state (M7.9) ─────────────────────
  flowState?: FlowStateLiteral;
  params?: ChatParams | null;
  query?: BooleanQuery | null;
  competitorSuggestions?: CompetitorSuggestions | null;
  competitorsLoading?: boolean;
  agentSteps?: AgentStep[];
  agentResult?: AgentActionResult | null;
  queryBusy?: boolean;
  onDatePreset?: (preset: 'weekly' | 'ten_days' | 'twenty_days') => void;
  onCustomDate?: (start: Date, end: Date) => void;
  onEnrichmentPick?: (kind: 'standard' | 'reach', threshold?: number) => void;
  onBrandSubmit?: (brand: string) => void;
  onCompetitorsSubmit?: (competitors: string[], set: CompetitorSet) => void;
  onIntentionPick?: (intention: 'intention_based' | 'comment_based') => void;
  onQueryEdit?: (text: string) => void;
  onQueryConfirm?: () => void;
}

/**
 * Renders the chat thread plus context-sensitive Phase 2 UI:
 *
 *   - File drop zone in the empty state.
 *   - Upload progress / metadata card + data preview table while a file
 *     is in flight or just landed (M7.8).
 *   - Per-step inline prompts driven by `flowState` (M7.9) — the chip
 *     flow.
 *   - Boolean query preview at `generate_query` (M7.9).
 *   - Agent action panel during/after `processing` (M7.9).
 *
 * The legacy Phase 1 ChatActionPrompt (orchestrator chips on the last
 * assistant message) still renders alongside — both can coexist; the
 * orchestrator is the M3 flow and Phase 2 is a separate state machine.
 */
export function MessageThread({
  messages,
  onChipPick,
  onCustomReply,
  busy,
  upload,
  uploadProgress,
  uploadPreview,
  onFileDrop,
  onUploadRemove,
  allowUpload,
  flowState,
  params,
  query,
  competitorSuggestions,
  competitorsLoading,
  agentSteps,
  agentResult,
  queryBusy,
  onDatePreset,
  onCustomDate,
  onEnrichmentPick,
  onBrandSubmit,
  onCompetitorsSubmit,
  onIntentionPick,
  onQueryEdit,
  onQueryConfirm,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [
    messages.length,
    busy,
    upload?.status,
    uploadPreview,
    flowState,
    query?.id,
    agentSteps,
    agentResult,
  ]);

  const last = messages[messages.length - 1];
  const lastChips: ChipDef[] = last?.role === 'assistant' ? (last.metadata.chips ?? []) : [];

  const promptOptions = useMemo<ChatActionOption[]>(
    () => lastChips.map((c) => ({ id: c.value, label: c.label })),
    [lastChips],
  );

  function handleResult(r: ChatActionResult): void {
    if (r.customText && onCustomReply) {
      onCustomReply(r.customText);
      return;
    }
    const chip = lastChips.find((c) => c.value === r.id);
    if (chip) onChipPick(chip);
  }

  const showDropZone =
    !!allowUpload && !!onFileDrop && messages.length === 0 && !upload;

  // Phase 2 — which flow step needs a custom input component?
  const flowStepStates: FlowStateLiteral[] = [
    'collect_dates',
    'collect_enrichment',
    'collect_brand',
    'collect_competitors',
    'collect_intention',
  ];
  const showFlowStepPrompt =
    flowState != null && flowStepStates.includes(flowState);
  const showQueryPreview =
    flowState === 'generate_query' && query != null;
  const showAgentPanel =
    (flowState === 'processing' || flowState === 'complete') &&
    !!agentSteps &&
    agentSteps.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3.5">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}

      {upload && (
        <UploadProgressCard
          upload={upload}
          progressPercent={uploadProgress}
          onRemove={onUploadRemove}
        />
      )}

      {upload?.status === 'ready' && uploadPreview && (
        <DataPreviewTable
          rows={uploadPreview.rows}
          columns={uploadPreview.columns}
          total={uploadPreview.total}
        />
      )}

      {showDropZone && onFileDrop && (
        <FileDropZone onFile={onFileDrop} />
      )}

      {showFlowStepPrompt && flowState && (
        <FlowStepPrompt
          state={flowState}
          params={params ?? null}
          competitorSuggestions={competitorSuggestions ?? null}
          competitorsLoading={competitorsLoading}
          onDatePreset={onDatePreset ?? (() => {})}
          onCustomDate={onCustomDate ?? (() => {})}
          onEnrichmentPick={onEnrichmentPick ?? (() => {})}
          onBrandSubmit={onBrandSubmit ?? (() => {})}
          onCompetitorsSubmit={onCompetitorsSubmit ?? (() => {})}
          onIntentionPick={onIntentionPick ?? (() => {})}
        />
      )}

      {showQueryPreview && (
        <BooleanQueryPreview
          query={query ?? null}
          onEdit={onQueryEdit ?? (() => {})}
          onConfirm={onQueryConfirm ?? (() => {})}
          busy={queryBusy}
        />
      )}

      {showAgentPanel && agentSteps && (
        <AgentActionPanel
          agentName="Data Extract Agent"
          steps={agentSteps}
          result={agentResult ?? null}
          // Open by default the moment the run completes; user can collapse.
          defaultSummaryOpen={flowState === 'complete'}
        />
      )}

      {/* Phase 1 — orchestrator chips on the latest assistant message. Only
          render when no Phase 2 flow-step prompt is taking over the spot. */}
      {!busy && promptOptions.length > 0 && !showFlowStepPrompt && (
        <div className="pl-10">
          <ChatActionPrompt
            key={last?.id ?? 'none'}
            question="Pick a response — or choose 'Other' to type your own."
            options={promptOptions}
            onSelect={handleResult}
          />
        </div>
      )}

      {busy && (
        <div className="flex gap-2.5 pl-10 text-text-tertiary text-[0.82rem]">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse" style={{ animationDelay: '120ms' }}>●</span>
          <span className="animate-pulse" style={{ animationDelay: '240ms' }}>●</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
