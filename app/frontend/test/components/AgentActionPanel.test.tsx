import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  AgentActionPanel,
  type AgentActionResult,
} from '../../components/chat/AgentActionPanel';
import type { AgentStep } from '../../components/chat/ProcessingSteps';

afterEach(() => cleanup());

const STEPS: AgentStep[] = [
  { key: 'validate', name: 'Validate Schema', status: 'running' },
  { key: 'parse', name: 'Parse Articles', status: 'pending' },
];

const RESULT: AgentActionResult = {
  stats: { Articles: 12, Domains: 3, 'Total time': '4.0s' },
  summaryText: '12 articles · 3 domains · 4.0s',
};

describe('AgentActionPanel', () => {
  it('mounts ProcessingSteps when result is null', () => {
    render(<AgentActionPanel agentName="X" steps={STEPS} result={null} />);
    expect(document.querySelector('[data-testid="processing-steps"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="completion-summary"]')).toBeNull();
  });

  it('mounts CompletionSummary when result is provided', () => {
    render(<AgentActionPanel agentName="X" steps={STEPS} result={RESULT} />);
    expect(document.querySelector('[data-testid="completion-summary"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="processing-steps"]')).toBeNull();
  });

  it('passes through agentName to the active child', () => {
    const { rerender } = render(
      <AgentActionPanel agentName="Data Extract Agent" steps={STEPS} result={null} />,
    );
    expect(screen.getByText('Data Extract Agent')).toBeTruthy();
    rerender(<AgentActionPanel agentName="Data Extract Agent" steps={STEPS} result={RESULT} />);
    expect(screen.getByText(/Data Extract Agent — complete/i)).toBeTruthy();
  });

  it('forwards defaultSummaryOpen=true so the body shows on first render', () => {
    render(
      <AgentActionPanel
        agentName="X"
        steps={STEPS}
        result={RESULT}
        defaultSummaryOpen
      />,
    );
    expect(screen.getByText('Articles')).toBeTruthy();
  });
});
