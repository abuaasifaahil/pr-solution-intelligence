import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { chatComplete, parseChoice } = await import('../../src/lib/llm.js');

describe('llm.chatComplete', () => {
  beforeEach(() => createMock.mockReset());

  it('returns the assistant text from the LLM response', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'Hello there.' } }],
    });
    const out = await chatComplete({
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(out).toBe('Hello there.');
  });

  it('throws if the LLM returns no choices', async () => {
    createMock.mockResolvedValue({ choices: [] });
    await expect(
      chatComplete({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
  });
});

describe('llm.parseChoice', () => {
  beforeEach(() => createMock.mockReset());

  it('returns the parsed choice when LLM emits valid JSON', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"choice":"weekly"}' } }],
    });
    const out = await parseChoice('last week', ['weekly', '10days', '20days', 'custom']);
    expect(out).toBe('weekly');
  });

  it('returns null when the LLM emits "unclear"', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"choice":"unclear"}' } }],
    });
    const out = await parseChoice('lalala', ['weekly', '10days']);
    expect(out).toBeNull();
  });
});
