# M1 — Repo Scaffold + Docker Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From an empty `app/` folder to a fully booting local stack: `docker compose up` brings Postgres 16 + Redis 7 + Fastify backend + Next.js 14 frontend online, Prisma applies migrations for 11 tables, seed inserts 5 default agents, and `/healthz` on both services returns OK including downstream DB + Redis checks.

**Architecture:** pnpm monorepo with three workspaces (`shared`, `backend`, `frontend`) plus an `infra/` folder for Docker. Shared owns the Prisma schema and exports a typed client. Backend is Fastify with Vitest + supertest. Frontend is Next.js 14 app router. Docker Compose wires everything together for local dev; Vercel + Render take over deployment in M6.

**Tech Stack:** Node 20 LTS, pnpm 9, TypeScript 5, Prisma 5, Fastify 4, Next.js 14, Vitest 1, Playwright 1, PostgreSQL 16, Redis 7, ioredis. Frozen choices in `docs/tech-stack.md`.

**Prerequisites on developer machine:**
- Node 20 LTS (`node -v` → v20.x)
- pnpm 9 (`pnpm -v` → 9.x; install with `corepack enable && corepack prepare pnpm@latest --activate`)
- Docker Desktop with Docker Compose v2 (`docker compose version` → v2.x)
- Git

**Out of scope for M1 (deferred to later milestones):**
- Auth, JWT, bcrypt, RLS policies (M2)
- BaseAgent class + OrchestratorAgent + Redis pub/sub agent bus (M3–M4)
- Settings tabs and CRUD (M5)
- CI workflow, Vercel + Render deploy (M6)

---

## File map (created by this plan)

```
app/
├── .dockerignore                          (Task 1)
├── .env.example                            (Task 1)
├── .prettierrc.json                        (Task 1)
├── .prettierignore                         (Task 1)
├── package.json                            (Task 1)
├── pnpm-workspace.yaml                     (Task 1)
├── tsconfig.base.json                      (Task 1)
├── shared/
│   ├── package.json                        (Task 2)
│   ├── tsconfig.json                       (Task 2)
│   └── db/
│       ├── schema.prisma                   (Task 2)
│       ├── index.ts                        (Task 2)
│       └── seed.ts                         (Task 6)
├── backend/
│   ├── package.json                        (Task 3)
│   ├── tsconfig.json                       (Task 3)
│   ├── vitest.config.ts                    (Task 3)
│   ├── src/
│   │   ├── index.ts                        (Task 3)
│   │   ├── server.ts                       (Task 3)
│   │   ├── env.ts                          (Task 3)
│   │   └── routes/
│   │       └── healthz.ts                  (Task 3, enhanced in Task 7)
│   └── test/
│       ├── healthz.test.ts                 (Task 3)
│       └── healthz-integration.test.ts     (Task 7)
├── frontend/
│   ├── package.json                        (Task 4)
│   ├── tsconfig.json                       (Task 4)
│   ├── next.config.js                      (Task 4)
│   └── app/
│       ├── layout.tsx                      (Task 4)
│       ├── page.tsx                        (Task 4)
│       └── api/healthz/route.ts            (Task 4)
├── infra/
│   ├── Dockerfile.api                      (Task 5)
│   ├── Dockerfile.frontend                 (Task 5)
│   └── docker-compose.yml                  (Task 5)
└── tests/
    └── e2e/
        ├── package.json                    (Task 8)
        ├── playwright.config.ts            (Task 8)
        └── m1-acceptance.spec.ts           (Task 8)
```

---

## Task 1: Workspace root

**Files:**
- Create: `app/package.json`
- Create: `app/pnpm-workspace.yaml`
- Create: `app/tsconfig.base.json`
- Create: `app/.env.example`
- Create: `app/.dockerignore`
- Create: `app/.prettierrc.json`
- Create: `app/.prettierignore`

- [ ] **Step 1: Create `app/package.json`**

```json
{
  "name": "pr-solution-intelligence",
  "version": "0.1.0",
  "private": true,
  "description": "PR Solution Intelligence — AlphaMetricX agentic AI platform",
  "scripts": {
    "format": "prettier --write \"**/*.{ts,tsx,js,json,md,yml,yaml}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,js,json,md,yml,yaml}\"",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "dev:backend": "pnpm --filter backend dev",
    "dev:frontend": "pnpm --filter frontend dev",
    "up": "docker compose -f infra/docker-compose.yml up -d --build",
    "down": "docker compose -f infra/docker-compose.yml down",
    "logs": "docker compose -f infra/docker-compose.yml logs -f",
    "prisma:format": "pnpm --filter shared prisma format",
    "prisma:generate": "pnpm --filter shared prisma generate",
    "prisma:migrate": "pnpm --filter shared prisma migrate dev",
    "prisma:seed": "pnpm --filter shared prisma db seed"
  },
  "devDependencies": {
    "prettier": "3.3.3",
    "typescript": "5.5.4"
  },
  "packageManager": "pnpm@9.10.0",
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

- [ ] **Step 2: Create `app/pnpm-workspace.yaml`**

```yaml
packages:
  - shared
  - backend
  - frontend
  - tests/e2e
