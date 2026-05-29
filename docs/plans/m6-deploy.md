# M6 — Deploy + CI (Vercel + Render) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **HUMAN-IN-LOOP REQUIRED:** This plan has tasks that the human user must perform in Vercel and Render web UIs — they're marked **[USER ACTION]**. Agentic workers stop at each USER ACTION block and wait for confirmation before proceeding.

**Goal:** Deploy the running PR Solution Intelligence stack to Vercel (frontend) + Render (backend + Postgres + Redis), connect them to a GitHub repo for auto-deploys on push to `main`, and verify the M2 auth flow works end-to-end on the live URLs.

**Architecture:** Frontend deploys natively to Vercel (Next.js auto-detected from `app/frontend/` root dir). Backend deploys to Render as a Docker web service using the existing `app/infra/Dockerfile.api` — same image we run locally. Render manages Postgres + Key-Value (Redis) as separate services and injects connection strings into the backend service via env vars. Vercel's `NEXT_PUBLIC_API_URL` points at the Render backend's public URL. CORS on the backend is restricted to the Vercel origin via a `CORS_ALLOWED_ORIGIN` env var (currently allows all in dev). Pushes to `main` trigger both Vercel and Render to auto-redeploy.

**Tech Stack:** Vercel (Next.js host) · Render (Docker web service + free Postgres + free Key-Value) · GitHub (source-of-truth, OAuth-connected to Vercel + Render — no API tokens needed for initial setup) · existing project stack (Next.js 14, Fastify 4, Prisma 5, Postgres 16, Redis 7, ioredis, JWT RS256, bcrypt).

**Why pulled forward from end-of-phase:** The user wants to free local disk (Rancher Desktop) and have hot-fix testing happen on cloud preview environments. M3–M5 will proceed with this deploy infrastructure already in place — each future PR will get a Vercel preview URL automatically.

---

## Prerequisites the human user must provide before Task 6

| Item | Why |
|---|---|
| **GitHub repo URL** (`https://github.com/<owner>/<repo>`) | Needed for `git remote add origin`. Without this, push and downstream Vercel/Render setup can't happen. |
| **GitHub auth** | Either `gh auth login` set up locally (recommended), or Git Credential Manager prompts on first push. |
| **Vercel account** | Free. https://vercel.com/signup |
| **Render account** | Free. https://dashboard.render.com/register |

**No API tokens needed for this plan.** All inter-service connections use GitHub OAuth from the Vercel and Render dashboards. Tokens are only required later if we add scripted CI deploys (post-M6).

---

## Critical operational warning — read before starting

**Render's free Postgres expires after ~90 days.** The database is deleted automatically. To avoid losing seeded users and any future data, either:

- Upgrade to Starter Postgres ($7/mo) before the expiry date, OR
- Migrate to Neon / Supabase Postgres (free, persistent) before expiry, OR
- Re-create the free Postgres + re-run seed (data loss accepted)

The expiry calendar reminder is added to `docs/m6-deploy-ops.md` in Task 5 of this plan.

---

## File map

```
app/
├── frontend/
│   └── vercel.json                  NEW: Vercel project config (build / install commands)
├── backend/
│   └── src/
│       ├── env.ts                   MODIFY: add CORS_ALLOWED_ORIGIN
│       └── server.ts                MODIFY: env-driven CORS allowlist
│   └── test/server/
│       └── cors.test.ts             NEW: unit test asserting CORS allow + block
└── infra/
    ├── Dockerfile.api               (already exists from M1 — no change)
    └── render.yaml                  NEW: optional Render Blueprint (manual UI alt path is primary)

docs/
├── plans/
│   └── m6-deploy.md                 NEW: this plan
└── m6-deploy-ops.md                 NEW: ongoing deploy ops runbook
```

---

## Task 1: Backend CORS allowlist driven by env var

**Files:**
- Modify: `app/backend/src/env.ts` — add `CORS_ALLOWED_ORIGIN` field
- Modify: `app/backend/src/server.ts` — use the env value to configure `@fastify/cors`
- Create: `app/backend/test/server/cors.test.ts` — unit test asserting the allow/block behavior

