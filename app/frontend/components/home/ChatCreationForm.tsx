'use client';
import { useState, type JSX } from 'react';
import { useRouter } from 'next/navigation';
import {
  buildChatUrl,
  createChat,
  type AgentSummary,
} from '../../lib/chats';
import type { ComposableSkill } from '../../lib/composable-skills';
import { skillDisplayName } from '../../lib/composable-skills';
import { AttachSkillPopover } from './AttachSkillPopover';
import { AttachSourcePopover } from './AttachSourcePopover';
import { AttachedSkillChip } from './AttachedSkillChip';
import { AttachedSourceChip, type AttachedSource } from './AttachedSourceChip';

/**
 * M9.8 — chat-creation form (ADR-0003 Decision 1). Replaces the agent-
 * grid home page as the primary chat-entry surface; the AgentCard grid
 * stays on the page below as a collapsed "Show all agents" fallback.
 *
 * Supports 8 entry patterns from ADR-0003:
 *
 *   - Pattern 0 (empty form + Start) → default agent, blank prompt
 *   - Pattern 1, 2 (skill + source + prompt) → skill drives flow
 *   - Pattern 3, 4 (prompt + source) → probe agent classifies
 *   - Pattern 5 (prompt only) → general conversation
 *   - Pattern 6, 7 (agent + source ± prompt) → agent classifyAndProbe
 *
 * Crawl is surfaced in the source popover but disabled (`[Coming soon]`)
 * — the M9.6a adapter registry throws on `crawler` until M9.11+.
 *
 * `sessionStorage` carries the first-message intent across the route
 * change so the chat page can send it once on mount. URL params carry
 * the reproducible attachment state (skill + sources).
 *
 * @file components/home/ChatCreationForm.tsx
 */

const PENDING_MESSAGE_STORAGE_KEY = 'prsi-pending-first-message';

interface Props {
  agents: AgentSummary[];
  defaultAgentType?: string;
}