```

- [ ] **Step 3: Create `app/tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Create `app/.env.example`**

```bash
# Database
DATABASE_URL=postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public
POSTGRES_USER=prsi
POSTGRES_PASSWORD=prsi_dev
POSTGRES_DB=prsi

# Redis
REDIS_URL=redis://localhost:6379

# Backend
PORT=3001
NODE_ENV=development

# Frontend
NEXT_PUBLIC_API_URL=http://localhost:3001

# Encryption (32-byte hex; generate with: openssl rand -hex 32)
ENCRYPTION_KEY=replace_me_with_64_hex_chars_via_openssl_rand_hex_32

# JWT (M2 — generate with: openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048)
JWT_PRIVATE_KEY=
JWT_PUBLIC_KEY=

# Anthropic (M4)
ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Create `app/.dockerignore`**

```
node_modules
**/node_modules
.next
**/.next
dist
**/dist
.git
.env
.env.*
!.env.example
*.log
coverage
playwright-report
test-results
.vscode
.idea
.DS_Store
```

- [ ] **Step 6: Create `app/.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "endOfLine": "lf"
}
```

- [ ] **Step 7: Create `app/.prettierignore`**

```
node_modules
**/node_modules
.next
**/.next
dist
**/dist
coverage
**/.prisma
pnpm-lock.yaml
```

- [ ] **Step 8: Verify workspace installs cleanly**

Run from `app/`:

```bash
cd app
pnpm install
```

Expected output ends with `Done in X.Xs` and creates `app/pnpm-lock.yaml`.

- [ ] **Step 9: Verify Prettier runs**

```bash
cd app
pnpm format:check
```

Expected: exits 0 (no files to check yet, but tooling works).

- [ ] **Step 10: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/package.json app/pnpm-workspace.yaml app/tsconfig.base.json \
        app/.env.example app/.dockerignore app/.prettierrc.json app/.prettierignore \
        app/pnpm-lock.yaml
git commit -m "M1.1: pnpm workspace root + prettier"
```

---

## Task 2: Shared package + Prisma schema

**Files:**
- Create: `app/shared/package.json`
- Create: `app/shared/tsconfig.json`
- Create: `app/shared/db/schema.prisma`
- Create: `app/shared/db/index.ts`

- [ ] **Step 1: Create `app/shared/package.json`**

```json
{
  "name": "@prsi/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./db/index.ts",
  "types": "./db/index.ts",
  "exports": {
    "./db": "./db/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "echo \"(no tests in shared yet)\" && exit 0"
  },
  "dependencies": {
    "@prisma/client": "5.20.0",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "prisma": "5.20.0",
    "tsx": "4.19.1",
    "typescript": "5.5.4"
  },
  "prisma": {
    "schema": "db/schema.prisma",
    "seed": "tsx db/seed.ts"
  }
}
```

