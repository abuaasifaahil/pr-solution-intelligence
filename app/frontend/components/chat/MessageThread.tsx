'use client';
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ChipRow } from './ChipRow';
import type { ChatMessage, ChipDef } from '../../lib/chats';

interface Props {
  messages: ChatMessage[];
  onChipPick: (chip: ChipDef) => void;
  busy?: boolean;
}

export function MessageThread({ messages, onChipPick, busy }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const last = messages[messages.length - 1];
  const lastChips: ChipDef[] = last?.role === 'assistant' ? (last.metadata.chips ?? []) : [];

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3.5">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {!busy && <ChipRow chips={lastChips} onPick={onChipPick} />}
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
