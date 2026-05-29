import { describe, it, expect, beforeAll } from 'vitest';

// Ensure the env var is set BEFORE the module loads.
beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const { encrypt, decrypt } = await import('../../src/lib/encryption.js');

describe('encryption', () => {
  it('roundtrips a plaintext string', () => {
    const plain = 'sk-test-abc123';
    const cipher = encrypt(plain);
    expect(cipher).not.toBe(plain);
    expect(cipher.split(':')).toHaveLength(3); // iv:tag:ct
    expect(decrypt(cipher)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same-input');
    expect(decrypt(b)).toBe('same-input');
  });

  it('rejects tampered ciphertext', () => {
    const cipher = encrypt('secret');
    const [iv, tag, ct] = cipher.split(':');
    // Flip the last byte of ciphertext.
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === 'ff' ? '00' : 'ff');
    const tampered = `${iv}:${tag}:${flipped}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects malformed ciphertext (wrong segment count)', () => {
    expect(() => decrypt('nope')).toThrow();
    expect(() => decrypt('a:b')).toThrow();
  });

  it('handles empty string', () => {
    const cipher = encrypt('');
    expect(decrypt(cipher)).toBe('');
  });
});
