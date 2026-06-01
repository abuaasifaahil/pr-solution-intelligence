'use client';
import { useEffect, useState } from 'react';
import { listAgents, type AgentSummary } from '../../lib/chats';
import {
  listUserAgents,
  deleteUserAgent,
  type UserAgent,
} from '../../lib/user-agents';
import { NewUserAgentModal } from './NewUserAgentModal';

/**
 * M9.9 — Agents section inside the "My Agents & Skills" tab.
 *
 * Renders:
 *  - First-party agents (read-only, dispatched by the backend's
 *    `/api/v1/agents` route).
 *  - The caller's `user_agents` rows (CRUD via `lib/user-agents.ts`).
 *  - A "+ New" button at the section header.
 *  - A disabled "[⤴]" share button with a tooltip pointing at Phase 6.
 *
 * @file components/settings/AgentListSection.tsx
 */
export function AgentListSection(): JSX.Element {
  const [firstParty, setFirstParty] = useState<AgentSummary[]>([]);
  const [mine, setMine] = useState<UserAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; agent: UserAgent } | null
  >(null);

  useEffect(() => {
    void Promise.all([listAgents(), listUserAgents()])
      .then(([fp, ua]) => {
        setFirstParty(fp);
        setMine(ua);
      })
      .catch(() => {
        setFirstParty([]);
        setMine([]);
      })
      .finally(() => setLoading(false));
  }, []);

  async function reload(): Promise<void> {
    const ua = await listUserAgents();
    setMine(ua);
  }

  async function remove(agent: UserAgent): Promise<void> {
    if (!confirm(`Delete "${agent.name}"? This cannot be undone.`)) return;
    await deleteUserAgent(agent.id);
    await reload();
  }

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold">
          Agents{' '}
          <span className="text-xs font-normal text-text-tertiary">
            ({firstParty.length} first-party{mine.length > 0 ? ` + ${mine.length} yours` : ''})
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setModal({ mode: 'create' })}
          data-testid="new-user-agent-button"
          className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                     hover:bg-win-blue-600"
        >
          + New agent
        </button>
      </div>

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}

      <div className="grid gap-2">
        {firstParty.map((a) => (
          <AgentRow
            key={a.id}
            title={a.name}
            description={a.description}
            badge="first-party"
            color={a.color ?? '#0078D4'}
          />
        ))}
        {mine.map((a) => (
          <AgentRow
            key={a.id}
            title={a.name}
            description={
              typeof (a.customization as { description?: unknown }).description ===
              'string'
                ? ((a.customization as { description: string }).description)
                : `Based on ${a.baseAgentKind}`
            }
            badge="yours"
            color="#107C10"
            actions={
              <>
                <button
                  type="button"
                  data-testid={`ua-edit-${a.id}`}
                  onClick={() => setModal({ mode: 'edit', agent: a })}
                  className="px-2 py-1 text-xs rounded hover:bg-surface-hover"
                  aria-label={`Edit ${a.name}`}
                >
                  edit
                </button>
                <button
                  type="button"
                  data-testid={`ua-delete-${a.id}`}
                  onClick={() => void remove(a)}
                  className="px-2 py-1 text-xs rounded text-status-error-text hover:bg-status-error-bg"
                  aria-label={`Delete ${a.name}`}
                >
                  delete
                </button>
                <button
                  type="button"
                  disabled
                  title="Sharing to workspace is coming in Phase 6"
                  className="px-2 py-1 text-xs rounded text-text-tertiary opacity-60 cursor-not-allowed"
                  aria-label="Share to workspace (coming in Phase 6)"
                >
                  share
                </button>
              </>
            }
          />
        ))}
        {!loading && firstParty.length === 0 && mine.length === 0 && (
          <div className="text-sm text-text-tertiary border border-dashed border-border-default
                          rounded-md p-6 text-center">
            No agents available yet.
          </div>
        )}
      </div>

      {modal && (
        <NewUserAgentModal
          existing={modal.mode === 'edit' ? modal.agent : null}
          onClose={() => setModal(null)}
          onSaved={reload}
        />
      )}
    </section>
  );
}

function AgentRow({
  title,
  description,
  badge,
  color,
  actions,
}: {
  title: string;
  description: string;
  badge: 'first-party' | 'yours';
  color: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 border border-border-default rounded-lg p-3 bg-white">
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center font-bold text-white text-sm"
        style={{ backgroundColor: color }}
      >
        {title[0]?.toUpperCase() ?? '?'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{title}</div>
        <div className="text-xs text-text-secondary line-clamp-2">
          {description}
        </div>
      </div>
      <span
        className={`text-[0.65rem] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap
          ${badge === 'first-party'
            ? 'bg-surface-tertiary text-text-secondary'
            : 'bg-win-blue-50 text-win-blue-600'}`}
      >
        {badge === 'first-party' ? 'first-party' : 'yours'}
      </span>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  );
}
