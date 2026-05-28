# M2 — Auth Flow End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the M1 scaffold to a fully working auth flow — user opens the app, gets redirected to `/login`, submits credentials, receives a JWT pair, is redirected to home with a personalized greeting. Refresh-token rotation works automatically when access tokens expire. Logout clears state. Postgres RLS prevents user A from reading user B's rows even on raw queries.

**Architecture:** Backend issues an RS256 access token (15 min TTL) plus a 256-bit refresh token (7-day TTL, bcrypt-hashed in `sessions` table). All `/api/v1/auth/*` routes use Zod for body validation. An `auth` middleware verifies the Bearer token and sets a Postgres session variable `app.user_id` per-request so RLS policies (added in this milestone) automatically scope every query. Frontend keeps the token pair in a Zustand store persisted to localStorage, redirects unauthenticated requests to `/login`, and wraps every API call with a fetch helper that auto-refreshes on 401.

**Tech Stack:** Node 22 + Fastify 4 + Prisma 5 + `jsonwebtoken` 9 + `bcrypt` 5 + Zod 3 (backend) · Next.js 14 + Zustand 4 + Tailwind 3.4 + React Hook Form + Zod 3 (frontend) · Postgres 16 RLS · Vitest + Playwright.

**Prerequisites:**
- M1 merged to `main` (it is — verify `git log main` shows `M1.x` commits).
- Branch: `feature/m2-auth` (already on it).
- Docker Compose stack working: `pnpm up` from `app/` brings 4 services healthy.
- pnpm 11.4 + Docker 29 via Rancher Desktop dockerd-moby on this machine.

**Out of scope for M2 (deferred):**
- httpOnly cookies (M6 — for local dev we keep tokens in localStorage; document the XSS deferral)
- Email verification / password reset (M6 polish)
- OAuth / SSO (not in BRD Phase 1)
- BaseAgent + OrchestratorAgent (M3–M4)
- Settings tabs UI (M5)
- The full Phase 1 home page with 5 agent cards (M3 — M2 just renders a greeting on the existing placeholder home)

---

## File map

```
app/
├── shared/db/
│   ├── schema.prisma                       (no change in M2)
│   ├── migrations/
│   │   └── 20260530_add_rls/               NEW: RLS policies on user-owned tables
│   └── seed.ts                             MODIFY: add 2 test users
├── backend/
│   ├── package.json                        MODIFY: add bcrypt, jsonwebtoken, @fastify/jwt deps
│   ├── src/
│   │   ├── env.ts                          MODIFY: add JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
│   │   ├── server.ts                       MODIFY: register auth routes + middleware decorator
│   │   ├── lib/
│   │   │   ├── bcrypt.ts                   NEW: hashPassword, verifyPassword
│   │   │   ├── jwt.ts                      NEW: signAccess, verifyAccess, mintRefresh, hashRefresh
│   │   │   └── prisma-rls.ts               NEW: Prisma middleware that SETs app.user_id
│   │   ├── services/
│   │   │   └── auth.service.ts             NEW: login, refresh, logout, getMe
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts          NEW: Fastify hook — verify Bearer, attach user
│   │   └── routes/
│   │       └── auth.routes.ts              NEW: 4 endpoints
│   └── test/
│       ├── auth/
│       │   ├── bcrypt.test.ts              NEW: unit
│       │   ├── jwt.test.ts                 NEW: unit
│       │   ├── auth.service.test.ts        NEW: unit (mocked Prisma)
│       │   └── auth.integration.test.ts    NEW: full login/refresh/logout cycle
│       ├── middleware/
│       │   └── auth.middleware.test.ts     NEW: unit (mocked verifyAccess)
│       └── rls/
│           └── rls.integration.test.ts     NEW: user A cannot SELECT user B's rows
├── frontend/
│   ├── package.json                        MODIFY: add tailwindcss, zustand, react-hook-form, @hookform/resolvers
│   ├── tailwind.config.ts                  NEW: Windows 11 Fluent tokens
│   ├── postcss.config.js                   NEW: tailwind + autoprefixer
│   ├── app/
│   │   ├── layout.tsx                      MODIFY: drop inline styles, use Tailwind globals
│   │   ├── globals.css                     NEW: Tailwind directives + CSS vars
│   │   ├── page.tsx                        MODIFY: protect + render greeting
│   │   └── login/
│   │       └── page.tsx                    NEW: login form (Phase 1 Fluent mockup style)
│   ├── lib/
│   │   ├── api-client.ts                   NEW: fetch wrapper with Bearer + auto-refresh
│   │   ├── auth-store.ts                   NEW: Zustand store persisted to localStorage
│   │   └── greeting.ts                     NEW: pure fn — time-of-day → "Good morning|afternoon|evening"
│   └── components/
│       └── auth/
│           └── LoginForm.tsx               NEW: form component (RHF + Zod)
└── tests/e2e/
    └── m2-auth.spec.ts                     NEW: Playwright — login → home greeting → logout → redirect to /login
```

**Migration naming:** Prisma migration directories use `<timestamp>_<name>`. The M1 init migration is `20260528183937_init`. The new RLS migration should use today's date prefix; Prisma `migrate dev --create-only` generates the timestamp automatically. The file map shows `20260530_add_rls` as a placeholder — your actual directory name will be `<YYYYMMDDHHMMSS>_add_rls`.

---

## Task 1: bcrypt helpers (TDD)

**Files:**
- Create: `app/backend/src/lib/bcrypt.ts`
- Create: `app/backend/test/auth/bcrypt.test.ts`
- Modify: `app/backend/package.json` — add `bcrypt` + `@types/bcrypt`

- [ ] **Step 1: Add bcrypt dependency**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend add bcrypt@5.1.1
pnpm --filter @prsi/backend add -D @types/bcrypt@5.0.2
```

If pnpm 11 prompts about untrusted build scripts for `bcrypt` (it has a native postinstall), add `bcrypt: true` to the `allowBuilds:` block in `app/pnpm-workspace.yaml`, then re-run install.

Expected: `app/pnpm-lock.yaml` updates. `node_modules/bcrypt/` contains a `lib/binding/napi-v3/bcrypt_lib.node` native binding.

- [ ] **Step 2: Write the failing test**

Create `app/backend/test/auth/bcrypt.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- bcrypt
```

Expected: FAIL — `Cannot find module '../../src/lib/bcrypt.js'`.

- [ ] **Step 4: Implement `app/backend/src/lib/bcrypt.ts`**

```ts
import bcrypt from 'bcrypt';

const COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
```

- [ ] **Step 5: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- bcrypt
```

Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/lib/bcrypt.ts app/backend/test/auth/bcrypt.test.ts app/backend/package.json app/pnpm-lock.yaml
# include pnpm-workspace.yaml only if you added bcrypt to allowBuilds
[ -n "$(git status --short app/pnpm-workspace.yaml)" ] && git add app/pnpm-workspace.yaml
git commit -m "M2.1: bcrypt helpers (cost 12)"
```

---

## Task 2: JWT keypair + JWT helpers (TDD)

**Files:**
- Create: `app/backend/src/lib/jwt.ts`
- Create: `app/backend/test/auth/jwt.test.ts`
- Modify: `app/backend/src/env.ts` — add `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`
- Modify: `app/backend/package.json` — add `jsonwebtoken`, `@types/jsonwebtoken`
- Modify: `app/.env.example` — document keypair generation
- Create: `app/backend/.env` (gitignored) — dev keypair

- [ ] **Step 1: Generate a dev RSA-2048 keypair**

From PowerShell:

```powershell
cd "c:\KhadarBasha\PR Solutions\app\backend"
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

Verify both files exist and start with `-----BEGIN PRIVATE KEY-----` / `-----BEGIN PUBLIC KEY-----`.

> If `openssl` is not on PATH, use Git for Windows's bundled openssl: `& "C:\Program Files\Git\usr\bin\openssl.exe" ...`. Don't install OpenSSL system-wide just for this.

- [ ] **Step 2: Stuff the keypair into `app/backend/.env` (replaces step 14's earlier minimal .env)**

The PEM contains literal newlines. JWT libs accept them either as literal `\n` in a quoted string or as a multiline value. Use the multiline form via a heredoc:

```powershell
cd "c:\KhadarBasha\PR Solutions\app\backend"
$priv = Get-Content jwt-private.pem -Raw
$pub  = Get-Content jwt-public.pem -Raw
# Read existing minimal .env, prepend keys
$existing = Get-Content .env -Raw -ErrorAction SilentlyContinue
$env_content = @"
DATABASE_URL=postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public
REDIS_URL=redis://localhost:6379
JWT_PRIVATE_KEY=$($priv -replace "`r?`n", '\n')
JWT_PUBLIC_KEY=$($pub -replace "`r?`n", '\n')
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=604800
"@
$env_content | Out-File -FilePath .env -Encoding utf8
```

Then delete the standalone PEM files (the .env now has them — keeping duplicates risks committing the wrong one):

```powershell
Remove-Item jwt-private.pem, jwt-public.pem
```

Confirm `app/backend/.env` is gitignored (root `.gitignore` has `.env`).

- [ ] **Step 3: Update `app/.env.example` to document keypair generation**

Edit `app/.env.example` — replace the empty `JWT_PRIVATE_KEY=` and `JWT_PUBLIC_KEY=` lines with comments showing the generation command:

```bash
# JWT (RS256). Generate dev keypair:
#   openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
#   openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
# Then stuff the contents (newlines escaped as \n) into these vars.
JWT_PRIVATE_KEY=
JWT_PUBLIC_KEY=
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=604800
```

- [ ] **Step 4: Add `jsonwebtoken` dep**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend add jsonwebtoken@9.0.2
pnpm --filter @prsi/backend add -D @types/jsonwebtoken@9.0.7
```

- [ ] **Step 5: Update `app/backend/src/env.ts`**

Replace the file with:

```ts
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_PUBLIC_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(604800),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
```

The Zod `transform` un-escapes `\n` so the PEM has real newlines at use site.

- [ ] **Step 6: Write the failing JWT test**

Create `app/backend/test/auth/jwt.test.ts`:

```ts
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
```

- [ ] **Step 7: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- jwt
```

Expected: FAIL — module not found.

- [ ] **Step 8: Implement `app/backend/src/lib/jwt.ts`**

```ts
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
```

- [ ] **Step 9: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- jwt
```

Expected: PASS — 4 tests pass.

- [ ] **Step 10: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/lib/jwt.ts app/backend/src/env.ts \
        app/backend/test/auth/jwt.test.ts \
        app/backend/package.json app/.env.example app/pnpm-lock.yaml
git commit -m "M2.2: JWT RS256 helpers + RSA-2048 keypair config"
```

---

## Task 3: Auth service (TDD with mocked Prisma)

**Files:**
- Create: `app/backend/src/services/auth.service.ts`
- Create: `app/backend/test/auth/auth.service.test.ts`

The service exposes four functions: `login`, `refresh`, `logout`, `getMe`. Each one acts on Prisma + bcrypt + jwt helpers but does no HTTP — the routes (Task 4) call these and the middleware uses verifyAccess directly.

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/auth/auth.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUser = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
const mockSession = {
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
};

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    user: mockUser,
    session: mockSession,
    $disconnect: vi.fn(),
  },
}));

const { login, refresh, logout } = await import('../../src/services/auth.service.js');
const { verifyAccess } = await import('../../src/lib/jwt.js');