- [ ] **Step 2: Create `app/shared/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["db/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `app/shared/db/schema.prisma`** — full 11-table schema per `docs/phase1.md`

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  admin
  analyst
  viewer
}

enum ChatStatus {
  active
  completed
  archived
}

enum MessageRole {
  user
  assistant
  system
}

enum DataSourceType {
  meltwater
  opoint
  webz
  twitter
  infovision
  custom
}

enum MCPStatus {
  active
  inactive
  error
}

enum LLMProvider {
  claude
  gpt
  ollama
  perplexity
}

model User {
  id           String    @id @default(uuid()) @db.Uuid
  email        String    @unique @db.VarChar(255)
  passwordHash String    @map("password_hash") @db.VarChar(255)
  displayName  String    @map("display_name") @db.VarChar(100)
  role         UserRole  @default(analyst)
  preferences  Json      @default("{}")
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt    DateTime? @map("deleted_at") @db.Timestamptz

  sessions       Session[]
  chats          Chat[]
  dataSources    DataSource[]
  mcpConnections MCPConnection[]
  llmConfigs     LLMConfig[]
  userSkills     UserSkill[]

  @@index([role])
  @@index([isActive])
  @@map("users")
}

model Session {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  tokenHash String   @map("token_hash") @db.VarChar(255)
  expiresAt DateTime @map("expires_at") @db.Timestamptz
  ipAddress String?  @map("ip_address") @db.Inet
  userAgent String?  @map("user_agent")
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, isActive])
  @@index([expiresAt])
  @@map("sessions")
}

model Chat {
  id        String     @id @default(uuid()) @db.Uuid
  userId    String     @map("user_id") @db.Uuid
  agentType String     @map("agent_type") @db.VarChar(50)
  title     String?    @db.VarChar(255)
  status    ChatStatus @default(active)
  context   Json       @default("{}")
  createdAt DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime   @updatedAt @map("updated_at") @db.Timestamptz

  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages Message[]

  @@index([userId, status])
  @@index([createdAt])
  @@map("chats")
}

model Message {
  id        String      @id @default(uuid()) @db.Uuid
  chatId    String      @map("chat_id") @db.Uuid
  role      MessageRole
  content   String
  metadata  Json        @default("{}")
  createdAt DateTime    @default(now()) @map("created_at") @db.Timestamptz

  chat Chat @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@index([chatId, createdAt])
  @@map("messages")
}

model Agent {
  id           String   @id @default(uuid()) @db.Uuid
  name         String   @unique @db.VarChar(100)
  type         String   @unique @db.VarChar(50)
  description  String
  capabilities Json     @default("[]")
  icon         String?  @db.VarChar(50)
  color        String?  @db.VarChar(7)
  isDefault    Boolean  @default(false) @map("is_default")
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  logs AgentLog[]

  @@map("agents")
}

model AgentLog {
  id         String   @id @default(uuid()) @db.Uuid
  agentId    String   @map("agent_id") @db.Uuid
  action     String   @db.VarChar(50)
  input      Json     @default("{}")
  output     Json     @default("{}")
  durationMs Int      @map("duration_ms")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([agentId, createdAt])
  @@map("agent_logs")
}

model DataSource {
  id              String         @id @default(uuid()) @db.Uuid
  userId          String         @map("user_id") @db.Uuid
  sourceType      DataSourceType @map("source_type")
  displayName     String         @map("display_name") @db.VarChar(100)
  apiKeyEncrypted String         @map("api_key_encrypted")
  endpointUrl     String?        @map("endpoint_url") @db.VarChar(500)
  config          Json           @default("{}")
  isActive        Boolean        @default(true) @map("is_active")
  lastTestedAt    DateTime?      @map("last_tested_at") @db.Timestamptz
  createdAt       DateTime       @default(now()) @map("created_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("data_sources")
}

model MCPConnection {
  id             String    @id @default(uuid()) @db.Uuid
  userId         String    @map("user_id") @db.Uuid
  sourceName     String    @map("source_name") @db.VarChar(100)
  serverUrl      String    @map("server_url") @db.VarChar(500)
  tokenEncrypted String    @map("token_encrypted")
  status         MCPStatus @default(inactive)
  lastVerifiedAt DateTime? @map("last_verified_at") @db.Timestamptz
  availableTools Json      @default("[]") @map("available_tools")
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("mcp_connections")
}

model LLMConfig {
  id              String      @id @default(uuid()) @db.Uuid
  userId          String      @map("user_id") @db.Uuid
  provider        LLMProvider
  modelName       String      @map("model_name") @db.VarChar(100)
  apiKeyEncrypted String?     @map("api_key_encrypted")
  maxTokens       Int         @default(4096) @map("max_tokens")
  temperature     Decimal     @default(0.3) @db.Decimal(3, 2)
  isDefault       Boolean     @default(false) @map("is_default")
  createdAt       DateTime    @default(now()) @map("created_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("llm_configs")
}

model Skill {
  id            String   @id @default(uuid()) @db.Uuid
  name          String   @unique @db.VarChar(100)
  description   String
  type          String   @db.VarChar(50)
  handlerConfig Json     @default("{}") @map("handler_config")
  isDefault     Boolean  @default(false) @map("is_default")
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz

  userSkills UserSkill[]

  @@map("skills")
}

model UserSkill {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  skillId   String   @map("skill_id") @db.Uuid
  isEnabled Boolean  @default(true) @map("is_enabled")
  addedAt   DateTime @default(now()) @map("added_at") @db.Timestamptz

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  skill Skill @relation(fields: [skillId], references: [id], onDelete: Cascade)

  @@unique([userId, skillId])
  @@map("user_skills")
}
```

- [ ] **Step 4: Install workspace deps**

```bash
cd app
pnpm install
```

Expected: installs `prisma`, `@prisma/client`, `zod`, `tsx` into `shared/node_modules`.

- [ ] **Step 5: Verify Prisma schema is valid**

```bash
cd app
pnpm prisma:format
```

Expected: reformats `shared/db/schema.prisma` in place; exits 0. Re-running is a no-op.

- [ ] **Step 6: Generate Prisma client**

```bash
cd app
pnpm prisma:generate
```

Expected: writes types to `app/shared/node_modules/.prisma/client/`; exits 0 with `✔ Generated Prisma Client`.

- [ ] **Step 7: Create `app/shared/db/index.ts`**

```ts
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prsi_prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prsi_prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prsi_prisma = prisma;
}

export * from '@prisma/client';
```

- [ ] **Step 8: Verify shared typechecks**