export function ChatCreationForm({ agents, defaultAgentType }: Props): JSX.Element {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [agentType, setAgentType] = useState<string>(
    defaultAgentType ?? agents[0]?.type ?? 'pr_impact',
  );
  const [skill, setSkill] = useState<ComposableSkill | null>(null);
  const [sources, setSources] = useState<AttachedSource[]>([]);
  const [skillPopoverOpen, setSkillPopoverOpen] = useState(false);
  const [sourcePopoverOpen, setSourcePopoverOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skillPinned = skill !== null;

  async function handleStart(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // When a skill is pinned the chat is "skill-driven" (ADR-0003
      // Patterns 1, 2). M9.8 still needs an agentType for the backend
      // (POST /chats requires it); we pass the chosen default but the
      // Phase 5.5 SkillComposer will eventually override behavior.
      const title = skill ? `Skill: ${skillDisplayName(skill)}` : undefined;
      const { chat } = await createChat(agentType, title);

      // Stash first message so the chat page can send it on mount. Use
      // sessionStorage so a refresh doesn't re-send.
      const trimmed = prompt.trim();
      if (trimmed.length > 0 && typeof window !== 'undefined') {
        window.sessionStorage.setItem(
          `${PENDING_MESSAGE_STORAGE_KEY}:${chat.id}`,
          trimmed,
        );
      }

      const url = buildChatUrl(chat.id, {
        skillId: skill?.id,
        sources: sources.map((s) => ({ kind: s.kind, ref: s.ref })),
      });
      router.push(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create chat');
      setBusy(false);
    }
  }

  function removeSource(idx: number): void {
    setSources((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="flex flex-col gap-4" data-testid="chat-creation-form">
      {/* Prompt textarea */}
      <label className="block">
        <span className="sr-only">Describe what you want to know</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what you want to know… (e.g. How did FreshSip perform vs. PepsiCo last quarter?)"
          rows={4}
          maxLength={4000}
          disabled={busy}
          aria-label="Describe what you want to know"
          className="w-full bg-surface-card border border-border-default rounded-lg
                     px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary
                     focus:outline-none focus:ring-2 focus:ring-win-blue-500 focus:border-win-blue-500
                     resize-none disabled:opacity-60"
        />
      </label>

      {/* Action row: attach buttons + agent picker */}
      <div className="flex flex-wrap items-center gap-2 relative">
        {/* + Skill */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setSkillPopoverOpen((v) => !v);
              setSourcePopoverOpen(false);
            }}
            disabled={busy}
            data-testid="attach-skill-btn"
            aria-expanded={skillPopoverOpen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
                       bg-surface-card border border-border-default text-text-primary
                       hover:bg-surface-hover transition disabled:opacity-50"
          >
            <span aria-hidden="true">+</span>
            <span>Skill</span>
          </button>
          <AttachSkillPopover
            open={skillPopoverOpen}
            onClose={() => setSkillPopoverOpen(false)}
            onPick={(s) => setSkill(s)}
          />
        </div>

        {/* + Source */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setSourcePopoverOpen((v) => !v);
              setSkillPopoverOpen(false);
            }}
            disabled={busy}
            data-testid="attach-source-btn"
            aria-expanded={sourcePopoverOpen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
                       bg-surface-card border border-border-default text-text-primary
                       hover:bg-surface-hover transition disabled:opacity-50"
          >
            <span aria-hidden="true">+</span>
            <span>Source</span>
          </button>
          <AttachSourcePopover
            open={sourcePopoverOpen}
            onClose={() => setSourcePopoverOpen(false)}
            onPick={(src) => setSources((prev) => [...prev, src])}
          />
        </div>

        {/* Agent dropdown — disabled when a skill is pinned (the skill
            drives the flow per ADR-0003 Patterns 1, 2). */}
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary ml-auto">
          <span>Agent:</span>
          <select
            value={agentType}
            onChange={(e) => setAgentType(e.target.value)}
            disabled={busy || skillPinned}
            aria-label="Default agent"
            data-testid="agent-select"
            className="px-2.5 py-1.5 rounded-md text-sm border border-border-default bg-surface-card
                       text-text-primary focus:outline-none focus:ring-2 focus:ring-win-blue-500
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {agents.length === 0 ? (
              <option value="pr_impact">PR Impact</option>
            ) : (
              agents.map((a) => (
                <option key={a.id} value={a.type}>
                  {a.name}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      {/* Skill-pinned hint */}
      {skillPinned && (
        <div className="text-xs text-text-tertiary">
          Skill <span className="font-medium text-text-secondary">
            {skillDisplayName(skill)}
          </span>{' '}
          drives this chat. The agent picker is disabled until the skill is removed.
        </div>
      )}

      {/* Attached-chips row */}
      {(skill || sources.length > 0) && (
        <div className="flex flex-wrap gap-2" data-testid="attached-chips-row">
          {skill && (
            <AttachedSkillChip skill={skill} onRemove={() => setSkill(null)} />
          )}
          {sources.map((src, idx) => (
            <AttachedSourceChip
              key={`${src.kind}-${idx}`}
              source={src}
              onRemove={() => removeSource(idx)}
            />
          ))}
        </div>
      )}

      {error && (
        <div role="alert" className="text-xs text-status-error-text">
          {error}
        </div>
      )}

      {/* Start button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={busy}
          data-testid="start-chat-btn"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold
                     bg-win-blue-500 text-white hover:bg-win-blue-600 transition
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Starting…' : 'Start chat'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
      </div>
    </div>
  );
}

/**
 * Helper for the chat page (M9.8.x) to read + clear the pending first
 * message after creation. Exported so the chat page doesn't reach into
 * sessionStorage directly.
 */
export function readPendingFirstMessage(chatId: string): string | null {
  if (typeof window === 'undefined') return null;
  const key = `${PENDING_MESSAGE_STORAGE_KEY}:${chatId}`;
  const value = window.sessionStorage.getItem(key);
  if (value !== null) {
    window.sessionStorage.removeItem(key);
  }
  return value;
}
