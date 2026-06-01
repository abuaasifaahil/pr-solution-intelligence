import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { AgentSummary } from '../../lib/chats';
import type { ComposableSkill } from '../../lib/composable-skills';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const createChat = vi.fn();
const buildChatUrl = vi.fn((id: string, opts?: { skillId?: string; sources?: unknown[] }) => {
  const params = new URLSearchParams();
  if (opts?.skillId) params.set('skill', opts.skillId);
  const qs = params.toString();
  return qs ? `/chat/${id}?${qs}` : `/chat/${id}`;
});

vi.mock('../../lib/chats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chats')>();
  return {
    ...actual,
    createChat,
    buildChatUrl,
  };
});

const listComposableSkills = vi.fn<[], Promise<ComposableSkill[]>>();
vi.mock('../../lib/composable-skills', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/composable-skills')>();
  return {
    ...actual,
    listComposableSkills,
  };
});

const { ChatCreationForm } = await import(
  '../../components/home/ChatCreationForm'
);

const AGENTS: AgentSummary[] = [
  {
    id: 'a1', type: 'pr_impact', name: 'PR Impact',
    description: 'Sentiment + reach', icon: null, color: '#0078D4',
  },
  {
    id: 'a2', type: 'brand_sentinel', name: 'Brand Sentinel',
    description: 'Watch brand', icon: null, color: '#107C10',
  },
];

const FIRST_PARTY_SKILL: ComposableSkill = {
  id: 's-pr-impact', name: 'pr-impact', version: '1.0.0',
  kind: 'analysis_skill',
  manifest: { displayName: 'PR Impact Analysis', description: 'Sentiment' },
  scope: 'first_party', userId: null, workspaceId: null,
  trustLevel: 'first_party', enabled: true,
  createdAt: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
  push.mockReset();
  createChat.mockReset();
  buildChatUrl.mockClear();
  listComposableSkills.mockReset();
  if (typeof window !== 'undefined') window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe('ChatCreationForm', () => {
  it('renders the textarea + Start chat button + agent selector', () => {
    render(<ChatCreationForm agents={AGENTS} />);
    expect(screen.getByPlaceholderText(/Describe what you want to know/i)).toBeTruthy();
    expect(screen.getByTestId('start-chat-btn')).toBeTruthy();
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('pr_impact');
  });

  it('Start chat with empty form creates default-agent chat and routes (Pattern 0 lifeline)', async () => {
    createChat.mockResolvedValue({
      chat: { id: 'c-new', agentType: 'pr_impact', title: null, status: 'active', updatedAt: '', context: {} },
      welcomeMessage: { id: 'm1', chatId: 'c-new', role: 'assistant', content: 'hi', metadata: {}, createdAt: '' },
    });
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('start-chat-btn'));
    await waitFor(() => expect(createChat).toHaveBeenCalledWith('pr_impact', undefined));
    expect(push).toHaveBeenCalledWith('/chat/c-new');
  });

  it('Start chat with a typed prompt stashes the message in sessionStorage', async () => {
    createChat.mockResolvedValue({
      chat: { id: 'c-2', agentType: 'pr_impact', title: null, status: 'active', updatedAt: '', context: {} },
      welcomeMessage: { id: 'm1', chatId: 'c-2', role: 'assistant', content: 'hi', metadata: {}, createdAt: '' },
    });
    render(<ChatCreationForm agents={AGENTS} />);
    const ta = screen.getByPlaceholderText(/Describe what you want to know/i);
    fireEvent.change(ta, { target: { value: 'How did FreshSip perform last month?' } });
    fireEvent.click(screen.getByTestId('start-chat-btn'));
    await waitFor(() => expect(createChat).toHaveBeenCalled());
    const stored = window.sessionStorage.getItem('prsi-pending-first-message:c-2');
    expect(stored).toBe('How did FreshSip perform last month?');
  });

  it('changing the agent select propagates into createChat', async () => {
    createChat.mockResolvedValue({
      chat: { id: 'c-3', agentType: 'brand_sentinel', title: null, status: 'active', updatedAt: '', context: {} },
      welcomeMessage: { id: 'm1', chatId: 'c-3', role: 'assistant', content: 'hi', metadata: {}, createdAt: '' },
    });
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.change(screen.getByTestId('agent-select'), {
      target: { value: 'brand_sentinel' },
    });
    fireEvent.click(screen.getByTestId('start-chat-btn'));
    await waitFor(() => expect(createChat).toHaveBeenCalledWith('brand_sentinel', undefined));
  });

  it('clicking [+ Skill] opens the popover and lists first-party skills', async () => {
    listComposableSkills.mockResolvedValue([FIRST_PARTY_SKILL]);
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('attach-skill-btn'));
    await waitFor(() => expect(screen.getByTestId('attach-skill-popover')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('skill-pick-s-pr-impact')).toBeTruthy(),
    );
  });

  it('picking a skill attaches a chip + disables the agent select', async () => {
    listComposableSkills.mockResolvedValue([FIRST_PARTY_SKILL]);
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('attach-skill-btn'));
    await waitFor(() => expect(screen.getByTestId('skill-pick-s-pr-impact')).toBeTruthy());
    fireEvent.click(screen.getByTestId('skill-pick-s-pr-impact'));
    expect(screen.getByTestId('attached-skill-s-pr-impact')).toBeTruthy();
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).disabled).toBe(true);
  });

  it('removing the attached skill chip re-enables the agent select', async () => {
    listComposableSkills.mockResolvedValue([FIRST_PARTY_SKILL]);
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('attach-skill-btn'));
    await waitFor(() => expect(screen.getByTestId('skill-pick-s-pr-impact')).toBeTruthy());
    fireEvent.click(screen.getByTestId('skill-pick-s-pr-impact'));
    const chip = screen.getByTestId('attached-skill-s-pr-impact');
    fireEvent.click(chip.querySelector('button')!);
    expect((screen.getByTestId('agent-select') as HTMLSelectElement).disabled).toBe(false);
  });

  it('[+ Source] popover surfaces CSV + OpenSearch + disabled Crawl', () => {
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('attach-source-btn'));
    expect(screen.getByTestId('attach-source-popover')).toBeTruthy();
    expect(screen.getByTestId('source-pick-csv')).toBeTruthy();
    expect(screen.getByTestId('source-pick-opensearch')).toBeTruthy();
    const crawler = screen.getByTestId('source-pick-crawler-disabled');
    expect(crawler.getAttribute('aria-disabled')).toBe('true');
  });

  it('picking OpenSearch attaches a source chip + URL carries through buildChatUrl', async () => {
    createChat.mockResolvedValue({
      chat: { id: 'c-4', agentType: 'pr_impact', title: null, status: 'active', updatedAt: '', context: {} },
      welcomeMessage: { id: 'm1', chatId: 'c-4', role: 'assistant', content: 'hi', metadata: {}, createdAt: '' },
    });
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('attach-source-btn'));
    fireEvent.click(screen.getByTestId('source-pick-opensearch'));
    expect(screen.getByTestId('attached-source-opensearch')).toBeTruthy();
    fireEvent.click(screen.getByTestId('start-chat-btn'));
    await waitFor(() => expect(createChat).toHaveBeenCalled());
    expect(buildChatUrl).toHaveBeenCalledWith(
      'c-4',
      expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({ kind: 'opensearch' }),
        ]),
      }),
    );
  });

  it('shows an error when createChat throws', async () => {
    createChat.mockRejectedValue(new Error('boom'));
    render(<ChatCreationForm agents={AGENTS} />);
    fireEvent.click(screen.getByTestId('start-chat-btn'));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('boom');
    });
  });
});
