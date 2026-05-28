import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { hashPassword } from './bcrypt.js';
import { loadEnv } from '../env.js';

export interface AccessPayload {
  userId: string;
  email: string;
  role: 'admin' | 'analyst' | 'viewer';
  sessionId: string;
}

export function signAccess(payload: AccessPayload): string {
  const env = loadEnv();
  return jwt.sign(payload, env.JWT_PRIVATE_KEY, {
    algorithm: 'RS256',
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

export function verifyAccess(token: string): AccessPayload {
  const env = loadEnv();
  const decoded = jwt.verify(token, env.JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
  if (typeof decoded === 'string' || !('userId' in decoded)) {
    throw new Error('Invalid token payload');
  }
  return decoded as AccessPayload;
}

export function mintRefresh(): string {
  return randomBytes(32).toString('hex');
}

export async function hashRefresh(plaintext: string): Promise<string> {
  return hashPassword(plaintext);
}