describe('auth.service.login', () => {
  beforeEach(() => {
    mockUser.findUnique.mockReset();
    mockSession.create.mockReset();
  });

  it('returns access + refresh tokens and user on valid credentials', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'kb@test.local',
      passwordHash: hash,
      displayName: 'KhadarBasha',
      role: 'analyst',
      isActive: true,
      deletedAt: null,
    });
    mockSession.create.mockResolvedValue({ id: 's1' });

    const result = await login({ email: 'kb@test.local', password: 'hunter2', ip: '127.0.0.1', userAgent: 'vitest' });

    expect(result.user.email).toBe('kb@test.local');
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    const payload = verifyAccess(result.accessToken);
    expect(payload.userId).toBe('u1');
  });

  it('throws "Invalid credentials" on wrong password', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: hash,
      displayName: 'KB', role: 'analyst', isActive: true, deletedAt: null,
    });
    await expect(
      login({ email: 'kb@test.local', password: 'WRONG', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws "Invalid credentials" on unknown email (no enumeration)', async () => {
    mockUser.findUnique.mockResolvedValue(null);
    await expect(
      login({ email: 'ghost@test.local', password: 'whatever', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws on disabled (isActive=false) user', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const hash = await hashPassword('hunter2');
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: hash,
      displayName: 'KB', role: 'analyst', isActive: false, deletedAt: null,
    });
    await expect(
      login({ email: 'kb@test.local', password: 'hunter2', ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow();
  });
});

describe('auth.service.refresh', () => {
  beforeEach(() => {
    mockSession.findFirst.mockReset();
    mockSession.update.mockReset();
    mockSession.create.mockReset();
    mockUser.findUnique.mockReset();
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const { hashPassword } = await import('../../src/lib/bcrypt.js');
    const refreshPlain = 'a'.repeat(64);
    const refreshHash = await hashPassword(refreshPlain);

    mockSession.findFirst.mockResolvedValue({
      id: 's1', userId: 'u1', tokenHash: refreshHash,
      expiresAt: new Date(Date.now() + 1_000_000), isActive: true,
    });
    mockUser.findUnique.mockResolvedValue({
      id: 'u1', email: 'kb@test.local', passwordHash: 'irrelevant',
      displayName: 'KB', role: 'analyst', isActive: true, deletedAt: null,
    });
    mockSession.update.mockResolvedValue({ id: 's1', isActive: false });
    mockSession.create.mockResolvedValue({ id: 's2' });

    const result = await refresh({ refreshToken: refreshPlain, ip: '127.0.0.1', userAgent: 'vitest' });
    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
    expect(result.refreshToken).not.toBe(refreshPlain);
    expect(mockSession.update).toHaveBeenCalled();
  });

  it('throws on expired refresh token', async () => {
    mockSession.findFirst.mockResolvedValue(null);
    await expect(
      refresh({ refreshToken: 'b'.repeat(64), ip: '127.0.0.1', userAgent: 'vitest' }),
    ).rejects.toThrow();
  });
});

describe('auth.service.logout', () => {
  it('marks the session inactive', async () => {
    mockSession.update.mockResolvedValue({ id: 's1', isActive: false });
    await logout('s1');
    expect(mockSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { isActive: false },
    });
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- auth.service
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/services/auth.service.ts`**

```ts
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
  // Strategy: load all active, unexpired sessions for any user, compare each.
  // Constraint: a refresh token is unique to a single session, so the right
  // table sweep size is bounded by concurrent active sessions (usually ≤ a few
  // hundred). For M2 local dev this is fine; M6 may revisit with a SHA-256
  // index column for O(1) lookup.
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
```

- [ ] **Step 4: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- auth.service
```

Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/services/auth.service.ts app/backend/test/auth/auth.service.test.ts
git commit -m "M2.3: auth service (login, refresh, logout, getMe)"
```

---

## Task 4: Auth routes + Fastify wiring

**Files:**
- Create: `app/backend/src/routes/auth.routes.ts`
- Modify: `app/backend/src/server.ts` — register the routes
- Create: `app/backend/test/auth/auth.integration.test.ts`

- [ ] **Step 1: Create `app/backend/src/routes/auth.routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, refresh, logout, getMe } from '../services/auth.service.js';
import type { AccessPayload } from '../lib/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessPayload;
  }
}

const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

const RefreshBody = z.object({
  refreshToken: z.string().length(64),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const result = await login({
        email: parsed.data.email,
        password: parsed.data.password,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { success: true, data: result };
    } catch (err) {
      reply.code(401);
      return { success: false, error: (err as Error).message };
    }
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body' };
    }
    try {
      const result = await refresh({
        refreshToken: parsed.data.refreshToken,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { success: true, data: result };
    } catch (err) {
      reply.code(401);
      return { success: false, error: (err as Error).message };
    }
  });

  app.delete('/api/v1/auth/session', { preHandler: app.auth }, async (req) => {
    if (req.user?.sessionId) {
      await logout(req.user.sessionId);
    }
    return { success: true, data: { message: 'Logged out' } };
  });

  app.get('/api/v1/auth/me', { preHandler: app.auth }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { success: false, error: 'Unauthenticated' };
    }
    try {
      const user = await getMe(req.user.userId);
      return { success: true, data: { user } };
    } catch {
      reply.code(404);
      return { success: false, error: 'Not found' };
    }
  });
}
```

Note: `app.auth` is the middleware decorator we register in Task 5. The route file imports it via Fastify's plugin system, not directly. The `preHandler` reference will exist once Task 5 lands. **If this task is implemented standalone, the `DELETE` and `GET /me` routes won't be registerable until Task 5 — keep them in the file but expect the integration test in Step 4 to skip them for now.**

- [ ] **Step 2: Wire auth routes into `app/backend/src/server.ts`**

Update the file to register the new routes:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(healthzRoute);
  await app.register(authRoutes);

  return app;
}
```

- [ ] **Step 3: Write the failing integration test (login happy path only — rest comes after Task 5)**

Create `app/backend/test/auth/auth.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { prisma } from '@prsi/shared/db';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';

const TEST_EMAIL = 'login-test@test.local';

describe('POST /api/v1/auth/login (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    // Clean slate per test.
    await prisma.session.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('hunter2'),
        displayName: 'Login Tester',
        role: 'analyst',
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await app.close();
    await closeRedis();
    await prisma.$disconnect();
  });

  it('returns 200 + tokens on correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.accessToken).toBeTypeOf('string');
    expect(body.data.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.user.email).toBe(TEST_EMAIL);
  });

  it('returns 401 on wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'WRONG' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Bring up Postgres + Redis for integration tests**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
docker compose -f infra/docker-compose.yml up -d postgres redis
sleep 5
```

- [ ] **Step 5: Run the integration test**

In PowerShell:

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
# Load JWT keys from backend/.env (dotenv will pick them up)
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/backend test -- auth.integration
```

Expected: PASS — 3 tests.

Note: `DELETE /auth/session` and `GET /auth/me` are not tested yet — they require the middleware from Task 5. We'll extend this integration test in Task 5 Step 5.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/routes/auth.routes.ts app/backend/src/server.ts \
        app/backend/test/auth/auth.integration.test.ts
git commit -m "M2.4: auth routes (POST /login, POST /refresh) + integration test"
```

---

## Task 5: Auth middleware (Fastify decorator)

**Files:**
- Create: `app/backend/src/middleware/auth.middleware.ts`
- Modify: `app/backend/src/server.ts` — register the decorator
- Create: `app/backend/test/middleware/auth.middleware.test.ts`
- Modify: `app/backend/test/auth/auth.integration.test.ts` — add tests for DELETE/me

- [ ] **Step 1: Write the failing unit test**

Create `app/backend/test/middleware/auth.middleware.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authMiddleware } from '../../src/middleware/auth.middleware.js';
import { signAccess } from '../../src/lib/jwt.js';

describe('authMiddleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate('auth', authMiddleware);
    app.get('/protected', { preHandler: app.auth }, async (req) => ({ user: req.user }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Bearer token is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 + attaches user when token is valid', async () => {
    const token = signAccess({
      userId: 'u1',
      email: 'kb@test.local',
      role: 'analyst',
      sessionId: 's-test',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.userId).toBe('u1');
    expect(body.user.email).toBe('kb@test.local');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- auth.middleware
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/backend/src/middleware/auth.middleware.ts`**

```ts
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { verifyAccess, type AccessPayload } from '../lib/jwt.js';

export const authMiddleware: preHandlerAsyncHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    reply.code(401).send({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload: AccessPayload = verifyAccess(token);
    req.user = payload;
  } catch {
    reply.code(401).send({ success: false, error: 'Invalid or expired token' });
  }
};
```

- [ ] **Step 4: Register decorator in `app/backend/src/server.ts`**

Replace the file with:

```ts
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerAsyncHookHandler;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: true, credentials: true });
  app.decorate('auth', authMiddleware);
  await app.register(healthzRoute);
  await app.register(authRoutes);

  return app;
}
```

- [ ] **Step 5: Extend `app/backend/test/auth/auth.integration.test.ts` — add DELETE + GET /me tests**

Append to the existing file (inside the same describe or as a new describe):

```ts
describe('GET /api/v1/auth/me + DELETE /api/v1/auth/session', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await hashPassword('hunter2'),
        displayName: 'Login Tester',
        role: 'analyst',
      },
    });
    const loginRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'hunter2' },
    });
    accessToken = loginRes.json().data.accessToken;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { user: { email: TEST_EMAIL } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await app.close();
  });

  it('GET /me returns the authenticated user', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.user.email).toBe(TEST_EMAIL);
  });

  it('GET /me returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE /session marks session inactive', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Run tests, confirm all pass**

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/backend test
```

Expected: all tests pass — bcrypt (3) + jwt (4) + auth.service (7) + auth.middleware (3) + auth.integration (6) + healthz (2). Total ~25 tests.

- [ ] **Step 7: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/middleware/auth.middleware.ts app/backend/src/server.ts \
        app/backend/test/middleware/ app/backend/test/auth/auth.integration.test.ts
git commit -m "M2.5: auth middleware + DELETE/session + GET /me"
```

---

## Task 6: Postgres RLS migration + Prisma session middleware (TDD)

**Files:**
- Create: `app/shared/db/migrations/<timestamp>_add_rls/migration.sql` (generate via Prisma, then edit)
- Create: `app/backend/src/lib/prisma-rls.ts`
- Modify: `app/backend/src/server.ts` — apply Prisma middleware
- Create: `app/backend/test/rls/rls.integration.test.ts`

This task adds Postgres RLS to 5 user-owned tables: `users`, `chats`, `data_sources`, `mcp_connections`, `llm_configs`. Each RLS policy checks `current_setting('app.user_id', true) = user_id::text`. The Prisma client middleware sets `app.user_id` per-request from `req.user.userId`.

> **Important Prisma RLS caveat:** Postgres RLS is enforced at the SQL connection level. Prisma 5's `$queryRawUnsafe`-based session var setting must happen inside a transaction. For app code we use `prisma.$transaction(async tx => { await tx.$executeRawUnsafe('SET LOCAL ...'); /* ... */ })`. For the global middleware we attach the SET to every request via a Fastify `onRequest` hook that obtains a fresh transaction client and stores it on `req.tx`. **For M2 we go with a simpler pattern**: every service function that does Prisma I/O accepts the user id and SETs the session var. This is verbose but correct. We may refactor in M3 with a cleaner pattern.

For M2, the RLS policies are enforced and the integration test proves user A cannot see user B's data. Application-layer enforcement of `app.user_id` happens inside a tiny helper `withUser(userId, async tx => ...)`.

- [ ] **Step 1: Generate the migration skeleton**

Bring Postgres up if not running:

```bash
cd "c:/KhadarBasha/PR Solutions/app"
docker compose -f infra/docker-compose.yml up -d postgres
sleep 5
```

Generate an empty migration:

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/shared exec prisma migrate dev --create-only --name add_rls
```

Expected: a new directory `app/shared/db/migrations/<timestamp>_add_rls/` with an empty `migration.sql`. Prisma did not detect any schema changes (RLS isn't in the Prisma schema language) so the file is empty.

- [ ] **Step 2: Populate the migration SQL**

Edit `app/shared/db/migrations/<timestamp>_add_rls/migration.sql`:

```sql
-- Enable RLS on user-owned tables
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_configs     ENABLE ROW LEVEL SECURITY;

-- Force RLS even for superusers — defense in depth.
ALTER TABLE users           FORCE ROW LEVEL SECURITY;
ALTER TABLE chats           FORCE ROW LEVEL SECURITY;
ALTER TABLE data_sources    FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE llm_configs     FORCE ROW LEVEL SECURITY;

-- users: a user can only SELECT / UPDATE their own row.
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (current_setting('app.user_id', true)::uuid = id);
CREATE POLICY users_self_update ON users
  FOR UPDATE
  USING (current_setting('app.user_id', true)::uuid = id);
-- INSERT and DELETE on users are admin-only — no policy means denied (with FORCE RLS).

-- chats: scoped by user_id.
CREATE POLICY chats_owner_all ON chats
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- data_sources: scoped by user_id.
CREATE POLICY data_sources_owner_all ON data_sources
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- mcp_connections: scoped by user_id.
CREATE POLICY mcp_connections_owner_all ON mcp_connections
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- llm_configs: scoped by user_id.
CREATE POLICY llm_configs_owner_all ON llm_configs
  FOR ALL
  USING (current_setting('app.user_id', true)::uuid = user_id)
  WITH CHECK (current_setting('app.user_id', true)::uuid = user_id);

-- Admin escape hatch: when app.user_id is NOT set (NULL), policies allow nothing.
-- Migrations and seed scripts must therefore SET app.bypass_rls = 'true' before running,
-- OR use prisma.$queryRaw to bypass via a role with BYPASSRLS. For local dev migrate uses
-- the prisma superuser which has BYPASSRLS implicitly; seed runs before sessions exist
-- and operates on `agents` (no RLS) plus `users` (we INSERT below).

-- Reseating: allow the prisma role to bypass RLS for seed inserts.
-- The 'prsi' user already has BYPASSRLS in postgres:16-alpine because POSTGRES_USER becomes
-- a superuser. No explicit grant needed for local dev.
```

- [ ] **Step 3: Apply the migration**

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/shared exec prisma migrate deploy
```

Expected: `Applying migration <timestamp>_add_rls ... Done.`

Verify with psql:

```bash
docker exec prsi-m1-postgres-1 psql -U prsi -d prsi -c "\d+ users" | head -30
```

Expected: among the policies listed, see `users_self_select` and `users_self_update`.

- [ ] **Step 4: Create the Prisma session helper**

Create `app/backend/src/lib/prisma-rls.ts`:

```ts
import { prisma } from '@prsi/shared/db';
import type { Prisma } from '@prisma/client';

/**
 * Run a callback inside a transaction with the Postgres session var
 * `app.user_id` set to the given user id, so RLS policies scope all
 * queries. The callback receives the transaction client.
 *
 * Usage:
 *   const chats = await withUser(req.user.userId, (tx) => tx.chat.findMany());
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${userId.replace(/'/g, "''")}'`);
    return fn(tx);
  });
}

/** For admin / system contexts that need to bypass RLS. Use sparingly. */
export async function asAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.user_id = ''`);
    return fn(tx);
  });
}
```

- [ ] **Step 5: Write the failing RLS integration test**

Create `app/backend/test/rls/rls.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@prsi/shared/db';
import { withUser } from '../../src/lib/prisma-rls.js';
import { hashPassword } from '../../src/lib/bcrypt.js';
import { closeRedis } from '../../src/lib/redis.js';

const A_EMAIL = 'rls-a@test.local';
const B_EMAIL = 'rls-b@test.local';

describe('RLS isolation between users', () => {
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    // Cleanup any leftovers from prior runs.
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.session.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });

    // Create A + B + 1 chat each.
    const a = await prisma.user.create({
      data: { email: A_EMAIL, passwordHash: await hashPassword('x'), displayName: 'A', role: 'analyst' },
    });
    const b = await prisma.user.create({
      data: { email: B_EMAIL, passwordHash: await hashPassword('x'), displayName: 'B', role: 'analyst' },
    });
    aId = a.id;
    bId = b.id;
    await prisma.chat.create({ data: { userId: aId, agentType: 'pr_impact', title: 'A chat' } });
    await prisma.chat.create({ data: { userId: bId, agentType: 'pr_impact', title: 'B chat' } });
  });

  afterAll(async () => {
    await prisma.chat.deleteMany({ where: { user: { email: { in: [A_EMAIL, B_EMAIL] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL] } } });
    await closeRedis();
    await prisma.$disconnect();
  });

  it('user A only sees their own chat', async () => {
    const aChats = await withUser(aId, (tx) => tx.chat.findMany());
    expect(aChats).toHaveLength(1);
    expect(aChats[0]?.title).toBe('A chat');
  });

  it('user B only sees their own chat', async () => {
    const bChats = await withUser(bId, (tx) => tx.chat.findMany());
    expect(bChats).toHaveLength(1);
    expect(bChats[0]?.title).toBe('B chat');
  });

  it('user A cannot SELECT user B\'s row by id', async () => {
    const found = await withUser(aId, (tx) => tx.chat.findFirst({ where: { user: { email: B_EMAIL } } }));
    expect(found).toBeNull();
  });

  it('user A cannot UPDATE user B\'s row', async () => {
    await expect(
      withUser(aId, (tx) =>
        tx.chat.updateMany({
          where: { user: { email: B_EMAIL } },
          data: { title: 'hijacked' },
        }),
      ),
    ).resolves.toHaveProperty('count', 0);
  });
});
```

Note: the migration itself does not require code in this task. Step 5 above adds RLS to **5 tables**. The seed inserts users (which is itself an RLS-protected table) via `asAdmin` — Task 7 handles that.

- [ ] **Step 6: Run RLS test, confirm pass**

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
$env:REDIS_URL='redis://localhost:6379'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm --filter @prsi/backend test -- rls
```

Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/shared/db/migrations/*_add_rls/ \
        app/backend/src/lib/prisma-rls.ts \
        app/backend/test/rls/
git commit -m "M2.6: Postgres RLS on user-owned tables + Prisma session helper"
```

---

## Task 7: Seed test users (uses `asAdmin` since `users` now has RLS)

**Files:**
- Modify: `app/shared/db/seed.ts` — add 2 test users

- [ ] **Step 1: Edit `app/shared/db/seed.ts`** — add user-seeding after agent-seeding. Replace the existing `main()` body:

```ts
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const defaultAgents = [
  // … unchanged 5-agent array from M1.6 …
] as const;

const testUsers = [
  { email: 'user-a@test.local', displayName: 'Alice (test)', role: 'analyst' as const },
  { email: 'user-b@test.local', displayName: 'Bob (test)',   role: 'analyst' as const },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding ${defaultAgents.length} default agents...`);
  for (const agent of defaultAgents) {
    await prisma.agent.upsert({
      where: { type: agent.type },
      update: agent,
      create: agent,
    });
  }
  console.log(`✓ Seeded ${defaultAgents.length} default agents`);

  // Disable RLS for the seed connection — Prisma's POSTGRES_USER ('prsi') is a
  // superuser via FORCE ROW LEVEL SECURITY, but seed upserts need to read every
  // row regardless of app.user_id. SET LOCAL bypass via the session var.
  console.log(`Seeding ${testUsers.length} test users...`);
  const hash = await bcrypt.hash('Password123!', 12);
  for (const user of testUsers) {
    await prisma.$transaction(async (tx) => {
      // Set the seed user as their own owner so RLS allows their upsert.
      await tx.$executeRawUnsafe(`SET LOCAL app.user_id = ''`);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE postgres`); // ensure BYPASSRLS
      const upserted = await tx.user.upsert({
        where: { email: user.email },
        update: { displayName: user.displayName, passwordHash: hash, role: user.role, isActive: true },
        create: { email: user.email, passwordHash: hash, displayName: user.displayName, role: user.role },
      });
      console.log(`  ✓ ${user.email} → id=${upserted.id}`);
    });
  }
  console.log(`✓ Seeded ${testUsers.length} test users (password: Password123!)`);
}

main()
  .catch((err: unknown) => { console.error('Seed failed:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
```

(Keep the unchanged 5-agent array verbatim from the existing M1.6 file. Don't lose any of them.)

- [ ] **Step 2: Add `bcrypt` to shared deps**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/shared add bcrypt@5.1.1
pnpm --filter @prsi/shared add -D @types/bcrypt@5.0.2
```

- [ ] **Step 3: Run the seed against the live Postgres**

```powershell
$env:DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public'
cd "c:\KhadarBasha\PR Solutions\app"
pnpm prisma:seed
```

Expected:
```
Seeding 5 default agents...
✓ Seeded 5 default agents
Seeding 2 test users...
  ✓ user-a@test.local → id=<uuid>
  ✓ user-b@test.local → id=<uuid>
✓ Seeded 2 test users (password: Password123!)
```

- [ ] **Step 4: Verify users in DB**

```bash
docker exec prsi-m1-postgres-1 psql -U prsi -d prsi -c "SELECT email, display_name, role FROM users ORDER BY email;"
```

Expected: 2 rows, the two test users.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/shared/db/seed.ts app/shared/package.json app/pnpm-lock.yaml
git commit -m "M2.7: seed 2 test users (user-a / user-b @ Password123!)"
```

---

## Task 8: Tailwind setup + Windows 11 design tokens

**Files:**
- Create: `app/frontend/tailwind.config.ts`
- Create: `app/frontend/postcss.config.js`
- Create: `app/frontend/app/globals.css`
- Modify: `app/frontend/app/layout.tsx` — drop inline styles, import globals.css
- Modify: `app/frontend/package.json` — add tailwindcss, postcss, autoprefixer
- Modify: `app/frontend/app/page.tsx` — convert inline styles to Tailwind classes (defer M2-actual logic to Task 11)

- [ ] **Step 1: Install Tailwind + tooling**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend add -D tailwindcss@3.4.13 postcss@8.4.47 autoprefixer@10.4.20
```

- [ ] **Step 2: Create `app/frontend/tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Windows 11 Fluent — primary palette
        'win-blue': {
          50:  '#EBF3FE',
          100: '#D5E8FC',
          200: '#A8D0FA',
          300: '#6CB4F5',
          400: '#3A96F0',
          500: '#0078D4',
          600: '#005EA8',
          700: '#004578',
          800: '#003054',
          900: '#001D33',
        },
        'win-teal':   '#00B7C3',
        'win-green':  '#107C10',
        'win-red':    '#D13438',
        'win-orange': '#CA5010',
        'win-purple': '#7B2F8A',
        // Surfaces
        'surface-base':   '#F5F5F5',
        'surface-card':   '#FFFFFF',
        'surface-sidebar':'#F0F0F0',
        'surface-hover':  '#E8E8E8',
        'surface-active': '#DFDFDF',
        // Text
        'text-primary':   '#1A1A1A',
        'text-secondary': '#616161',
        'text-tertiary':  '#8E8E8E',
        'text-inverse':   '#FFFFFF',
        'border-default': '#E0E0E0',
        'border-subtle':  '#F0F0F0',
      },
      fontFamily: {
        sans: ['"DM Sans"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"Fira Code"', '"JetBrains Mono"', 'monospace'],
      },
      borderRadius: {
        sm: '4px', md: '8px', lg: '12px', xl: '16px',
      },
      boxShadow: {
        'win-2':  '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.1)',
        'win-4':  '0 2px 4px rgba(0,0,0,0.04), 0 4px 8px rgba(0,0,0,0.08)',
        'win-8':  '0 4px 8px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.08)',
        'win-16': '0 8px 16px rgba(0,0,0,0.06), 0 16px 32px rgba(0,0,0,0.1)',
        'win-64': '0 16px 32px rgba(0,0,0,0.08), 0 32px 64px rgba(0,0,0,0.12)',
      },
      transitionTimingFunction: {
        'win-smooth': 'cubic-bezier(0.25, 0.1, 0.25, 1.0)',
        'win-decel':  'cubic-bezier(0, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 3: Create `app/frontend/postcss.config.js`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 4: Create `app/frontend/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html { font-size: 14px; -webkit-font-smoothing: antialiased; }
  body { @apply bg-surface-base text-text-primary font-sans; }
}

@layer components {
  .card {
    @apply bg-surface-card rounded-lg shadow-win-4 p-6;
  }
}
```

- [ ] **Step 5: Update `app/frontend/app/layout.tsx`**

Replace the whole file with:

```tsx
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'PR Solution Intelligence',
  description: 'AlphaMetricX — agentic AI platform for PR and media intelligence',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Update `app/frontend/app/page.tsx`** (placeholder remains M1-styled — full M2 logic comes in Task 11; this step just migrates to Tailwind classes)

```tsx
export default function Home() {
  return (
    <main className="p-12 max-w-3xl">
      <h1 className="text-3xl font-bold mb-2 text-text-primary">PR Solution Intelligence</h1>
      <p className="text-text-secondary">
        M1 — Foundation Core. Visit{' '}
        <code className="bg-win-blue-50 px-1.5 py-0.5 rounded-sm font-mono text-sm">/api/healthz</code>{' '}
        to verify the frontend is alive.
      </p>
    </main>
  );
}
```

- [ ] **Step 7: Verify the build**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend build
```

Expected: `Compiled successfully`. No Tailwind warnings about unknown utilities.

Spot-check via dev server (optional):

```bash
pnpm --filter @prsi/frontend dev
# Visit http://localhost:3000 — should look identical to M1 visually
# (same content, same colors — just produced by Tailwind now)
# Ctrl+C
```

- [ ] **Step 8: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/tailwind.config.ts app/frontend/postcss.config.js \
        app/frontend/app/globals.css app/frontend/app/layout.tsx app/frontend/app/page.tsx \
        app/frontend/package.json app/pnpm-lock.yaml
git commit -m "M2.8: Tailwind 3.4 + Windows 11 Fluent design tokens"
```

---

## Task 9: Frontend auth store + API client

**Files:**
- Create: `app/frontend/lib/auth-store.ts`
- Create: `app/frontend/lib/api-client.ts`
- Create: `app/frontend/lib/greeting.ts`
- Modify: `app/frontend/package.json` — add `zustand`, `react-hook-form`, `@hookform/resolvers`, `zod`

- [ ] **Step 1: Install client-side deps**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend add zustand@4.5.5 react-hook-form@7.53.0 @hookform/resolvers@3.9.0 zod@3.23.8
```

- [ ] **Step 2: Create `app/frontend/lib/greeting.ts`**

```ts
export function greetingFor(date: Date = new Date()): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
```

- [ ] **Step 3: Create `app/frontend/lib/auth-store.ts`**

```ts
'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  setAuth: (user: AuthUser, accessToken: string, refreshToken: string) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken }),
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    {
      name: 'prsi-auth',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
```

- [ ] **Step 4: Create `app/frontend/lib/api-client.ts`**

```ts
'use client';
import { useAuthStore } from './auth-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  options: { retryOn401?: boolean } = { retryOn401: true },
): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && options.retryOn401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch<T>(path, init, { retryOn401: false });
    }
    useAuthStore.getState().clear();
  }

  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return (typeof body === 'object' && body && 'data' in body ? body.data : body) as T;
}

async function tryRefresh(): Promise<boolean> {
  const { refreshToken, setTokens } = useAuthStore.getState();
  if (!refreshToken) return false;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  if (!body.success) return false;
  setTokens(body.data.accessToken, body.data.refreshToken);
  return true;
}
```

- [ ] **Step 5: Typecheck**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/lib/ app/frontend/package.json app/pnpm-lock.yaml
git commit -m "M2.9: frontend Zustand auth store + fetch client with auto-refresh"
```

---

## Task 10: Login page UI (Windows 11 Fluent design from Phase 1 mockup)

**Files:**
- Create: `app/frontend/components/auth/LoginForm.tsx`
- Create: `app/frontend/app/login/page.tsx`

- [ ] **Step 1: Create `app/frontend/components/auth/LoginForm.tsx`**

```tsx
'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuthStore } from '../../lib/auth-store';
import { apiFetch, ApiError } from '../../lib/api-client';

const LoginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password required'),
});
type LoginValues = z.infer<typeof LoginSchema>;

interface LoginResponse {
  user: { id: string; email: string; displayName: string; role: 'admin' | 'analyst' | 'viewer' };
  accessToken: string;
  refreshToken: string;
}

export function LoginForm() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<LoginValues>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginValues): Promise<void> {
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await apiFetch<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setAuth(result.user, result.accessToken, result.refreshToken);
      router.push('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setServerError('Invalid email or password.');
      } else {
        setServerError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-text-primary mb-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
          className="w-full px-3.5 py-2.5 text-sm border border-border-default rounded-md
                     bg-surface-card text-text-primary outline-none
                     focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                     transition"
        />
        {errors.email && <p className="text-win-red text-xs mt-1">{errors.email.message}</p>}
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-text-primary mb-1">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          className="w-full px-3.5 py-2.5 text-sm border border-border-default rounded-md
                     bg-surface-card text-text-primary outline-none
                     focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                     transition"
        />
        {errors.password && <p className="text-win-red text-xs mt-1">{errors.password.message}</p>}
      </div>

      {serverError && (
        <div role="alert" className="text-win-red text-sm bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {serverError}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 text-sm font-semibold rounded-md
                   bg-win-blue-500 text-white shadow-win-4
                   hover:bg-win-blue-600 active:bg-win-blue-700
                   disabled:opacity-50 disabled:cursor-not-allowed
                   transition"
      >
        {submitting ? 'Signing in…' : 'Sign In'}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Create `app/frontend/app/login/page.tsx`**

```tsx
import type { Metadata } from 'next';
import { LoginForm } from '../../components/auth/LoginForm';

export const metadata: Metadata = {
  title: 'Sign in — PR Solution Intelligence',
};

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center
                     bg-gradient-to-br from-win-blue-900 via-win-blue-700 to-win-teal
                     relative overflow-hidden">
      {/* Acrylic card */}
      <div className="relative z-10 w-[420px] max-w-[90vw] p-10
                      bg-white/80 backdrop-blur-2xl border border-white/30
                      rounded-2xl shadow-win-64">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-11 h-11 bg-win-blue-500 rounded-md shadow-win-4 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
              <path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" />
            </svg>
          </div>
          <div className="text-xl font-bold tracking-tight text-text-primary">
            PR Solution Intelligence
          </div>
        </div>
        <p className="text-sm text-text-secondary mb-8">
          Sign in to access your agentic workspace
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Smoke-test the login form against the running backend**

Ensure backend + Postgres are running (`pnpm up postgres redis api`), then bring up the frontend in dev mode:

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend dev
```

Open http://localhost:3000/login. Confirm:
- Acrylic card centered against a blue gradient
- Two input fields styled in Fluent design
- "Sign In" button is win-blue-500
- Try `user-a@test.local` / `Password123!` — expect redirect to `/` (the home page is unchanged from M1.8 / Task 8 — that's the next task's job)
- Try wrong password — expect "Invalid email or password." error alert

If anything looks off, capture a screenshot for Task 11's Playwright comparison.

- [ ] **Step 4: Typecheck + build**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/components/ app/frontend/app/login/
git commit -m "M2.10: login page (Windows 11 Fluent acrylic card + form)"
```

---

## Task 11: Protected home page with greeting

**Files:**
- Modify: `app/frontend/app/page.tsx` — redirect to /login if no session; render greeting
- Create: `app/frontend/components/auth/AuthGate.tsx` — client-only guard

- [ ] **Step 1: Create `app/frontend/components/auth/AuthGate.tsx`**

```tsx
'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../lib/auth-store';
import { apiFetch, ApiError } from '../../lib/api-client';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, accessToken, setAuth, clear } = useAuthStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
      return;
    }
    // Validate the access token by calling /me. If 401, the api-client tries
    // refresh once; if that also fails, store is cleared and we redirect.
    (async () => {
      try {
        const result = await apiFetch<{ user: typeof user }>('/api/v1/auth/me');
        if (result?.user) {
          setAuth(result.user, useAuthStore.getState().accessToken!, useAuthStore.getState().refreshToken!);
        }
        setReady(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clear();
          router.replace('/login');
        } else {
          setReady(true); // network blip — let the page show; api calls will retry
        }
      }
    })();
  }, [accessToken, router, setAuth, clear]);

  if (!user || !ready) {
    return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>;
  }
  return <>{children}</>;
}
```

- [ ] **Step 2: Update `app/frontend/app/page.tsx`**

Replace the file with:

```tsx
'use client';
import { useAuthStore } from '../lib/auth-store';
import { greetingFor } from '../lib/greeting';
import { AuthGate } from '../components/auth/AuthGate';
import { apiFetch } from '../lib/api-client';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  return (
    <AuthGate>
      <Home />
    </AuthGate>
  );
}

function Home() {
  const router = useRouter();
  const { user, clear } = useAuthStore();

  async function handleLogout(): Promise<void> {
    try { await apiFetch('/api/v1/auth/session', { method: 'DELETE' }); } catch { /* fall through */ }
    clear();
    router.replace('/login');
  }

  return (
    <main className="min-h-screen p-12 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-12">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-text-primary">
            {greetingFor()}, <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
          </h1>
          <p className="text-text-secondary">
            M2 — Auth flow online. The full home page with 5 agent cards arrives in M3.
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-sm font-medium rounded-md border border-border-default
                     hover:bg-surface-hover text-text-primary transition"
        >
          Sign out
        </button>
      </div>

      <div className="card">
        <p className="text-sm text-text-secondary">
          Signed in as <code className="font-mono bg-win-blue-50 px-1.5 py-0.5 rounded-sm">{user?.email}</code>{' '}
          (role: {user?.role}).
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Manual smoke test**

Bring stack up if down: `pnpm up`. With dev server running (`pnpm --filter @prsi/frontend dev`):

1. Visit http://localhost:3000 — expect redirect to `/login`.
2. Log in as `user-a@test.local` / `Password123!`. Expect redirect to `/` showing greeting + email + role.
3. Click "Sign out". Expect redirect back to `/login`.
4. Try visiting `/` directly again — expect redirect to `/login`.

- [ ] **Step 4: Build + typecheck**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend typecheck
pnpm --filter @prsi/frontend build
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/app/page.tsx app/frontend/components/auth/AuthGate.tsx
git commit -m "M2.11: protected home page with greeting + sign-out"
```

---

## Task 12: Playwright M2 acceptance test

**Files:**
- Create: `app/tests/e2e/m2-auth.spec.ts`

- [ ] **Step 1: Create `app/tests/e2e/m2-auth.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

test.describe('M2: auth flow', () => {
  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto(FE_URL);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'PR Solution Intelligence' })).toBeVisible();
  });

  test('valid credentials log in and redirect to home', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill(A_PASSWORD);
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page).toHaveURL(FE_URL + '/');
    // Greeting includes the seeded display name
    await expect(page.getByText(/Alice/i)).toBeVisible();
  });

  test('invalid credentials show error message', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill('WRONG');
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page.getByRole('alert')).toContainText(/Invalid email or password/i);
  });

  test('sign out clears session and redirects', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill(A_PASSWORD);
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page).toHaveURL(FE_URL + '/');
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
```

- [ ] **Step 2: Rebuild api + frontend images (auth code is new) and bring stack up**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm down
pnpm up
sleep 60
```

Verify all services healthy + 2 test users seeded:

```bash
docker compose -f infra/docker-compose.yml ps
docker exec prsi-m1-postgres-1 psql -U prsi -d prsi -c "SELECT email, display_name FROM users ORDER BY email;"
```

Expected: 4 services healthy, both `user-a@test.local` and `user-b@test.local` rows.

- [ ] **Step 3: Run the M2 acceptance suite**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/e2e test -- m2-auth.spec
```

Expected: 4 tests pass.

- [ ] **Step 4: Re-run M1 acceptance to confirm no regression**

```bash
pnpm --filter @prsi/e2e test
```

Expected: 8 tests pass (M1's 4 + M2's 4).

- [ ] **Step 5: Tear down**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm down
```

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/tests/e2e/m2-auth.spec.ts
git commit -m "M2.12: Playwright acceptance test for auth flow"
```

---

## M2 Definition of Done

Before declaring M2 complete:

- [ ] `pnpm up` brings the stack healthy; migrate applies both `init` and `add_rls`; seed inserts 5 agents + 2 users
- [ ] `POST /api/v1/auth/login` with `user-a@test.local` / `Password123!` returns `{success:true, data:{accessToken, refreshToken, user:{...}}}`
- [ ] `POST /api/v1/auth/login` with wrong password returns 401
- [ ] `GET /api/v1/auth/me` with valid Bearer returns the user object
- [ ] `GET /api/v1/auth/me` without auth returns 401
- [ ] `DELETE /api/v1/auth/session` marks the session inactive (verify via psql: `SELECT is_active FROM sessions ORDER BY created_at DESC LIMIT 1` → `f`)
- [ ] RLS integration test (`rls.integration.test.ts`) passes — user A cannot SELECT user B's rows
- [ ] Frontend: visit http://localhost:3000 → redirect to /login → sign in → home shows greeting → sign out → back to /login
- [ ] Playwright M2 acceptance suite: 4/4 pass
- [ ] M1 Playwright suite still passes (4/4 — no regression)
- [ ] All backend tests pass (~25 total)
- [ ] `git log main..feature/m2-auth` shows commits M2.1 through M2.12 (12 commits, possibly with `-fix` follow-ups)

When all boxes ticked, demo to user. After approval, the next plan is `m3-chat.md` (chat creation + REST messaging).

---

## Self-review notes

**Spec coverage** (against `docs/phase1.md` M2 row "Auth flow end-to-end"):
- Login UI → Task 10 ✓
- POST /auth/login → Task 4 ✓
- POST /auth/refresh → Task 4 + auto-refresh in Task 9 ✓
- DELETE /auth/session → Task 5 ✓
- GET /auth/me → Task 5 ✓
- Auth middleware → Task 5 ✓
- Refresh-token rotation → Task 3 ✓ (rotates on every refresh call)
- RLS integration test → Task 6 ✓
- Frontend home renders greeting → Task 11 ✓
- Logout → Task 11 (UI) + Task 5 (route) ✓

**Type / name consistency:**
- `AccessPayload` defined in `jwt.ts` (Task 2), imported by `auth.routes.ts`, `auth.service.ts`, `auth.middleware.ts`
- `AuthResult` defined in `auth.service.ts` (Task 3), used in routes (Task 4)
- `AuthUser` defined in `auth-store.ts` (Task 9), used by `LoginForm.tsx` (Task 10) and `page.tsx` (Task 11)
- `LoginSchema` defined in `LoginForm.tsx` is intentionally local — backend re-validates anyway via Zod in `auth.routes.ts`
- Test user emails `user-a@test.local` / `user-b@test.local` consistent across seed (Task 7), RLS test (Task 6), Playwright test (Task 12)
- All `pnpm --filter` calls use `@prsi/backend`, `@prsi/frontend`, `@prsi/shared`, `@prsi/e2e`
- Cost factor 12 used in both `bcrypt.ts` and `seed.ts` user creation

**Open items / known gotchas:**
- Refresh-token DB sweep in `auth.service.refresh` is O(active sessions). Acceptable for M2 local dev; M6 could add a SHA-256 indexed column for O(1) lookup. Documented in the service file comment.
- RLS bypass during seed uses `SET LOCAL ROLE postgres` because the seed's Prisma connection runs as `prsi` superuser. If we later add a non-superuser app role, the seed needs a different bypass strategy.
- localStorage token storage is intentionally vulnerable to XSS for M2 (single-developer local). M6 deploy hardening switches to httpOnly cookies. Document in M6 plan.
- `app.auth` Fastify decorator is registered in `server.ts` but referenced from `auth.routes.ts` at module load — verify Fastify's plugin loading order doesn't trip you up. The pattern works because routes are registered AFTER `app.decorate('auth', ...)`.
- `getMe` doesn't return the session id but `DELETE /auth/session` needs it. Either: (a) embed sessionId in the access token payload (preferred — small change to `signAccess` and `AccessPayload`), or (b) accept Bearer token + look up the session via the user id (less precise — invalidates only the most recent session). **Going with (a)** — add `sessionId` to `AccessPayload`. Update Task 2's `AccessPayload` interface and Task 3's `signAccess` call. (This is already reflected in `auth.routes.ts` Task 4 step 1 line `(req.user as AccessPayload & { sessionId?: string }).sessionId`.)