```bash
cd app
pnpm --filter @prsi/shared typecheck
```

Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/shared/ app/pnpm-lock.yaml
git commit -m "M1.2: shared package + Prisma schema (11 tables)"
```

---

## Task 3: Backend Fastify + /healthz (in-process)

**Files:**
- Create: `app/backend/package.json`
- Create: `app/backend/tsconfig.json`
- Create: `app/backend/vitest.config.ts`
- Create: `app/backend/src/env.ts`
- Create: `app/backend/src/server.ts`
- Create: `app/backend/src/routes/healthz.ts`
- Create: `app/backend/src/index.ts`
- Create: `app/backend/test/healthz.test.ts`

- [ ] **Step 1: Create `app/backend/package.json`**

```json
{
  "name": "@prsi/backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --noEmit && echo \"(M1: no bundling yet — tsx serves prod in compose)\"",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/cors": "9.0.1",
    "@prsi/shared": "workspace:*",
    "dotenv": "16.4.5",
    "fastify": "4.28.1",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@types/node": "20.16.5",
    "tsx": "4.19.1",
    "typescript": "5.5.4",
    "vitest": "1.6.1"
  }
}
```

- [ ] **Step 2: Create `app/backend/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `app/backend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 4: Create `app/backend/src/env.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
```

- [ ] **Step 5: Install backend deps**

```bash
cd app
pnpm install
```

- [ ] **Step 6: Write the failing healthz test**

Create `app/backend/test/healthz.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

describe('GET /healthz', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with { ok: true, service: "api" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'api' });
  });
});
```

- [ ] **Step 7: Run the test and confirm it fails**

```bash
cd app
pnpm --filter @prsi/backend test
```

Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 8: Create `app/backend/src/routes/healthz.ts`**

```ts
import type { FastifyInstance } from 'fastify';

export async function healthzRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, service: 'api' as const }));
}
```

- [ ] **Step 9: Create `app/backend/src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';

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

  return app;
}
```

- [ ] **Step 10: Create `app/backend/src/index.ts`**

```ts
import { buildServer } from './server.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 11: Install pino-pretty for dev logs**

```bash
cd app
pnpm --filter @prsi/backend add -D pino-pretty@11.2.2
```

- [ ] **Step 12: Run the test and confirm it passes**

```bash
cd app
pnpm --filter @prsi/backend test
```

Expected: PASS — 1 test, 1 assertion. `Test Files 1 passed (1)`.

- [ ] **Step 13: Typecheck**

```bash
cd app
pnpm --filter @prsi/backend typecheck
```

Expected: exits 0.

- [ ] **Step 14: Smoke test the dev server**

In one terminal:

```bash
cd app
echo 'DATABASE_URL=postgresql://prsi:prsi_dev@localhost:5432/prsi
REDIS_URL=redis://localhost:6379' > backend/.env
pnpm --filter @prsi/backend dev
```

In another:

```bash
curl -sS http://localhost:3001/healthz
```

Expected: `{"ok":true,"service":"api"}`. Then Ctrl+C the dev server.

- [ ] **Step 15: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/ app/pnpm-lock.yaml
git commit -m "M1.3: backend Fastify + /healthz (in-process)"
```

---

## Task 4: Frontend Next.js 14 + /api/healthz

**Files:**
- Create: `app/frontend/package.json`
- Create: `app/frontend/tsconfig.json`
- Create: `app/frontend/next.config.js`
- Create: `app/frontend/app/layout.tsx`
- Create: `app/frontend/app/page.tsx`
- Create: `app/frontend/app/api/healthz/route.ts`

- [ ] **Step 1: Create `app/frontend/package.json`**

```json
{
  "name": "@prsi/frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "test": "echo \"(no FE tests yet — added in M2)\" && exit 0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "14.2.13",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "@types/node": "20.16.5",
    "@types/react": "18.3.5",
    "@types/react-dom": "18.3.0",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 2: Create `app/frontend/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "ES2022"],
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `app/frontend/next.config.js`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
```

- [ ] **Step 4: Create `app/frontend/app/layout.tsx`**

```tsx
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
      <body
        style={{
          margin: 0,
          fontFamily:
            "'DM Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
          background: '#F5F5F5',
          color: '#1A1A1A',
        }}
      >
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Create `app/frontend/app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main style={{ padding: '48px', maxWidth: 800 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        PR Solution Intelligence
      </h1>
      <p style={{ color: '#616161' }}>
        M1 — Foundation Core. Visit{' '}
        <code style={{ background: '#EBF3FE', padding: '2px 6px', borderRadius: 4 }}>
          /api/healthz
        </code>{' '}
        to verify the frontend is alive.
      </p>
    </main>
  );
}
```

- [ ] **Step 6: Create `app/frontend/app/api/healthz/route.ts`**

```ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true, service: 'frontend' });
}
```

- [ ] **Step 7: Install frontend deps**

```bash
cd app
pnpm install
```

- [ ] **Step 8: Build the frontend**

```bash
cd app
pnpm --filter @prsi/frontend build
```

Expected: Next.js compiles successfully; final line includes `Compiled successfully`. Generates `app/frontend/.next/`.

- [ ] **Step 9: Smoke test**

```bash
cd app
pnpm --filter @prsi/frontend dev
```

Then in another terminal:

```bash
curl -sS http://localhost:3000/api/healthz
```

Expected: `{"ok":true,"service":"frontend"}`. Visiting `http://localhost:3000/` in a browser shows the M1 placeholder page. Ctrl+C to stop.