- [ ] **Step 1: Write the failing test**

Create `app/backend/test/server/cors.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]), $disconnect: vi.fn() },
}));
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const ALLOWED = 'https://prsi.vercel.app';
process.env.CORS_ALLOWED_ORIGIN = ALLOWED;

const { buildServer } = await import('../../src/server.js');

describe('CORS allowlist', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('allows requests from the configured origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does NOT echo Access-Control-Allow-Origin for a disallowed origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    });
    // @fastify/cors with strict origin: when origin doesn't match, the header is absent
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- cors
```

Expected: FAIL — current `server.ts` uses `origin: true` (allow all), so the disallowed-origin test fails because the allow-origin header IS echoed.

- [ ] **Step 3: Modify `app/backend/src/env.ts`** — add the new field

Open the file and add `CORS_ALLOWED_ORIGIN` to the schema. The full updated schema:

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
  // Comma-separated list of allowed origins; '*' means allow all (dev only).
  CORS_ALLOWED_ORIGIN: z.string().default('*'),
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

- [ ] **Step 4: Modify `app/backend/src/server.ts`** — read CORS_ALLOWED_ORIGIN and build the allowlist

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

function corsOriginConfig(): true | string[] {
  const raw = process.env.CORS_ALLOWED_ORIGIN ?? '*';
  if (raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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

  await app.register(cors, { origin: corsOriginConfig(), credentials: true });
  app.decorate('auth', authMiddleware);
  await app.register(healthzRoute);
  await app.register(authRoutes);

  return app;
}
```

- [ ] **Step 5: Run test, confirm pass**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/backend test -- cors
```

Expected: PASS — 2 tests.

Run the full backend suite to confirm no regression:

```bash
pnpm --filter @prsi/backend test
```

Expected: all 34 tests pass (32 from M2 + 2 new CORS).

- [ ] **Step 6: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/backend/src/env.ts app/backend/src/server.ts app/backend/test/server/
git commit -m "M6.1: backend CORS allowlist driven by CORS_ALLOWED_ORIGIN env var"
```

---

## Task 2: Vercel project config (vercel.json)

**Files:**
- Create: `app/frontend/vercel.json`

The Vercel project will be configured with **Root Directory = `app/frontend`** in the Vercel UI (Task 7). Once that's set, Vercel auto-detects Next.js. A small `vercel.json` documents the build commands explicitly and pins the framework version, which makes the project easier to reason about across deploys.

- [ ] **Step 1: Create `app/frontend/vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm install --frozen-lockfile && pnpm next build",
  "installCommand": "pnpm install --frozen-lockfile",
  "framework": "nextjs",
  "outputDirectory": ".next",
  "regions": ["iad1"]
}
```

> Note: `regions: ["iad1"]` (Washington DC) keeps the frontend close to Render's default Oregon region for lowest latency. If your Render web service ends up in a different region (Task 10), change this to the closest Vercel region.

- [ ] **Step 2: Verify it doesn't break local build**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
pnpm --filter @prsi/frontend build
```

Expected: `Compiled successfully` (same as before). `vercel.json` is ignored by `next build`; only Vercel's deploy pipeline reads it.

- [ ] **Step 3: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/frontend/vercel.json
git commit -m "M6.2: vercel.json for Vercel project config"
```

---

## Task 3: Render Blueprint (optional reproducibility, manual UI is primary path)

**Files:**
- Create: `app/infra/render.yaml`

Render Blueprints let you describe all your services in one YAML file. Importing the blueprint URL in the Render dashboard creates Postgres + Key-Value + Web Service in one click. For M6 the manual UI walkthrough (Tasks 8–10) is the primary path — the blueprint is **also** committed so future redeploys can use it.

- [ ] **Step 1: Create `app/infra/render.yaml`**

```yaml
# Render Blueprint for PR Solution Intelligence
# https://render.com/docs/blueprint-spec
#
# Usage:
#   1. Push this file to your GitHub repo
#   2. Render Dashboard → Blueprints → New Blueprint Instance
#   3. Point at the repo branch and this file path (app/infra/render.yaml)
#   4. Review the services Render proposes, then Apply
#
# The manual UI walkthrough in docs/plans/m6-deploy.md Tasks 8-10 is the
# primary path for the first deploy. This file exists so subsequent
# deploys can be reproduced declaratively.

