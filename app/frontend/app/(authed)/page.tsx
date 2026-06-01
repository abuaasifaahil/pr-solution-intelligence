'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../lib/auth-store';
import { greetingFor } from '../../lib/greeting';
import { Topbar } from '../../components/layout/Topbar';
import { AgentCard } from '../../components/home/AgentCard';
import { ChatCreationForm } from '../../components/home/ChatCreationForm';
import { RecentlyUsedChips } from '../../components/home/RecentlyUsedChips';
import {
  buildChatUrl,
  createChat,
  listAgents,
  type AgentSummary,
} from '../../lib/chats';

/**
 * M9.8 — Home page (ADR-0003 Decision 1).
 *
 * Replaces the legacy "grid of AgentCards" with a chat-creation surface
 * supporting all 8 entry patterns:
 *
 *   - big prompt textarea     (Pattern 5 + lifeline for Pattern 0)
 *   - default agent selector  (Patterns 0, 6, 7)
 *   - [+ Skill] popover       (Patterns 1, 2)
 *   - [+ Source] popover      (Patterns 1-4, 6, 7)
 *   - "Recently used" chips   (hardcoded in M9.8 — Phase 5 ranker fills)
 *
 * The AgentCard grid is preserved below as a collapsed "Show all
 * agents" footer so existing users (who built muscle memory on the old
 * UI) aren't blindsided.
 *
 * @file app/(authed)/page.tsx
 */
export default function HomePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [recentlyBusy, setRecentlyBusy] = useState(false);

  useEffect(() => {
    listAgents()
      .then((a) => {
        setAgents(a);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  /** Pattern 0 / Recently-used chip click — create a chat with the agent
   *  and immediately route. Mirrors AgentCard.handleClick semantics so
   *  the lifeline path is identical. */
  async function handleQuickStart(agent: AgentSummary): Promise<void> {
    if (recentlyBusy) return;
    setRecentlyBusy(true);
    try {
      const { chat } = await createChat(agent.type);
      router.push(buildChatUrl(chat.id));
    } catch {
      setRecentlyBusy(false);
    }
  }

  return (
    <>
      <Topbar title="Home" badge="Online" />
      <main className="flex-1 overflow-y-auto p-8 md:p-12">
        <div className="max-w-4xl mx-auto flex flex-col gap-8">
          {/* Greeting */}
          <header>
            <h1 className="text-3xl font-bold mb-1.5 text-text-primary">
              {greetingFor()},{' '}
              <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
            </h1>
            <p className="text-text-secondary">
              Ask anything, attach a source, or pick an agent.
            </p>
          </header>

          {/* Chat creation form (the new primary entry surface) */}
          <ChatCreationForm agents={agents} />

          {/* Recently used chips — hardcoded 4 first-party agents until
              Phase 5 memory-ranker lands. */}
          {!loading && agents.length > 0 && (
            <div className="border-t border-border-subtle pt-6">
              <RecentlyUsedChips
                agents={agents}
                onPick={(a) => void handleQuickStart(a)}
                disabled={recentlyBusy}
              />
            </div>
          )}

          {/* Legacy AgentCard grid — collapsed by default. Preserves the
              Phase 1 / 2 / 3 muscle memory for existing users. */}
          <div className="border-t border-border-subtle pt-4">
            <button
              type="button"
              onClick={() => setShowAllAgents((v) => !v)}
              data-testid="show-all-agents-toggle"
              className="text-sm font-medium text-text-secondary hover:text-text-primary
                         inline-flex items-center gap-1.5"
              aria-expanded={showAllAgents}
            >
              <span aria-hidden="true">{showAllAgents ? '▾' : '▸'}</span>
              {showAllAgents ? 'Hide all agents' : 'Show all agents'}
              <span className="text-text-tertiary text-xs">
                ({agents.length})
              </span>
            </button>

            {showAllAgents && (
              <div className="mt-4">
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
            )}
          </div>
        </div>
      </main>
    </>
  );
}