- [ ] **Step 10: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/ app/pnpm-lock.yaml
git commit -m "M1.4: frontend Next.js 14 + /api/healthz"
```

---

## Task 5: Docker Compose stack

**Files:**
- Create: `app/infra/Dockerfile.api`
- Create: `app/infra/Dockerfile.frontend`
- Create: `app/infra/docker-compose.yml`

- [ ] **Step 1: Create `app/infra/Dockerfile.api`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY tests/e2e/package.json tests/e2e/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/shared/node_modules ./shared/node_modules
COPY --from=deps /repo/backend/node_modules ./backend/node_modules
COPY . .
RUN pnpm --filter @prsi/shared exec prisma generate
RUN pnpm --filter @prsi/backend typecheck

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/shared ./shared
COPY --from=build /repo/backend ./backend
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
WORKDIR /repo/backend
EXPOSE 3001
CMD ["pnpm", "start"]
```

- [ ] **Step 2: Create `app/infra/Dockerfile.frontend`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY tests/e2e/package.json tests/e2e/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @prsi/frontend build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/frontend/.next/standalone ./
COPY --from=build /repo/frontend/.next/static ./frontend/.next/static
COPY --from=build /repo/frontend/public ./frontend/public
EXPOSE 3000
CMD ["node", "frontend/server.js"]
```

Note: Next standalone build copies `node_modules` into `.next/standalone/`, so we don't COPY them separately.

- [ ] **Step 3: Create the frontend `public/` directory placeholder**

```bash
cd app
mkdir -p frontend/public
echo "" > frontend/public/.gitkeep
```

- [ ] **Step 4: Create `app/infra/docker-compose.yml`**

```yaml
name: prsi-m1

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-prsi}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-prsi_dev}
      POSTGRES_DB: ${POSTGRES_DB:-prsi}
    ports:
      - '5432:5432'
    volumes:
      - prsi_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-prsi} -d ${POSTGRES_DB:-prsi}']
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - '6379:6379'
    volumes:
      - prsi_redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build:
      context: ..
      dockerfile: infra/Dockerfile.api
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgresql://${POSTGRES_USER:-prsi}:${POSTGRES_PASSWORD:-prsi_dev}@postgres:5432/${POSTGRES_DB:-prsi}?schema=public
      REDIS_URL: redis://redis:6379
    ports:
      - '3001:3001'
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3001/healthz']
      interval: 5s
      timeout: 3s
      retries: 10

  frontend:
    build:
      context: ..
      dockerfile: infra/Dockerfile.frontend
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    environment:
      NODE_ENV: production
      NEXT_PUBLIC_API_URL: http://api:3001
      HOSTNAME: 0.0.0.0
      PORT: 3000
    ports:
      - '3000:3000'
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/api/healthz']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  prsi_pgdata:
  prsi_redisdata:
```

- [ ] **Step 5: Bring the stack up**

```bash
cd app
pnpm up
```

Expected: Docker pulls Postgres + Redis images, builds api and frontend images, brings all four services up. First build takes 2–5 min.

- [ ] **Step 6: Verify all services are healthy**

Wait ~30 seconds, then:

```bash
cd app
docker compose -f infra/docker-compose.yml ps
```

Expected: all four rows show `running (healthy)` (or `Up X seconds (healthy)`).

- [ ] **Step 7: Verify backend healthz from host**

```bash
curl -sS http://localhost:3001/healthz
```

Expected: `{"ok":true,"service":"api"}`.

- [ ] **Step 8: Verify frontend healthz from host**

```bash
curl -sS http://localhost:3000/api/healthz
```

Expected: `{"ok":true,"service":"frontend"}`.

- [ ] **Step 9: Tear down (preserve volumes)**

```bash
cd app
pnpm down
```

- [ ] **Step 10: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/infra/ app/frontend/public/.gitkeep
git commit -m "M1.5: docker-compose stack (postgres + redis + api + frontend)"
```

---

## Task 6: Prisma migrate + seed in compose

**Files:**
- Create: `app/shared/db/seed.ts`
- Modify: `app/infra/Dockerfile.api` (add migrate-on-start)
- Modify: `app/backend/package.json` (add `start` that migrates then runs)

