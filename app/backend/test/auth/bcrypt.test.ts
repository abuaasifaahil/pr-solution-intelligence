import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/bcrypt.js';

describe('bcrypt helpers', () => {
  it('hashPassword returns a bcrypt hash, not the plaintext', async () => {
    const hash = await hashPassword('hunter2');
    expect(hash).not.toBe('hunter2');
    expect(hash).toMatch(/^\$2[aby]?\$12\$/);
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', hash)).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
