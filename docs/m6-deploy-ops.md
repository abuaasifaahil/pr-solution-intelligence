# M6 Deploy Operations Runbook

## Service URLs (live — deployed 2026-05-29)

| Service | URL / ID | Plan |
|---|---|---|
| Frontend (Vercel) | https://pr-solutions.vercel.app | Hobby (free) |
| Backend (Render Web) | https://prsi-api.onrender.com | Free web service |
| Postgres (Render) | `dpg-d8cfmna8qa3s73bhqo50-a` (internal only) | Free **— expires 2026-06-28** |
| Key Value / Redis (Render) | `red-d8cfmngg4nts738m05ug` (internal only) | Free 25 MB |
| GitHub repo | https://github.com/abuaasifaahil/pr-solution-intelligence | Private |
| Vercel project id | `prj_7SoRSyR3afc4BjPDTSrsU266ANy3` | — |
| Render web service id | `srv-d8cftafavr4c73ec362g` | — |

## ⚠ Critical: Render free Postgres expires **2026-06-28** (30 days from creation, NOT 90)

The free Postgres instance is **deleted automatically** on the expiry date. Render's current free Postgres lifecycle is 30 days (older docs said 90 — they've shortened it). Migration options:

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