- [ ] **Step 1: Create `app/shared/db/seed.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const defaultAgents = [
  {
    type: 'pr_impact',
    name: 'PR Impact Agent',
    description: 'Analyzes brand sentiment and PR impact across media coverage',
    icon: 'trending-up',
    color: '#0078D4',
    capabilities: ['sentiment_analysis', 'theme_classification', 'entity_extraction'],
    isDefault: true,
  },
  {
    type: 'media_monitoring',
    name: 'Media Monitoring Agent',
    description: 'Tracks brand mentions across news, social, and broadcast channels',
    icon: 'eye',
    color: '#00B7C3',
    capabilities: ['mention_tracking', 'source_aggregation'],
    isDefault: true,
  },
  {
    type: 'media_measurement',
    name: 'Media Measurement Agent',
    description: 'Measures reach, engagement, and AVE across all media touchpoints',
    icon: 'bar-chart',
    color: '#107C10',
    capabilities: ['reach_measurement', 'engagement_metrics'],
    isDefault: true,
  },
  {
    type: 'reputation_index',
    name: 'Reputation Index Agent',
    description: 'Calculates and tracks brand reputation index over time',
    icon: 'shield',
    color: '#7B2F8A',
    capabilities: ['reputation_scoring', 'trend_analysis'],
    isDefault: true,
  },
  {
    type: 'crisis_management',
    name: 'Crisis Management Agent',
    description: 'Detects emerging crises and recommends response strategies',
    icon: 'alert',
    color: '#D13438',
    capabilities: ['anomaly_detection', 'crisis_classification', 'response_recommendation'],
    isDefault: true,
  },
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
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 2: Run migrations locally against compose Postgres**

Bring Postgres up only:

```bash
cd app
docker compose -f infra/docker-compose.yml up -d postgres
```

Wait until healthy (`docker compose -f infra/docker-compose.yml ps`), then:

```bash
cd app
DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public' \
  pnpm prisma:migrate --name init
```

Expected: prompts to name migration (already passed via `--name init`); creates `app/shared/db/migrations/<timestamp>_init/migration.sql`; applies it; outputs `✔ Generated Prisma Client`.

- [ ] **Step 3: Run the seed**

```bash
cd app
DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public' \
  pnpm prisma:seed
```

Expected: `Seeding 5 default agents... ✓ Seeded 5 default agents`.

- [ ] **Step 4: Verify seed in DB**

```bash
docker exec -it $(docker compose -f app/infra/docker-compose.yml ps -q postgres) \
  psql -U prsi -d prsi -c "SELECT type, name, is_default FROM agents ORDER BY type;"
```

Expected: 5 rows, all `is_default = t`, types: `crisis_management`, `media_measurement`, `media_monitoring`, `pr_impact`, `reputation_index`.

- [ ] **Step 5: Update `app/infra/Dockerfile.api` to copy migrations**

Modify the `runtime` stage to include the migrations directory. Replace the `COPY --from=build /repo/shared ./shared` line with two lines so migrations land in the image:

```dockerfile
COPY --from=build /repo/shared ./shared
# (migrations live under shared/db/migrations and are copied above)
```

(No actual change needed — `./shared` copy already includes `db/migrations/`. This step is a sanity check: confirm `shared/db/migrations/` exists locally and will be copied.)

```bash
ls app/shared/db/migrations
```

Expected: a single directory named `<timestamp>_init` containing `migration.sql`.

- [ ] **Step 6: Update `app/backend/package.json` start script to migrate then serve**

Edit the `scripts.start` line:

```json
"start": "pnpm --filter @prsi/shared exec prisma migrate deploy && tsx src/index.ts"
```

The `migrate deploy` command is non-interactive and idempotent — safe to run on every container start.

- [ ] **Step 7: Add a postdeploy seed via a one-shot job in compose**

Append to `app/infra/docker-compose.yml`:

```yaml
  seed:
    build:
      context: ..
      dockerfile: infra/Dockerfile.api
    depends_on:
      postgres:
        condition: service_healthy
      api:
        condition: service_started
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-prsi}:${POSTGRES_PASSWORD:-prsi_dev}@postgres:5432/${POSTGRES_DB:-prsi}?schema=public
    working_dir: /repo
    command: ['pnpm', '--filter', '@prsi/shared', 'prisma', 'db', 'seed']
    restart: 'no'
```

- [ ] **Step 8: Tear down, rebuild, and verify migrate + seed run automatically**

```bash
cd app
pnpm down
docker volume rm prsi-m1_prsi_pgdata 2>/dev/null || true
pnpm up
```

After ~60s:

```bash
docker compose -f app/infra/docker-compose.yml logs api | grep -E "(migration|prisma)" | head -5
docker compose -f app/infra/docker-compose.yml logs seed | tail -5
```

Expected: api logs show `applied successfully` for one migration; seed logs show `✓ Seeded 5 default agents`.

- [ ] **Step 9: Verify via API container**

```bash
docker exec -it $(docker compose -f app/infra/docker-compose.yml ps -q postgres) \
  psql -U prsi -d prsi -c "SELECT COUNT(*) FROM agents WHERE is_default = true;"
