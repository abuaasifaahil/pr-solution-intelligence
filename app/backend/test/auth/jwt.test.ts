import { describe, it, expect, beforeAll } from 'vitest';
import {
  signAccess,
  verifyAccess,
  mintRefresh,
  hashRefresh,
  type AccessPayload,
} from '../../src/lib/jwt.js';

const sample: AccessPayload = {
  userId: '00000000-0000-0000-0000-000000000001',
  email: 'kb@test.local',
  role: 'analyst',
  sessionId: '00000000-0000-0000-0000-000000000099',
};

describe('jwt helpers', () => {
  it('signAccess returns a string with 3 dot-separated segments', () => {
    const token = signAccess(sample);
    expect(token.split('.')).toHaveLength(3);
  });

  it('verifyAccess returns the original payload', () => {
    const token = signAccess(sample);
    const decoded = verifyAccess(token);
    expect(decoded.userId).toBe(sample.userId);
    expect(decoded.email).toBe(sample.email);
    expect(decoded.role).toBe(sample.role);
  });

  it('verifyAccess throws on tampered token', () => {
    const token = signAccess(sample);
    const tampered = token.slice(0, -2) + 'XX';
    expect(() => verifyAccess(tampered)).toThrow();
  });

  it('mintRefresh returns a 64-char hex string and hashRefresh round-trips', async () => {
    const refresh = mintRefresh();
    expect(refresh).toMatch(/^[0-9a-f]{64}$/);
    const hash = await hashRefresh(refresh);
    expect(hash).not.toBe(refresh);
    expect(hash).toMatch(/^\$2[aby]?\$/);
  });
});
