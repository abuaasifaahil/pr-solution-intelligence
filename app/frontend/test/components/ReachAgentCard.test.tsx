import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReachAgentCard } from '../../components/chat/ReachAgentCard';

afterEach(() => cleanup());

describe('ReachAgentCard', () => {
  it('idle → queued label', () => {
    render(<ReachAgentCard state="idle" coverage={null} />);
    expect(screen.getByText(/Similar Web Agent — queued/)).toBeTruthy();
  });

  it('fetching → fetching label', () => {
    render(<ReachAgentCard state="fetching" coverage={null} />);
    expect(
      screen.getByText(/Similar Web Agent — fetching domain reach/),
    ).toBeTruthy();
  });

  it('done → complete label', () => {
    render(<ReachAgentCard state="done" coverage={null} />);
    expect(screen.getByText(/Similar Web Agent — complete/)).toBeTruthy();
  });

  it('failed → failed label', () => {
    render(<ReachAgentCard state="failed" coverage={null} />);
    expect(screen.getByText(/Similar Web Agent — failed/)).toBeTruthy();
  });

  it('omits the coverage row when coverage is null', () => {
    const { container } = render(
      <ReachAgentCard state="fetching" coverage={null} />,
    );
    expect(container.textContent).not.toMatch(/domains/);
    expect(container.textContent).not.toMatch(/coverage/);
  });

  it('renders the resolved / total / percent coverage line when provided', () => {
    render(
      <ReachAgentCard
        state="done"
        coverage={{ resolved: 18, total: 24, percent: 75 }}
      />,
    );
    expect(screen.getByText(/18 \/ 24 domains · 75% coverage/)).toBeTruthy();
  });

  it('exposes the state via data-state so callers can target it', () => {
    const { container } = render(<ReachAgentCard state="failed" coverage={null} />);
    const card = container.querySelector('[data-testid="reach-agent-card"]');
    expect(card?.getAttribute('data-state')).toBe('failed');
  });
});