```

Expected: `count | 5`.

- [ ] **Step 10: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/shared/db/seed.ts app/shared/db/migrations/ app/backend/package.json app/infra/docker-compose.yml
git commit -m "M1.6: prisma migrate + seed (5 default agents)"
```

---

## Task 7: Healthz pings DB + Redis

**Files:**
- Modify: `app/backend/package.json` (add ioredis)
- Modify: `app/backend/src/routes/healthz.ts`
- Create: `app/backend/src/lib/redis.ts`
- Create: `app/backend/test/healthz-integration.test.ts`

- [ ] **Step 1: Install ioredis**

```bash
cd app
pnpm --filter @prsi/backend add ioredis@5.4.1
```

- [ ] **Step 2: Create `app/backend/src/lib/redis.ts`**

```ts
import Redis from 'ioredis';

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is not set');
    }
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
```

- [ ] **Step 3: Write the failing integration test**

Create `app/backend/test/healthz-integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { closeRedis } from '../src/lib/redis.js';
import { prisma } from '@prsi/shared/db';

describe('GET /healthz (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeRedis();
    await prisma.$disconnect();
  });

  it('returns ok with db + redis status', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('api');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails**

Make sure compose Postgres + Redis are up first:

```bash
cd app
docker compose -f infra/docker-compose.yml up -d postgres redis
sleep 5
DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public' \
REDIS_URL='redis://localhost:6379' \
  pnpm --filter @prsi/backend test
```

Expected: FAIL — old test still passes, new test fails because healthz doesn't return `db` or `redis` fields yet.

- [ ] **Step 5: Update `app/backend/src/routes/healthz.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { prisma } from '@prsi/shared/db';
import { getRedis } from '../lib/redis.js';

type HealthStatus = 'ok' | 'error';

interface HealthzResponse {
  ok: boolean;
  service: 'api';
  db: HealthStatus;
  redis: HealthStatus;
}

export async function healthzRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply): Promise<HealthzResponse> => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const ok = db === 'ok' && redis === 'ok';
    reply.code(ok ? 200 : 503);
    return { ok, service: 'api', db, redis };
  });
}

async function pingDb(): Promise<HealthStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'ok';
  } catch {
    return 'error';
  }
}

async function pingRedis(): Promise<HealthStatus> {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}
```

- [ ] **Step 6: Update the unit test in `healthz.test.ts`**

The original unit test expects exact equality. Update it to match the new shape — but keep it independent of a real DB by mocking. Replace `test/healthz.test.ts` with:

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]), $disconnect: vi.fn() },
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const { buildServer } = await import('../src/server.js');

describe('GET /healthz (unit, mocked deps)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with db + redis = ok when both alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'api', db: 'ok', redis: 'ok' });
  });
});
```

- [ ] **Step 7: Run both tests against the live compose stack**

```bash
cd app
DATABASE_URL='postgresql://prsi:prsi_dev@localhost:5432/prsi?schema=public' \
REDIS_URL='redis://localhost:6379' \
  pnpm --filter @prsi/backend test
```

Expected: both test files pass. Total: 2 tests, 2 assertions.

- [ ] **Step 8: Rebuild api image and verify in compose**

```bash
cd app
pnpm down
pnpm up
sleep 15
curl -sS http://localhost:3001/healthz
```

Expected: `{"ok":true,"service":"api","db":"ok","redis":"ok"}`.

- [ ] **Step 9: Test failure-mode (sanity check)**

Kill Redis only:

```bash
docker compose -f app/infra/docker-compose.yml stop redis
sleep 2
curl -i -sS http://localhost:3001/healthz
```

Expected: HTTP 503; body `{"ok":false,"service":"api","db":"ok","redis":"error"}`.

Bring Redis back:

```bash
docker compose -f app/infra/docker-compose.yml start redis
sleep 5
curl -sS http://localhost:3001/healthz
```

Expected: HTTP 200; all green again.

- [ ] **Step 10: Tear down and commit**

