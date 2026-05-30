'use client';
import { useEffect, useMemo, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChatActionPrompt } from './ChatActionPrompt';
import type { ChatActionOption, ChatActionResult } from './ChatActionPrompt';
import type { ChatMessage, ChipDef } from '../../lib/chats';

interface Props {
  messages: ChatMessage[];
  onChipPick: (chip: ChipDef) => void;
  onCustomReply?: (text: string) => void;
  busy?: boolean;
}

/**
 * Renders the chat thread plus, when the last assistant message ships chips,
 * an inline ChatActionPrompt (Claude Code style). Picking a chip routes
 * through onChipPick; picking the auto-added "Other — type your own" row
 * routes through onCustomReply (free-text path).
 */
export function MessageThread({ messages, onChipPick, onCustomReply, busy }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const last = messages[messages.length - 1];
  const lastChips: ChipDef[] = last?.role === 'assistant' ? (last.metadata.chips ?? []) : [];

  // Map chips 1:1 to ChatActionOption. The prompt itself appends the
  // "Other — type your own" row when allowCustom is true, so we don't add
  // it here. New instance per chip-set so the prompt resets on each turn.
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

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3.5">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}

      {!busy && promptOptions.length > 0 && (
        <div className="pl-10">
          {/* `key` on the last message id ensures the prompt state resets
              every assistant turn (fresh highlight + input draft). */}
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