services:
  - type: web
    name: prsi-api
    plan: free
    runtime: docker
    dockerfilePath: ./app/infra/Dockerfile.api
    dockerContext: ./app
    region: oregon
    branch: main
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3001
      - key: DATABASE_URL
        fromDatabase:
          name: prsi-postgres
          property: connectionString
      - key: REDIS_URL
        fromService:
          type: keyvalue
          name: prsi-redis
          property: connectionString
      - key: JWT_PRIVATE_KEY
        sync: false  # set manually in dashboard after import
      - key: JWT_PUBLIC_KEY
        sync: false  # set manually in dashboard after import
      - key: JWT_ACCESS_TTL
        value: 900
      - key: JWT_REFRESH_TTL
        value: 604800
      - key: CORS_ALLOWED_ORIGIN
        sync: false  # set to the Vercel URL after Task 7

  - type: keyvalue
    name: prsi-redis
    plan: free
    region: oregon
    ipAllowList: []  # internal access only

databases:
  - name: prsi-postgres
    plan: free
    databaseName: prsi
    user: prsi
    region: oregon
```

> **YAML caveats:** Render's spec has evolved over time. If `type: keyvalue` is unknown, try `type: redis` (older alias). If `ipAllowList` errors, remove it. The manual UI path (Tasks 8–10) is the source of truth — adjust this YAML based on what worked in the UI.

- [ ] **Step 2: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/infra/render.yaml
git commit -m "M6.3: render.yaml Blueprint (optional reproducibility)"
```

---

## Task 4: Update `app/.env.example` with deploy-relevant entries

**Files:**
- Modify: `app/.env.example` — add `CORS_ALLOWED_ORIGIN`

- [ ] **Step 1: Append to `app/.env.example`**

Open the file and add after the existing `NEXT_PUBLIC_API_URL=` line:

```bash
# CORS allowlist — comma-separated origins. '*' allows all (dev only).
# In production: set to your Vercel URL, e.g. https://prsi.vercel.app
CORS_ALLOWED_ORIGIN=*
```

Verify the file does NOT contain any token values (vcp_, rnd_, ghp_ prefixes). If it does, STOP — the file may have residual content from prior runs.

- [ ] **Step 2: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add app/.env.example
git commit -m "M6.4: .env.example documents CORS_ALLOWED_ORIGIN"
```

---

## Task 5: Deploy ops runbook

**Files:**
- Create: `docs/m6-deploy-ops.md`

A single document the user references for: redeploys, env-var updates, migrating Postgres, running seed, rotating JWT keys, the 90-day Postgres expiry, and incident response.

- [ ] **Step 1: Create `docs/m6-deploy-ops.md`**

```markdown
# M6 Deploy Operations Runbook

## Service URLs (fill in after first deploy)

| Service | URL | Plan |
|---|---|---|
| Frontend (Vercel) | https://<your-project>.vercel.app | Free |
| Backend (Render Web) | https://prsi-api.onrender.com | Free |
| Postgres (Render) | internal connection string only | Free |
| Key Value / Redis (Render) | internal connection string only | Free |
| GitHub repo | <user-provided URL> | — |

## ⚠ Critical: Render free Postgres expires after ~90 days

The free Postgres instance is DELETED after ~90 days of creation. Migration options:

