'use client';
import type { JSX } from 'react';
import type { AgentSummary } from '../../lib/chats';

/**
 * M9.8 — "Recently used" chip row under the chat-creation form. For
 * Phase 3.5 we hardcode the 4 first-party agent kinds (per ADR-0003
 * Decision 5: "Phase 3.5 stubs it: M9.6+ uses naive first-party-first
 * ordering until Phase 5 lands"). Phase 5's memory-ranker will swap the
 * hardcoded list for actual recency + success-rate ordering.
 *
 * Click → calls `onPick(agent)` which the parent treats identically to
 * clicking an AgentCard tile (the "Pattern 0 lifeline" stays one click
 * away).
 *
 * @file components/home/RecentlyUsedChips.tsx
 */

interface Props {
  agents: AgentSummary[];
  onPick: (agent: AgentSummary) => void;
  disabled?: boolean;
}

/** Hardcoded fallback chip order (M9.8) — matches the four first-party
 *  agent kinds in `app/backend/src/agents/`. Memory replay lands in
 *  Phase 5; until then this list is the user-visible "Recently used"
 *  surface. */
const FIRST_PARTY_FALLBACK_ORDER = [
  'pr_impact',
  'brand_sentinel',
  'crisis_watch',
  'competitor_tracker',
];

export function RecentlyUsedChips({ agents, onPick, disabled }: Props): JSX.Element | null {
  if (agents.length === 0) return null;
  // Stable ordering: known first-party kinds first, then anything else.
  const ordered = [
    ...FIRST_PARTY_FALLBACK_ORDER.flatMap((kind) => agents.filter((a) => a.type === kind)),
    ...agents.filter((a) => !FIRST_PARTY_FALLBACK_ORDER.includes(a.type)),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
        Recently used
      </div>
      <div className="flex flex-wrap gap-2" data-testid="recently-used-chips">
        {ordered.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(a)}
            disabled={disabled}
            data-testid={`recently-used-${a.type}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                       bg-surface-card border border-border-default text-text-primary
                       hover:bg-surface-hover hover:border-win-blue-200 transition
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: a.color ?? '#0078D4' }}
              aria-hidden="true"
            />
            {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}
