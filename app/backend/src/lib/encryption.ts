import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;        // GCM standard
const TAG_BYTES = 16;       // GCM auth tag

let cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (!cachedKey) {
    const env = loadEnv();
    cachedKey = Buffer.from(env.ENCRYPTION_KEY, 'hex');
    if (cachedKey.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
    }
  }
  return cachedKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a single string `iv_hex:tag_hex:ciphertext_hex` for compact storage.
 * A fresh random IV is generated per call.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt a string previously produced by `encrypt()`. Throws if the format
 * is malformed or if the auth tag does not verify (tamper detection).
 */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected iv:tag:ct');
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  if (iv.length !== IV_BYTES) throw new Error('Malformed ciphertext: bad IV length');
  if (tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext: bad tag length');
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
