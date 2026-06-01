import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CompletionSummary } from '../../components/chat/CompletionSummary';

afterEach(() => cleanup());

describe('CompletionSummary', () => {
  it('renders open by default with all stat keys', () => {
    render(
      <CompletionSummary
        agentName="Data Extract Agent"
        stats={{ Articles: 1234, Domains: 89, 'Total time': '12.3s' }}
      />,
    );
    expect(screen.getByText(/Data Extract Agent — complete/i)).toBeTruthy();
    expect(screen.getByText('Articles')).toBeTruthy();
    expect(screen.getByText('Domains')).toBeTruthy();
    expect(screen.getByText('Total time')).toBeTruthy();
    expect(screen.getByText('1234')).toBeTruthy();
    expect(screen.getByText('89')).toBeTruthy();
    expect(screen.getByText('12.3s')).toBeTruthy();
  });

  it('collapses to summary text when the chevron is clicked', () => {
    render(
      <CompletionSummary
        agentName="X"
        stats={{ Articles: 10 }}
        summaryText="10 articles · 2 domains · 1.0s"
      />,
    );
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText('summary').textContent).toMatch(
      /10 articles · 2 domains · 1\.0s/i,
    );
  });

  it('respects defaultOpen=false (starts collapsed)', () => {
    render(
      <CompletionSummary
        agentName="X"
        stats={{ Articles: 10 }}
        defaultOpen={false}
      />,
    );
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Stat keys hidden while collapsed.
    expect(screen.queryByText('Articles')).toBeNull();
  });

  it('falls back to a join of stats when summaryText is omitted', () => {
    render(
      <CompletionSummary
        agentName="X"
        stats={{ Articles: 5, Domains: 2 }}
        defaultOpen={false}
      />,
    );
    expect(screen.getByLabelText('summary').textContent).toMatch(/5 articles/i);
    expect(screen.getByLabelText('summary').textContent).toMatch(/2 domains/i);
  });
});
