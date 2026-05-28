# Phase 1 — Foundation Core (ACTIVE)

**Source:** `Phase 1/Phase1_Technical_Specification.docx`
**Status:** Active phase · M1 not started
**Phase contracts:** All deliverables here are immutable once Phase 1 ships. Phase 2+ consumes them via §8 below.

> Read this file before any Phase 1 work. Read `docs/tech-stack.md` for cross-phase tech choices. Do not read `phase2.md` … `phase6.md` unless the work crosses phase contracts.

## Scope — what Phase 1 ships

| Area | Deliverable |
|---|---|
| Authentication | JWT login/logout/refresh with session isolation (15-min access, 7-day refresh) |
| Database | PostgreSQL with 10 core tables + Redis for sessions/caching |
| Agent framework | `BaseAgent` abstract class + `OrchestratorAgent` skeleton + `AgentRegistry` |
| API | Fastify REST with 22 endpoints + WebSocket per-chat channels |
| Chat UI | Full conversational interface — Windows 11 light theme, chips, file drop zone |
| Home | 5 agent recommendation cards + prompt bar |
| Settings | Data Sources (API+MCP), Model, Skills, Agents — all CRUD functional |
| Real-time | WebSocket streaming for chat messages + agent progress events |
| DevOps | Docker Compose local + GH Actions CI/CD + Vercel/Render staging |

## What Phase 1 does NOT do

- No PR-domain enrichment (→ Phase 3). M4's Orchestrator response is a generic Claude acknowledgement, not analysis.
- No file ingestion or Boolean queries (→ Phase 2)
- No dashboards (→ Phase 4)
- No learning / episodic memory (→ Phase 5)
- No admin UI (→ Phase 6)

## Milestones — vertical slices

See `00-overview.md` for the full table. Headline:

- **M1** Repo scaffold + Docker Compose
- **M2** Auth flow end-to-end
- **M3** Chat creation + REST messaging
- **M4** WebSocket + OrchestratorAgent
- **M5** Settings module (5 tabs)
- **M6** Deploy + CI

User drives transitions: each milestone ends with a manual demo and explicit approval.

## Database — 10 tables

Per spec §3.2. Full Prisma schema lands in `app/shared/db/schema.prisma` at M1. Quick reference (PK + scope only):

1. **users** — id, email (UNIQUE), password_hash, display_name, role enum (`admin|analyst|viewer`), preferences JSONB, soft-delete via `deleted_at`
2. **sessions** — id, user_id FK, token_hash (bcrypt of refresh token), expires_at, ip, ua, is_active
3. **chats** — id, user_id FK, agent_type, title, status enum (`active|completed|archived`), context JSONB
4. **messages** — id, chat_id FK, role enum (`user|assistant|system`), content TEXT, metadata JSONB
5. **agents** — id, name (UNIQUE), type (UNIQUE), description, capabilities JSONB, icon, color, is_default
6. **data_sources** — id, user_id FK, source_type enum (`meltwater|opoint|webz|twitter|infovision|custom`), api_key_encrypted, endpoint_url, config JSONB, last_tested_at
7. **mcp_connections** — id, user_id FK, source_name, server_url, token_encrypted, status enum (`active|inactive|error`), available_tools JSONB
8. **llm_configs** — id, user_id FK, provider enum (`claude|gpt|ollama|perplexity`), model_name, api_key_encrypted, max_tokens INT, temperature DECIMAL(3,2), is_default
9. **skills** — id, name (UNIQUE), description, type, handler_config JSONB, is_default
10. **user_skills** — join: user_id, skill_id, is_enabled, UNIQUE(user_id, skill_id)

**Indexes:** UNIQUE(email); `idx_chats_user_status(user_id, status)`; `idx_chats_context GIN`; `idx_sessions_user_active(user_id, is_active)`; `idx_sessions_expires`.

**RLS policies on:** `users` (SELECT/UPDATE own), `chats`, `data_sources`, `mcp_connections`, `llm_configs`. Verified at M2 with a cross-user-fetch integration test.

## API surface — 22 endpoints

All prefixed `/api/v1/`. Response envelope: `{ success: boolean, data: T, error?: string, meta?: { page, limit, total } }`. Full schema in `app/shared/contracts/phase1-api.ts` once M2 lands.

| Group | Count | Endpoints |
|---|---|---|
| Auth | 4 | POST `/auth/login` · POST `/auth/refresh` · DELETE `/auth/session` · GET `/auth/me` |
| Chat | 7 | POST/GET `/chats` · GET/PATCH/DELETE `/chats/:id` · POST/GET `/chats/:id/messages` |
| Agent | 3 | GET `/agents` · GET `/agents/:id` · GET `/agents/:id/health` |
| Settings — Data Sources | 5 | GET/POST · PATCH/DELETE `/:id` · POST `/:id/test` |
| Settings — MCP | 5 | GET/POST · PATCH/DELETE `/:id` · POST `/:id/verify` |
| Settings — Model | 2 | GET/POST `/settings/model` |
| Settings — Skills | 3 | GET/POST `/settings/skills` · PATCH `/settings/skills/:id` |

