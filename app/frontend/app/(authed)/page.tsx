'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../../lib/auth-store';
import { greetingFor } from '../../lib/greeting';
import { Topbar } from '../../components/layout/Topbar';
import { AgentCard } from '../../components/home/AgentCard';
import { listAgents, type AgentSummary } from '../../lib/chats';

export default function HomePage() {
  const user = useAuthStore((s) => s.user);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgents()
      .then((a) => { setAgents(a); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <>
      <Topbar title="Home" badge="Online" />
      <main className="flex-1 overflow-y-auto p-12">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-3xl font-bold mb-2 text-text-primary">
            {greetingFor()}, <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
          </h1>
          <p className="text-text-secondary mb-10">
            Pick an agent below to start a new analysis.
          </p>

          {loading ? (
            <div className="text-text-tertiary">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="text-text-tertiary">No agents available.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
