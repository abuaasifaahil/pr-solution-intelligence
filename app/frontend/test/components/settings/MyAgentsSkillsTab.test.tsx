import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import type { ComposableSkill } from '../../../lib/composable-skills';
import type { UserAgent } from '../../../lib/user-agents';
import type { AgentSummary } from '../../../lib/chats';

/**
 * M9.9 — MyAgentsSkillsTab integration test.
 *
 * Mocks the three API clients (`lib/chats`, `lib/user-agents`,
 * `lib/composable-skills`) so the tab renders without network.
 *
 * @file test/components/settings/MyAgentsSkillsTab.test.tsx
 */

const listAgents = vi.fn<[], Promise<AgentSummary[]>>();
const listUserAgents = vi.fn<[], Promise<UserAgent[]>>();
const listComposableSkills = vi.fn<[], Promise<ComposableSkill[]>>();
const deleteUserAgent = vi.fn<[string], Promise<void>>();
const deleteComposableSkill = vi.fn<[string], Promise<void>>();

vi.mock('../../../lib/chats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/chats')>();
  return { ...actual, listAgents };
});
vi.mock('../../../lib/user-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/user-agents')>();
  return { ...actual, listUserAgents, deleteUserAgent };
});
vi.mock('../../../lib/composable-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/composable-skills')>();
  return { ...actual, listComposableSkills, deleteComposableSkill };
});

const { MyAgentsSkillsTab } = await import(
  '../../../components/settings/MyAgentsSkillsTab'
);

const FP_AGENT: AgentSummary = {
  id: 'a-pr', type: 'pr_impact', name: 'PR Impact',
  description: 'Sentiment + reach', icon: null, color: '#0078D4',
};

const USER_AGENT: UserAgent = {
  id: 'ua-1', userId: 'u1', name: 'My Beverage Tracker',
  baseAgentKind: 'pr_impact',
  customization: { description: 'Customized PR Impact for beverages' },
  scope: 'user_private',
  createdAt: '2026-06-01T00:00:00Z',
};

const FP_SKILL: ComposableSkill = {
  id: 's-pr', name: 'pr-impact', version: '1.0.0',
  kind: 'analysis_skill',
  manifest: { description: 'PR Impact analysis' },
  scope: 'first_party', userId: null, workspaceId: null,
  trustLevel: 'first_party', enabled: true,
  createdAt: '2026-06-01T00:00:00Z',
};

const USER_SKILL: ComposableSkill = {
  id: 's-mine', name: 'my_csv_cleanup', version: '0.1.0',
  kind: 'enrichment_skill',
  manifest: { description: 'Cleans up messy CSV uploads' },
  scope: 'user_private', userId: 'u1', workspaceId: null,
  trustLevel: 'community', enabled: true,
  createdAt: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
  listAgents.mockReset();
  listUserAgents.mockReset();
  listComposableSkills.mockReset();
  deleteUserAgent.mockReset();
  deleteComposableSkill.mockReset();
});
afterEach(() => cleanup());

describe('MyAgentsSkillsTab', () => {
  it('renders Agents and Skills sections with + New buttons', async () => {
    listAgents.mockResolvedValue([FP_AGENT]);
    listUserAgents.mockResolvedValue([]);
    listComposableSkills.mockResolvedValue([FP_SKILL]);

    render(<MyAgentsSkillsTab />);

    await waitFor(() => expect(screen.getByText('PR Impact')).toBeTruthy());
    expect(screen.getByText('pr-impact')).toBeTruthy();
    expect(screen.getByTestId('new-user-agent-button')).toBeTruthy();
    expect(screen.getByTestId('new-composable-skill-button')).toBeTruthy();
  });

  it('shows first-party agents as read-only (no edit/delete buttons)', async () => {
    listAgents.mockResolvedValue([FP_AGENT]);
    listUserAgents.mockResolvedValue([]);
    listComposableSkills.mockResolvedValue([]);

    render(<MyAgentsSkillsTab />);

    await waitFor(() => expect(screen.getByText('PR Impact')).toBeTruthy());
    expect(screen.queryByTestId('ua-edit-a-pr')).toBeNull();
    expect(screen.queryByTestId('ua-delete-a-pr')).toBeNull();
  });

  it('shows user_private agents with edit + delete + (disabled) share buttons', async () => {
    listAgents.mockResolvedValue([]);
    listUserAgents.mockResolvedValue([USER_AGENT]);
    listComposableSkills.mockResolvedValue([]);

    render(<MyAgentsSkillsTab />);

    await waitFor(() => expect(screen.getByText('My Beverage Tracker')).toBeTruthy());
    expect(screen.getByTestId('ua-edit-ua-1')).toBeTruthy();
    expect(screen.getByTestId('ua-delete-ua-1')).toBeTruthy();
    // Share buttons exist but are disabled (Phase 6).
    const shareBtns = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label')?.includes('Share to workspace'));
    expect(shareBtns.length).toBeGreaterThan(0);
    expect(shareBtns.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('partitions first-party skills from user_private skills', async () => {
    listAgents.mockResolvedValue([]);
    listUserAgents.mockResolvedValue([]);
    listComposableSkills.mockResolvedValue([FP_SKILL, USER_SKILL]);

    render(<MyAgentsSkillsTab />);

    await waitFor(() => expect(screen.getByText('pr-impact')).toBeTruthy());
    expect(screen.getByText('my_csv_cleanup')).toBeTruthy();
    // Only the user_private skill should have edit/delete affordances.
    expect(screen.queryByTestId('cs-edit-s-pr')).toBeNull();
    expect(screen.getByTestId('cs-edit-s-mine')).toBeTruthy();
    expect(screen.getByTestId('cs-delete-s-mine')).toBeTruthy();
  });

  it('renders gracefully when all lists fail', async () => {
    listAgents.mockRejectedValue(new Error('boom'));
    listUserAgents.mockRejectedValue(new Error('boom'));
    listComposableSkills.mockRejectedValue(new Error('boom'));

    render(<MyAgentsSkillsTab />);

    // Should not throw — empty-state hints render in each section.
    await waitFor(() =>
      expect(screen.getByText(/No agents available/i)).toBeTruthy(),
    );
  });
});
