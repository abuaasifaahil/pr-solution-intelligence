'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createChat, type AgentSummary } from '../../lib/chats';

export function AgentCard({ agent }: { agent: AgentSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const { chat } = await createChat(agent.type);
      router.push(`/chat/${chat.id}`);
    } catch {
      setBusy(false);
    }
  }

  const color = agent.color ?? '#0078D4';

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="text-left bg-surface-card rounded-lg shadow-win-4 p-6 hover:shadow-win-8
                 hover:-translate-y-0.5 transition transform border border-border-subtle
                 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div
        className="w-11 h-11 rounded-md flex items-center justify-center mb-4"
        style={{ background: `${color}1A` }}
      >
        <div className="w-6 h-6 rounded" style={{ background: color }} />
      </div>
      <h3 className="text-base font-semibold text-text-primary mb-1.5">{agent.name}</h3>
      <p className="text-[0.82rem] text-text-secondary line-clamp-3">{agent.description}</p>
    </button>
  );
}
