import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  ProcessingSteps,
  type AgentStep,
} from '../../components/chat/ProcessingSteps';

afterEach(() => cleanup());

function makeSteps(): AgentStep[] {
  return [
    { key: 'validate', name: 'Validate Schema', status: 'done', durationMs: 50 },
    { key: 'parse', name: 'Parse Articles', status: 'done', durationMs: 1200 },
    { key: 'dates', name: 'Detect Date Range', status: 'running' },
    { key: 'domains', name: 'Extract Domains', status: 'pending' },
    { key: 'normalize', name: 'Normalize Schema', status: 'pending' },
    { key: 'insert', name: 'Insert to Database', status: 'pending' },
    { key: 'handoff', name: 'Handoff Ready', status: 'pending' },
  ];
}

describe('ProcessingSteps', () => {
  it('renders all 7 steps and tags them with status data-attrs', () => {
    render(<ProcessingSteps agentName="Data Extract Agent" steps={makeSteps()} />);
    expect(screen.getByText('Data Extract Agent')).toBeTruthy();
    const stepRows = document.querySelectorAll('[data-step-key]');
    expect(stepRows.length).toBe(7);
    expect(stepRows[0]!.getAttribute('data-step-status')).toBe('done');
    expect(stepRows[2]!.getAttribute('data-step-status')).toBe('running');
    expect(stepRows[3]!.getAttribute('data-step-status')).toBe('pending');
  });

  it('renders durations only for done steps', () => {
    render(<ProcessingSteps steps={makeSteps()} />);
    expect(screen.queryByText(/50 ms/)).toBeTruthy();
    expect(screen.queryByText(/1\.2 s/)).toBeTruthy();
  });

  it('surfaces the error message under a failed step', () => {
    const steps: AgentStep[] = [
      { key: 'parse', name: 'Parse Articles', status: 'failed', error: 'Bad CSV header' },
    ];
    render(<ProcessingSteps steps={steps} />);
    expect(screen.getByRole('alert').textContent).toMatch(/bad csv header/i);
  });

  it('animates the spinner only on the running step', () => {
    render(<ProcessingSteps steps={makeSteps()} />);
    const spinners = document.querySelectorAll('svg.animate-spin');
    expect(spinners.length).toBe(1);
  });

  it('summary shows done/total in the header', () => {
    render(<ProcessingSteps agentName="X" steps={makeSteps()} />);
    expect(screen.getByText(/2\/7 steps/i)).toBeTruthy();
  });
});