Total: 4 + 7 + 3 + 5 + 5 + 2 + 3 = **29** route handlers. Spec says "22 endpoints" — discrepancy explained: spec counts route paths (some paths share GET+POST in one row). Either count is fine; what matters is full coverage.

**WebSocket:** `ws://host/ws/chat/:chatId` · JWT in query param · events: `message:new`, `message:chunk`, `typing:start`, `typing:stop`, `agent:progress`, `error`.

## Agent framework

`BaseAgent` abstract class — every later phase's agent extends this. Lifecycle: `perceive → reason → plan → act → reflect → learn`. Methods are `abstract` in Phase 1; `learn` is a virtual no-op (Phase 5 implements). Inter-agent comms via Redis pub/sub channels `agent:{type}:incoming`. Health surface: `getHealth()` returns `{ status, uptime, lastActionAt, messageCount }`. Audit: every action writes a log row (see "Open items" below for table-name decision).

**OrchestratorAgent (Phase 1):** placeholder routing only.
- `perceive`: parse intent keywords from user message
- `reason`: stub — always self-routes in Phase 1
- `plan`: return `[acknowledge, collect_params, route_to_agent]`
- `act`: generate Claude-powered acknowledgement reply (M4 onwards)
- `reflect`: validate WS delivery; log success/failure

Phase 2 expands `reason` and `plan` to route to `DataExtractAgent`.

## Contracts exposed to Phase 2+

Per spec §8. **Immutable** — breaking changes require `/api/v2/`.

1. Auth middleware (JWT verification + user-context injection)
2. `BaseAgent` class
3. `AgentRegistry` service
4. Redis pub/sub channels (`agent:{type}:incoming`)
5. 10-table DB schema (Phase 2+ adds tables, never drops or alters)
6. WebSocket per-chat channels (Phase 3 adds `enrichment:progress` event)
7. Shared TypeScript types in `app/shared/types/`
8. 22 REST endpoints (additive only)
9. Encryption service (`encrypt(plaintext) → base64`)
10. Windows 11 theme tokens (Tailwind config + CSS vars)

## Performance targets — validated at M6

Per spec §9. Headline targets to hit before sign-off:

| Tier | Metric | Target |
|---|---|---|
| DB | Chat list query (P95) | < 10 ms |
| API | Endpoint reads (P95) | < 50 ms |
| WS | Message delivery end-to-end | < 30 ms |
| FE | Largest Contentful Paint | < 1.2 s |
| FE | Initial JS payload (gz) | < 150 KB |
| FE | Time to Interactive | < 2.0 s |
| Infra | CI pipeline duration | < 5 min |
| Infra | Backend image size | < 200 MB |
| Security | API-key encryption | AES-256-GCM roundtrip test green |
| Security | RLS | 0 cross-user leaks (integration test) |

## Open items — resolve during M1

| Item | Default plan |
|---|---|
| `agent_logs` table | Not in the 10-table list but referenced in §5.4. **Add as 11th table** at M1 (id, agent_id, action, input JSONB, output JSONB, duration_ms, created_at). |
| Bcrypt cost factor | Not specified. **Use 12.** |
| JWT signing key location | RS256 keypair generated at M1; private key as PEM in env var `JWT_PRIVATE_KEY`; public key as PEM in `JWT_PUBLIC_KEY`. |
| Frontend route structure | Default plan: `/login`, `/` (home), `/chat/[id]`, `/settings/[tab]?tab=data-sources\|mcp\|model\|skills\|agents`. Confirm at M2 kickoff. |
| Encryption key env var name | `ENCRYPTION_KEY` — 32-byte (64 hex chars) AES key. |

## Gotchas / non-obvious

- **Phase 1 spec was updated by user from BRD baseline.** The BRD's "Phase 1" was MVP-shaped (all 6 BRD phases compressed). The folder Phase 1 is Foundation Core only. If BRD and folder spec disagree, **folder spec wins**.
- **Settings is in Phase 1 scope.** Three settings tables (data_sources, mcp_connections, llm_configs) + five settings sub-pages ship in M5. Do not punt to a later phase.
- **Multi-user isolation via RLS, not app-level filters.** Every query must run with `SET LOCAL app.user_id = '<uuid>'`. Test M2 with two seeded users + a cross-user-fetch integration test that must return 404.
- **Encryption key in env, never code or DB.** AES-256-GCM with 32-byte key. Spec mandates roundtrip test in M5.
- **Spec says "22 endpoints" but the route count is ~29.** Spec counts paths; route handlers are more. Build all listed handlers.
- **Login mockup uses particles + acrylic backdrop.** The Phase 1 HTML mockup is the visual source of truth — match it pixel-faithfully unless it conflicts with responsive breakpoints.
- **Home greeting is dynamic time-of-day:** "Good morning/afternoon/evening, {displayName}". Computed client-side from user's local time.
