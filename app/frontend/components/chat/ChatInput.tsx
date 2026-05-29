'use client';
import { useState, type FormEvent } from 'react';

export function ChatInput({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('');

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-border-default bg-surface-card px-5 py-3.5 flex items-center gap-2.5"
    >
      <button
        type="button"
        disabled
        className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary
                   hover:bg-surface-hover transition disabled:opacity-40 disabled:cursor-not-allowed"
        title="Attachment — coming in Phase 2"
      >
        📎
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message…"
        disabled={disabled}
        className="flex-1 px-3.5 py-2.5 text-sm border border-border-default rounded-md
                   bg-surface-card text-text-primary outline-none
                   focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                   transition disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={disabled || text.trim().length === 0}
        className="px-4 py-2.5 text-sm font-semibold rounded-md
                   bg-win-blue-500 text-white shadow-win-2
                   hover:bg-win-blue-600 active:bg-win-blue-700
                   disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        Send
      </button>
    </form>
  );
}
