# Tech Stack — Frozen Decisions

These choices apply to every phase. They are **immutable after Phase 1 ships**; breaking changes require API versioning (`/api/v2/`) per Phase 1 spec §8.1.

## Frontend

| Concern | Choice | Version | Rationale |
|---|---|---|---|
| Framework | Next.js (app router) | 14.x | SSR for login/home; CSR for chat |
| Language | TypeScript | 5.x | Shared types with backend via `app/shared/` |
| Styling | Tailwind CSS + CSS variables | 3.4+ | Windows 11 Fluent tokens |
| State | Zustand | 4.x | Lightweight; devtools support |
| Forms | React Hook Form + Zod | latest | Shared validators with backend |
| Theme | Windows 11 light (Phase 1) | — | Dark mode deferred to Phase 6 |

## Backend

| Concern | Choice | Version | Rationale |
|---|---|---|---|
| Runtime | Node | 22 LTS | pnpm 11 requires Node ≥22.13; LTS through Apr 2027 |
| Framework | Fastify | 4.x | ~2× throughput vs Express; schema-based validation |
| ORM | Prisma | 5.x | Type-safe; auto migrations; introspection |
| Validation | Zod | 3.x | Shared FE+BE; type inference |
| WebSocket | `@fastify/websocket` | latest | Native WS upgrade per chat |
| LLM SDK | `@anthropic-ai/sdk` | latest | Claude default per BRD; pluggable for GPT/Ollama/Perplexity |

## Data

| Concern | Choice | Version | Rationale |
|---|---|---|---|
| RDBMS | PostgreSQL | 16.x | JSONB, RLS, GIN indexes, full-text search |
| Cache + bus | Redis | 7.x | Sessions, pub/sub, rate limits |
| Vector store | Postgres + `pgvector` | Phase 5+ | Defer; decided when Learning Agent lands |

## Security

| Concern | Choice |
|---|---|
| Password hash | bcrypt, cost 12 |
| Access token | JWT RS256, 15-min TTL, payload `{ userId, email, role }` |
| Refresh token | Random 256-bit, bcrypt-hashed in `sessions` table, 7-day TTL |
| API-key / MCP-token encryption | AES-256-GCM, env-stored key, base64 storage |
| Row-level security | Postgres RLS on `users`, `chats`, `data_sources`, `mcp_connections`, `llm_configs` |
| Secret storage | Render env vars + Vercel env vars; never in code or DB |

## Testing

| Tier | Tool |
|---|---|
| Unit | Vitest |
| Integration (API) | Vitest + supertest |
| E2E (browser) | Playwright |
| Load (post-M6, optional) | k6 |

## DevOps

| Concern | Choice |
|---|---|
| Local dev | Docker Compose (Postgres + Redis + API + Web) |
| Frontend host | Vercel |
| Backend host | Render (web service) |
| Database host | Render Postgres |
| Cache host | Render Redis |
| CI | GitHub Actions (lint → test → build → deploy) |
| Container image | Multi-stage Node 20-alpine; target < 200MB |

## Folder layout (`/app/`)

Per Phase 1 spec §2.3:

```
app/
├── shared/                # types, constants, db schema (Prisma), validators
├── backend/               # Fastify server, routes, services, agents, websocket
├── frontend/              # Next.js app router + components + stores + styles
├── infra/                 # docker-compose, Dockerfiles, .github/workflows
└── tests/                 # unit / integration / e2e
```

## Rejected alternatives (do not reintroduce without an ADR)

| Rejected | In favor of | Reason |
|---|---|---|
| Python + FastAPI + LangChain/LangGraph | Node + Fastify | One language end-to-end; Phase 1 spec picks Node |
| Express | Fastify | Throughput + schema validation |
| Drizzle / TypeORM | Prisma | Migrations + introspection ergonomics |
| NextAuth | Custom JWT | Need refresh-token rotation and RLS-bound sessions |
| Supabase / Firebase | Self-managed Postgres on Render | RLS, cross-cloud portability, no vendor lock-in |
| Express-session / cookie auth | JWT pair | Multi-device + WS auth via Bearer token |
