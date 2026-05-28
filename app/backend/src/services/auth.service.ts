import { prisma } from '@prsi/shared/db';
import { hashPassword, verifyPassword } from '../lib/bcrypt.js';
import { signAccess, mintRefresh, hashRefresh, type AccessPayload } from '../lib/jwt.js';
import { loadEnv } from '../env.js';

export interface LoginInput {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: { id: string; email: string; displayName: string; role: AccessPayload['role'] };
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !user.isActive || user.deletedAt) {
    // Constant message — no user-enumeration leak.
    throw new Error('Invalid credentials');
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw new Error('Invalid credentials');
  }
  return issueTokens(user, input.ip, input.userAgent);
}

export interface RefreshInput {
  refreshToken: string;
  ip: string | null;
  userAgent: string | null;
}

export async function refresh(input: RefreshInput): Promise<AuthResult> {
  // Refresh tokens are bcrypt-hashed in the DB; we can't lookup by hash.
  // Strategy: load all active, unexpired sessions, compare each. O(N) but
  // N is bounded by concurrent active sessions. M6 may add a SHA-256 indexed
  // column for O(1) lookup.
  const candidates = await prisma.session.findMany({
    where: { isActive: true, expiresAt: { gt: new Date() } },
  });
  let matched: typeof candidates[number] | null = null;
  for (const row of candidates) {
    if (await verifyPassword(input.refreshToken, row.tokenHash)) {
      matched = row;
      break;
    }
  }
  if (!matched) {
    throw new Error('Invalid or expired refresh token');
  }
  const user = await prisma.user.findUnique({ where: { id: matched.userId } });
  if (!user || !user.isActive || user.deletedAt) {
    throw new Error('Invalid credentials');
  }

  // Rotate: invalidate old, issue new.
  await prisma.session.update({
    where: { id: matched.id },
    data: { isActive: false },
  });
  return issueTokens(user, input.ip, input.userAgent);
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { isActive: false },
  });
}

export async function getMe(userId: string): Promise<AuthResult['user']> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive || user.deletedAt) {
    throw new Error('Not found');
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as AccessPayload['role'],
  };
}

async function issueTokens(
  user: { id: string; email: string; displayName: string; role: string },
  ip: string | null,
  userAgent: string | null,
): Promise<AuthResult> {
  const env = loadEnv();
  const refreshPlain = mintRefresh();
  const refreshHashed = await hashRefresh(refreshPlain);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: refreshHashed,
      expiresAt,
      ipAddress: ip,
      userAgent,
      isActive: true,
    },
  });

  const accessToken = signAccess({
    userId: user.id,
    email: user.email,
    role: user.role as AccessPayload['role'],
    sessionId: session.id,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role as AccessPayload['role'],
    },
    accessToken,
    refreshToken: refreshPlain,
    sessionId: session.id,
  };
}
