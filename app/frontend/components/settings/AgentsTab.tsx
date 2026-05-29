'use client';
import { useEffect, useState } from 'react';
import { listAgents, type AgentSummary } from '../../lib/chats';

export function AgentsTab() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgents().then(setAgents).catch(() => setAgents([])).finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-bold mb-1">Agents</h1>
      <p className="text-sm text-text-secondary mb-5">
        Phase 1 ships these 5 default agents. All are always on and cannot be disabled.
      </p>

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((a) => (
          <div key={a.id} className="border border-border-default rounded-lg p-4 bg-white">
            <div className="flex items-center gap-3 mb-2">
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center font-bold text-white text-sm"
                style={{ backgroundColor: a.color ?? '#0078D4' }}
              >
                {a.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{a.name}</div>
                <div className="text-[0.7rem] text-text-tertiary">{a.type}</div>
              </div>
              <button
                role="switch" aria-checked aria-disabled disabled
                className="relative w-10 h-5 rounded-full bg-win-blue-500 opacity-70 cursor-not-allowed"
              >
                <span className="absolute top-0.5 left-[22px] w-4 h-4 bg-white rounded-full shadow" />
              </button>
            </div>
            <p className="text-xs text-text-secondary mb-3 line-clamp-3">{a.description}</p>
            <span className="text-[0.65rem] px-2 py-0.5 rounded-full font-semibold
                              bg-surface-tertiary text-text-secondary">
              Default — Locked
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