1. **Upgrade to Starter Postgres in Render dashboard ($7/mo)** before the expiry — recommended for any data you care about.
2. **Migrate to Neon (https://neon.tech)** — free 0.5 GB persistent Postgres. Export with `pg_dump`, import to Neon, update `DATABASE_URL` in Render web service env.
3. **Re-create free Postgres + re-run seed** — accepts data loss. The seed re-inserts the 5 default agents and 2 test users.

**Add a calendar reminder for 60 days from your Postgres creation date** to make the migration decision before the expiry.

## How auto-deploys work

- **Push to `main`** → Vercel auto-deploys frontend + Render auto-deploys backend
- **Open a PR** → Vercel deploys a preview URL (Render does not preview on free tier)
- **Merge PR to `main`** → both production deploys re-trigger

To force a redeploy without code changes:
- **Vercel:** Project → Deployments → click latest → ⋯ menu → Redeploy
- **Render:** Service → Manual Deploy → Deploy latest commit

## Updating env vars

- **Vercel:** Project Settings → Environment Variables → edit → Save → redeploy (env changes only take effect on next deploy)
- **Render:** Service → Environment → edit → Save (auto-redeploys when env var changes)

## Running database migrations

Migrations run automatically on every backend deploy via `Dockerfile.api`'s start sequence:
1. Container starts
2. `prisma migrate deploy` applies any pending migrations from `app/shared/db/migrations/`
3. Server starts on port 3001

To run a one-off migration manually:
1. Render Dashboard → prsi-api → Shell tab
2. Run: `cd /repo/shared && node_modules/.bin/prisma migrate deploy`

## Running the seed (once per fresh DB)

1. Render Dashboard → prsi-api → Shell tab
2. Run: `cd /repo/shared && node_modules/.bin/tsx db/seed.ts`

Expected output:
- `✓ Seeded 5 default agents`
- `✓ Seeded 2 test users (password: Password123!)`

Idempotent — safe to re-run.

## Rotating JWT keys

1. Generate new keypair locally:
   ```bash
   openssl genpkey -algorithm RSA -out new-priv.pem -pkeyopt rsa_keygen_bits:2048
   openssl rsa -in new-priv.pem -pubout -out new-pub.pem
   ```
2. Copy PEMs (with literal newlines, NOT `\n`-escaped) into Render env vars `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`. Render's multi-line env var input handles newlines correctly.
3. Save → backend auto-redeploys → **all existing access + refresh tokens are invalidated** (users must re-login).
4. Update your local `app/backend/.env` to match (with `\n`-escaped form for dotenv).

## Incident response

| Symptom | Likely cause | First check |
|---|---|---|
| Frontend loads but login fails with CORS error | `CORS_ALLOWED_ORIGIN` doesn't include Vercel URL | Render → Environment → verify value matches the Vercel deployment URL exactly |
| Login returns 500 | Backend can't reach Postgres | Render → prsi-api → Logs; look for Prisma connection errors |
| Slow first request after idle | Free tier cold start (~30s) | Expected on free tier; upgrade to Starter ($7/mo) eliminates |
| Postgres connection refused | Postgres expired (90-day clock) | Render → prsi-postgres dashboard; see expiry warning at top |
| `/healthz` returns 503 with `db: "error"` | DB unreachable | Same as above |
| `/healthz` returns 503 with `redis: "error"` | Redis instance restarted / unreachable | Render → prsi-redis dashboard |

## Smoke test (after any major change)

1. Open the Vercel URL → expect redirect to `/login`
2. Login as `user-a@test.local` / `Password123!`
3. Verify greeting renders with display name "Alice (test)"
4. Sign out → expect redirect back to `/login`
5. (Optional) curl `/healthz`:
   ```
   curl https://prsi-api.onrender.com/healthz
   ```
   Expect `{"ok":true,"service":"api","db":"ok","redis":"ok"}`.

```

- [ ] **Step 2: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add docs/m6-deploy-ops.md
git commit -m "M6.5: deploy ops runbook + 90-day Postgres expiry warning"
```

---

## Task 6: Push code to GitHub

**[BLOCKER until human provides repo URL]**

- [ ] **Step 1 (USER ACTION): Provide GitHub repo URL**

User pastes the URL of an empty (or empty-default-branch) GitHub repo, e.g.:

```
https://github.com/khadarbasha/pr-solution-intelligence
```

- [ ] **Step 2: Add the remote**

Replace `<URL>` with the URL the user provided:

```bash
cd "c:/KhadarBasha/PR Solutions"
git remote add origin <URL>
git remote -v
```

Expected: `origin` listed for both fetch and push.

- [ ] **Step 3: Push main**

```bash
cd "c:/KhadarBasha/PR Solutions"
git checkout main
git push -u origin main
```

If Git Credential Manager pops up a browser, user authenticates with GitHub. If `gh auth status` shows the user is logged in, the push uses that auth automatically.

Expected output ends with:
```
 * [new branch]      main -> main
Branch 'main' set up to track 'origin/main'.
```

- [ ] **Step 4: Push the feature/m6-deploy branch**

```bash
cd "c:/KhadarBasha/PR Solutions"
git checkout feature/m6-deploy
git push -u origin feature/m6-deploy
```

After M6 is fully verified, you'll merge `feature/m6-deploy` → `main` via PR or directly.

- [ ] **Step 5 (NO commit): Verify on GitHub**

User opens the GitHub repo in a browser. Confirms `main` and `feature/m6-deploy` branches are visible, commits are listed.

---

## Task 7: Vercel project setup (USER ACTION via web UI)

**[USER ACTION block — agentic workers wait until user reports completion]**

User performs these steps in the Vercel dashboard:

- [ ] **Step 1: Sign in / create Vercel account**

Visit https://vercel.com → sign in with GitHub (recommended — this also grants Vercel access to the repo for auto-deploys).

- [ ] **Step 2: Import the GitHub repo**

Dashboard → **Add New…** → **Project** → Select the repo pushed in Task 6.

- [ ] **Step 3: Configure project**

Settings:
- **Framework Preset:** Next.js (auto-detected)
- **Root Directory:** `app/frontend` ← critical, change from default
- **Build Command:** leave default (vercel.json overrides)
- **Install Command:** leave default (vercel.json overrides)
- **Node.js Version:** 22.x

- [ ] **Step 4: Add environment variable (placeholder)**

Under Environment Variables, add:
- Key: `NEXT_PUBLIC_API_URL`
- Value: `http://placeholder` (will update in Task 11 after Render backend has a URL)
- Environments: Production, Preview, Development (all)

- [ ] **Step 5: Click Deploy**

Vercel builds + deploys. First build takes ~2 min.

- [ ] **Step 6: Capture the Vercel URL**

After deploy completes, Vercel shows a URL like `https://prsi-xyz.vercel.app`. **Copy this URL** — needed in Task 10.

- [ ] **Step 7: Verify the deploy serves the M1 healthz route**

Open `https://<vercel-url>/api/healthz` — expect `{"ok":true,"service":"frontend"}`.

The home page will redirect to `/login` (AuthGate redirects unauthenticated users). The login form will submit to the placeholder API URL and fail — that's expected until Task 11 wires the real backend URL.

User reports: **Vercel URL = `https://<your-prsi-deploy>.vercel.app`**.

---

## Task 8: Render Postgres service (USER ACTION via web UI)

**[USER ACTION block]**

- [ ] **Step 1: Sign in / create Render account**

Visit https://render.com → sign in with GitHub.

- [ ] **Step 2: Create the Postgres instance**

Dashboard → **New** → **PostgreSQL**

Settings:
- **Name:** `prsi-postgres`
- **Database:** `prsi`
- **User:** `prsi`
- **Region:** Oregon (US-West) — match what we'll use for the web service
- **PostgreSQL Version:** 16
- **Plan:** Free

Click **Create Database**. Provisioning takes ~2 min.

- [ ] **Step 3: Capture the Internal Database URL**

After provisioning, Render shows two connection strings:
- **Internal Database URL** (only usable by Render services in the same region) — copy this
- **External Database URL** (usable from your laptop / external migrations) — also note this in case you need it later

User reports: **Postgres Internal URL = `postgres://prsi:...@prsi-postgres-xyz/prsi`** (don't paste it in chat — keep it in Render only; we use it by reference in Task 10).

---

## Task 9: Render Key-Value (Redis) service (USER ACTION via web UI)

**[USER ACTION block]**

- [ ] **Step 1: Create the Key-Value instance**

Render Dashboard → **New** → **Key Value** (formerly "Redis" — same product, renamed).

Settings:
- **Name:** `prsi-redis`
- **Region:** Oregon (same as Postgres)
- **Plan:** Free (25 MB)
- **Maxmemory Policy:** `noeviction` (default — keeps existing keys until manual eviction; safe for session storage)

Click **Create Key Value**.

- [ ] **Step 2: Capture the Internal Redis URL**

After provisioning, copy the **Internal URL** (looks like `redis://red-xyz:6379`).

User reports: **Redis Internal URL captured** (kept in Render only).

---

## Task 10: Render Web Service for the backend (USER ACTION via web UI)

**[USER ACTION block]**

- [ ] **Step 1: Create the Web Service**

Render Dashboard → **New** → **Web Service** → Connect the GitHub repo from Task 6.

- [ ] **Step 2: Configure the service**

- **Name:** `prsi-api`
- **Region:** Oregon (same as Postgres + Redis)
- **Branch:** `main`
- **Root Directory:** leave blank (we set Docker Context below)
- **Runtime:** **Docker**
- **Dockerfile Path:** `app/infra/Dockerfile.api`
- **Docker Build Context Directory:** `app`
- **Health Check Path:** `/healthz`
- **Plan:** Free

- [ ] **Step 3: Add environment variables**

Under **Environment Variables**, add ALL of the following (use Render's "Add Environment Variable" button for each; for multi-line values like JWT keys, paste the entire PEM with literal newlines preserved — Render's input box accepts them):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `DATABASE_URL` | Click "Add from Database" → select `prsi-postgres` → property `connectionString` (Internal) |
| `REDIS_URL` | Paste the Internal Redis URL from Task 9 |
| `JWT_PRIVATE_KEY` | Paste the contents of your local `app/backend/jwt-private.pem` (the PEM you generated in M2.2 — if you don't have the file anymore, run `openssl genpkey -algorithm RSA -out new-priv.pem -pkeyopt rsa_keygen_bits:2048 && openssl rsa -in new-priv.pem -pubout -out new-pub.pem` to make a fresh pair). **Keep the literal newlines** — do NOT `\n`-escape. |
| `JWT_PUBLIC_KEY` | Paste the matching public PEM. Same rule. |
| `JWT_ACCESS_TTL` | `900` |
| `JWT_REFRESH_TTL` | `604800` |
| `CORS_ALLOWED_ORIGIN` | The Vercel URL from Task 7 Step 6, e.g. `https://prsi-xyz.vercel.app` |

> **Important:** If you DO generate new JWT keys for the deployed env (recommended — don't reuse local dev keys), update your local `app/backend/.env` to match if you ever want to debug deploy-issued tokens locally. Or keep them separate (dev local keys + production Render keys are different) — that's safer.

- [ ] **Step 4: Click Create Web Service**

Render pulls the repo, builds the Docker image, and starts the container. First build takes 5–10 minutes (image build + pnpm install + Next/Prisma compile).

- [ ] **Step 5: Watch the build logs**

Render Dashboard → prsi-api → **Logs** tab.

Expect to see:
1. `==> Building with Docker...`
2. `==> Successfully built`
3. `==> Starting service`
4. Output of `prisma migrate deploy` showing migrations applied (init, add_rls, add_rls_role, add_default_privileges)
5. Fastify server listening on port 3001
6. `==> Your service is live 🎉`

If the build fails:
- Capture the error from the logs
- Common causes: Dockerfile path wrong, env vars missing, JWT PEMs malformed
- Report the error; the agentic worker will help debug

- [ ] **Step 6: Capture the Render backend URL**

Render shows the public URL, e.g. `https://prsi-api.onrender.com`. Copy it.

- [ ] **Step 7: Verify the backend healthz**

```bash
curl https://prsi-api.onrender.com/healthz
```

Expected: `{"ok":true,"service":"api","db":"ok","redis":"ok"}` — proves backend + DB + Redis are all wired.

User reports: **Render backend URL = `https://prsi-api.onrender.com`** (the actual URL Render assigned).

---

## Task 11: Update Vercel `NEXT_PUBLIC_API_URL` (USER ACTION)

**[USER ACTION block]**

Now that the Render backend has a real URL (Task 10 Step 6), point the Vercel frontend at it.

- [ ] **Step 1: Update the Vercel env var**

Vercel Dashboard → Project → **Settings** → **Environment Variables** → edit `NEXT_PUBLIC_API_URL`:
- New value: the Render URL from Task 10 Step 6, e.g. `https://prsi-api.onrender.com`
- Apply to: Production, Preview, Development

Click **Save**.

- [ ] **Step 2: Trigger a redeploy**

Env var changes only take effect on the next deploy. Either:
- Vercel Dashboard → Deployments → ⋯ on latest → **Redeploy**, OR
- Push any commit to `main` to trigger auto-redeploy

Wait ~2 min for redeploy.

- [ ] **Step 3: Verify the frontend now talks to the backend**

Open browser DevTools → Network tab. Visit `https://<vercel-url>/login`. Watch the network panel — no requests yet, just the HTML load.

User reports: **Frontend redeployed with backend URL wired.**

---

## Task 12: Run the seed on the deployed Postgres (USER ACTION)

**[USER ACTION block]**

Migrations ran automatically on the first Render deploy (Task 10 Step 5). The seed does NOT run automatically — it needs a manual one-time run.

- [ ] **Step 1: Open the Render shell**

Render Dashboard → prsi-api → **Shell** tab.

- [ ] **Step 2: Run the seed**

```bash
cd /repo/shared && node_modules/.bin/tsx db/seed.ts
```

Expected output:
```
Seeding 5 default agents...
✓ Seeded 5 default agents
Seeding 2 test users...
  ✓ user-a@test.local → id=<uuid>
  ✓ user-b@test.local → id=<uuid>
✓ Seeded 2 test users (password: Password123!)
```

- [ ] **Step 3 (optional): Verify via Render's psql shell**

Render Dashboard → prsi-postgres → **Connect** → **psql Command** → copy the command → run in your local terminal (uses the External URL).

```sql
SELECT email, display_name FROM users WHERE email LIKE '%@test.local';
```

Expected: 2 rows.

User reports: **Seed completed, 2 test users + 5 default agents in DB.**

---

## Task 13: Smoke test the live deploy end-to-end

**[USER ACTION + agentic verification]**

- [ ] **Step 1: Visit the Vercel URL**

Open `https://<your-prsi-deploy>.vercel.app` in a browser.

Expected: redirect to `/login` (because AuthGate). Login form renders with the Windows 11 acrylic card.

- [ ] **Step 2: Log in**

- Email: `user-a@test.local`
- Password: `Password123!`

Click **Sign In**.

Expected: redirect to `/`. Greeting renders: "Good morning|afternoon|evening, Alice (test)". Email + role shown in the card.

- [ ] **Step 3: Sign out**

Click **Sign out**. Expected: redirect back to `/login`. Try visiting `/` again — should redirect to `/login` again.

- [ ] **Step 4: Verify network calls**

Open browser DevTools → Network tab. Repeat the login flow. Confirm:
- `POST https://prsi-api.onrender.com/api/v1/auth/login` returns 200 with tokens
- `GET https://prsi-api.onrender.com/api/v1/auth/me` returns 200
- `DELETE https://prsi-api.onrender.com/api/v1/auth/session` returns 200 on sign-out
- No CORS errors in console

- [ ] **Step 5 (optional, with the agentic worker): Run Playwright against the live URLs**

```bash
cd "c:/KhadarBasha/PR Solutions/app"
FE_URL=https://<vercel-url> API_URL=https://<render-url> pnpm --filter @prsi/e2e test
```

The Playwright spec from M2 uses env vars `FE_URL` and `API_URL` (default localhost). Setting them to the live URLs runs the same 4 acceptance tests against production.

Expected: 4 passed (m2-auth.spec.ts) + 3 passed (m1-acceptance.spec.ts) = 7 passed.

User reports: **End-to-end live deploy works — login + sign-out + healthz roundtrip all green.**

---

## Task 14: Update CLAUDE.md + commit M6 completion

**Files:**
- Modify: `CLAUDE.md` — add Live URLs section + mark M6 complete

- [ ] **Step 1: Update `CLAUDE.md` "Current state"**

Replace the Current state section with:

```markdown
## Current state

- **Active phase:** Phase 1 — Foundation Core
- **Active milestone:** M3 — Chat creation + REST messaging *(next; previously deferred while M6 was pulled forward)*
- **Completed milestones:** M1 (repo scaffold), M2 (auth flow), M6 (deploy: Vercel + Render)
- **Live URLs:** see `docs/m6-deploy-ops.md` — frontend on Vercel, backend on Render
- **Remaining:** M3 (chat creation), M4 (WebSocket + Orchestrator), M5 (settings tabs)
- See `docs/phase1.md` for milestone breakdown and `docs/plans/` for per-milestone plans.
```

- [ ] **Step 2: Update `docs/m6-deploy-ops.md` with actual URLs**

Replace the placeholder URLs in the "Service URLs" table with the real ones from Task 7 Step 6 and Task 10 Step 6.

- [ ] **Step 3: Commit**

```bash
cd "c:/KhadarBasha/PR Solutions"
git add CLAUDE.md docs/m6-deploy-ops.md
git commit -m "M6.14: mark deploy complete + live URLs in CLAUDE.md"
git push origin feature/m6-deploy
```

---

## M6 Definition of Done

Before declaring M6 complete and ready to merge to `main`:

- [ ] `git remote -v` shows `origin` pointing at user's GitHub repo
- [ ] `main` and `feature/m6-deploy` branches both visible on GitHub
- [ ] Vercel project connected to repo; auto-deploys on push to `main`
- [ ] Render web service `prsi-api` deployed and healthy
- [ ] Render Postgres `prsi-postgres` provisioned and migrated (4 migrations applied)
- [ ] Render Key-Value `prsi-redis` provisioned and connected
- [ ] `curl https://prsi-api.onrender.com/healthz` returns `{"ok":true,"db":"ok","redis":"ok"}`
- [ ] Open `https://<vercel-url>/login` → log in as `user-a@test.local` / `Password123!` → see greeting → sign out → back to /login
- [ ] No CORS errors in browser DevTools
- [ ] Render Postgres expiry date noted in calendar / docs/m6-deploy-ops.md
- [ ] CLAUDE.md updated with live URLs and M3-active marker

---

## Self-review notes

**Spec coverage (against user's M6 deploy ask):**
- Push code to GitHub → Task 6 ✓
- Frontend on Vercel → Tasks 2, 7, 11 ✓
- Backend on Render → Tasks 3, 8, 9, 10 ✓
- "Hot fixes test on Vercel+Render" → auto-deploy on push to main + Vercel PR previews (free) ✓
- Login credentials for testing → Task 13 (user-a@test.local / Password123!) ✓
- Free disk space (alternative to Rancher) → user can quit Rancher after M6 lands; local Docker stays as documented dev fallback ✓

**Cross-task consistency:**
- Same Vercel URL value flows: Task 7 (capture) → Task 10 Step 3 (`CORS_ALLOWED_ORIGIN`) → Task 14 Step 2 (docs)
- Same Render URL value flows: Task 10 Step 6 (capture) → Task 11 Step 1 (`NEXT_PUBLIC_API_URL`) → Task 14 Step 2 (docs)
- Postgres connection string flows: Task 8 (create) → Task 10 Step 3 `DATABASE_URL` "Add from Database" reference
- Redis URL flows: Task 9 (capture) → Task 10 Step 3 `REDIS_URL` paste
- JWT PEM keys flows: M2.2 local generation → Task 10 Step 3 paste (multi-line preserved) → key rotation procedure in `docs/m6-deploy-ops.md`

**No placeholders verified:**
- All code blocks contain complete code
- All commands include exact paths
- USER ACTION blocks specify exactly which clicks and which values

**Known gotchas (documented):**
- Render free Postgres expires after ~90 days (Task 5 + Task 14)
- Free web service sleeps after 15 min idle, ~30s cold start (documented in `m6-deploy-ops.md`)
- `type: keyvalue` vs `type: redis` in render.yaml — manual UI is primary path; YAML caveat noted
- JWT PEM multi-line: Render accepts; local `.env` needs `\n`-escaped form
- Both Vercel + Render need GitHub OAuth on first connect (one-time)