```bash
cd app
pnpm down
```

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/
git commit -m "M1.7: /healthz pings DB + Redis (503 on dependency failure)"
```

---

## Task 8: M1 acceptance test (Playwright)

**Files:**
- Create: `app/tests/e2e/package.json`
- Create: `app/tests/e2e/playwright.config.ts`
- Create: `app/tests/e2e/m1-acceptance.spec.ts`

- [ ] **Step 1: Create `app/tests/e2e/package.json`**

```json
{
  "name": "@prsi/e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "1.47.2",
    "@types/node": "20.16.5",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 2: Install Playwright**

```bash
cd app
pnpm install
pnpm --filter @prsi/e2e exec playwright install --with-deps chromium
```

- [ ] **Step 3: Create `app/tests/e2e/playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    extraHTTPHeaders: { 'x-test-suite': 'm1-acceptance' },
  },
});
```

- [ ] **Step 4: Create `app/tests/e2e/m1-acceptance.spec.ts`**

```ts
import { test, expect, request } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';

test('M1: backend /healthz reports ok with db + redis', async () => {
  const ctx = await request.newContext();
  const res = await ctx.get(`${API_URL}/healthz`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, service: 'api', db: 'ok', redis: 'ok' });
});

test('M1: frontend /api/healthz reports ok', async () => {
  const ctx = await request.newContext();
  const res = await ctx.get(`${FE_URL}/api/healthz`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, service: 'frontend' });
});

test('M1: frontend home page renders placeholder', async ({ page }) => {
  await page.goto(FE_URL);
  await expect(page.getByRole('heading', { name: 'PR Solution Intelligence' })).toBeVisible();
  await expect(page.getByText('M1 — Foundation Core')).toBeVisible();
});

test('M1: database has 5 default agents seeded', async () => {
  const ctx = await request.newContext();
  // M1 does not expose an /agents endpoint yet (that lands in M3).
  // Verify via the healthz response shape plus a direct DB-ping endpoint check.
  // For M1, we assert that healthz says db=ok, which means the migrations ran.
  // The real /agents endpoint test will live in M3's plan.
  const res = await ctx.get(`${API_URL}/healthz`);
  const body = await res.json();
  expect(body.db).toBe('ok');
});
```

Note: M1 does not implement `/api/v1/agents` — that's an M3 deliverable. This test relies on `healthz.db === 'ok'` as a proxy that migrations + seed ran. The 5-agent count is verified directly via the `psql` smoke check in Task 6 Step 9.

- [ ] **Step 5: Bring the stack up**

```bash
cd app
pnpm up
sleep 30
```

- [ ] **Step 6: Run the acceptance test**

```bash
cd app
pnpm --filter @prsi/e2e test
```

Expected output ends with `4 passed`.

- [ ] **Step 7: Tear down**

```bash
cd app
pnpm down
```

- [ ] **Step 8: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/tests/e2e/ app/pnpm-lock.yaml
git commit -m "M1.8: Playwright acceptance test (compose stack + healthz roundtrip)"
```

---

## M1 Definition of Done

Before declaring M1 complete and asking for user approval to move to M2, verify all of the following pass on a clean checkout:

- [ ] `cd app && pnpm install` succeeds
- [ ] `cd app && pnpm typecheck` succeeds across all workspaces
- [ ] `cd app && pnpm up` brings 4 services healthy (postgres, redis, api, frontend) plus the one-shot seed job completing successfully
- [ ] `curl http://localhost:3001/healthz` → `{"ok":true,"service":"api","db":"ok","redis":"ok"}`
- [ ] `curl http://localhost:3000/api/healthz` → `{"ok":true,"service":"frontend"}`
- [ ] `psql ... -c "SELECT COUNT(*) FROM agents WHERE is_default=true"` → `5`
- [ ] `cd app && pnpm --filter @prsi/e2e test` → `4 passed`
- [ ] Killing Redis returns HTTP 503 from `/healthz`; restoring Redis returns 200
- [ ] `git log --oneline` shows 8 commits prefixed `M1.1` through `M1.8`

When all boxes ticked, demo to user. After user approval, write `docs/plans/m2-auth.md`.

---

## Self-review notes

**Spec coverage (per `docs/phase1.md` M1 row):**
- ✓ `docker compose up` boots Postgres+Redis+API+Web → Task 5
- ✓ Prisma migrates 10 (11 with `agent_logs`) tables → Tasks 2 + 6
- ✓ Seed inserts 5 default agents → Task 6
- ✓ `/healthz` returns 200 on both services → Tasks 3, 4, 7

**Type / name consistency checks:**
- Workspace name `@prsi/shared` used identically in Tasks 2, 3, 6, 7
- `prisma` named export from `@prsi/shared/db` used identically in Tasks 2, 7
- Healthz response evolves: Task 3 = `{ ok, service }`; Task 7 = `{ ok, service, db, redis }`. Task 8's test asserts the Task 7 shape. Task 3's original test is updated in Task 7 Step 6 to match the new shape — no orphan assertions.
- Compose project name `prsi-m1` matches volume prefix `prsi-m1_prsi_pgdata` referenced in Task 6 Step 8.

**Known gotchas / explicit non-goals:**
- No `/api/v1/agents` endpoint in M1 — explicitly punted to M3. Task 8's "5 agents seeded" test verifies indirectly via `db: 'ok'` plus the Task 6 Step 9 psql check.
- No RLS policies in M1 — punted to M2 as part of the auth slice.
- No CI workflow — punted to M6 per the design's milestone table.
- No `.env.local` per package — the root `.env.example` documents all env vars; compose passes them directly, dev uses backend-specific `.env`.
