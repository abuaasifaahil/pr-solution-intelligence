import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { chatCompleteStream } = await import('../../src/lib/llm.js');

function makeStream(chunks: Array<{ content?: string }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield { choices: [{ delta: c }] };
    },
  };
}

describe('llm.chatCompleteStream', () => {
  beforeEach(() => createMock.mockReset());

  it('yields each non-empty delta in order', async () => {
    createMock.mockResolvedValue(makeStream([
      { content: 'Hel' }, { content: 'lo' }, { content: ' there.' },
    ]));
    const out: string[] = [];
    for await (const delta of chatCompleteStream({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      out.push(delta);
    }
    expect(out).toEqual(['Hel', 'lo', ' there.']);
  });

  it('skips chunks with no content (e.g. role-only first chunk)', async () => {
    createMock.mockResolvedValue(makeStream([
      { /* role-only */ }, { content: 'A' }, {}, { content: 'B' },
    ]));
    const out: string[] = [];
    for await (const delta of chatCompleteStream({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
    })) {
      out.push(delta);
    }
    expect(out).toEqual(['A', 'B']);
  });

  it('passes stream:true and temperature to the SDK', async () => {
    createMock.mockResolvedValue(makeStream([{ content: 'ok' }]));
    for await (const _ of chatCompleteStream({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5,
    })) { /* drain */ }
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      temperature: 0.5,
    }));
  });
});
