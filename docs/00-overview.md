# PR Solution Intelligence — Design Overview

**Status:** Approved 2026-05-28
**Phase:** 1 of 6 (Foundation Core)
**Author:** KhadarBasha Syed · AlphaMetricX (AMX)
**Sources:** `PR_Solution_Intelligence_BRD.docx`, `Phase 1/Phase1_Technical_Specification.docx`

## Project identity

Enterprise-grade, multi-user **Agentic AI platform** for PR and media intelligence. Multi-agent orchestration (Main Orchestrator + 7 sub-agents) over a Windows 11–themed chat UI. Six phases. This design covers Phase 1 and the conventions every later phase inherits.

## Repo layout

```
PR Solutions/
├── CLAUDE.md                            # lean router → points to docs/
├── PR_Solution_Intelligence_BRD.docx    # business requirements (read once)
├── Phase 1/ … Phase 6/                  # spec archive (.docx + .html) — untouched
├── docs/                                # Claude-loadable phase context
│   ├── 00-overview.md                   # this file
│   ├── tech-stack.md                    # frozen tech decisions (every phase)
│   ├── phase1.md                        # Phase 1 spec digest (ACTIVE)
│   └── phase2.md … phase6.md            # stub digests until each phase begins
└── app/                                 # implementation (created at M1)
    ├── shared/   types, db schema, validators
    ├── backend/  Fastify + Prisma + Redis + Agents
    ├── frontend/ Next.js 14 (app router)
    ├── infra/    Docker, Render config, GH workflows
    └── tests/    unit · integration · e2e
```

## Modular CLAUDE.md pattern

**Why:** loading all six phase specs into every session burns tokens for nothing. Only the active phase's digest should load.

**Rules** (enforced by root `CLAUDE.md`):

1. Read `docs/tech-stack.md` before any code change — those decisions apply across phases.
2. Before working on Phase N, read `docs/phaseN.md`. Do not read other `phaseM.md` files unless a contract crosses phases (the active phase doc calls out crossings).
3. Spec archive (`Phase N/*.docx`, `*.html`) is reference-only. Never edit. If a digest disagrees with the spec, the spec wins — flag it and update the digest.
4. **Check `docs/adr/` for cross-phase decisions** before designing anything that touches data-source ingestion, skill composition, or MCP. ADRs are append-only and supersede phase-doc statements.

## Cross-phase architecture decisions (ADRs)

When a decision spans phases, it lives in `docs/adr/` (not in a phase digest):

| # | Title | Status |
|---|---|---|
| [0001](adr/0001-data-source-adapter.md) | Data-source adapter pattern + multi-source per chat | Accepted 2026-06-01 |
| [0002](adr/0002-skill-composition.md) | Skill-first composition (replacing fixed-agent dropdown) | Accepted 2026-06-01 |
| [0003](adr/0003-chat-entry-composition.md) | 8 chat-entry patterns + agent-as-prober + per-user authoring | Accepted 2026-06-01 |

Adding a new ADR: see `docs/adr/README.md`.

## Tech stack (frozen)

Full table in `docs/tech-stack.md`. Headlines:

- **Frontend:** Next.js 14 (app router) + Tailwind + Zustand + TypeScript
- **Backend:** Fastify 4 + Prisma 5 + Zod 3 (Node 20 LTS)
- **Data:** PostgreSQL 16 (RLS, JSONB, GIN) + Redis 7 (sessions, pub/sub)
- **LLM SDK:** `@anthropic-ai/sdk` — Claude default, pluggable per BRD
- **Auth:** JWT RS256 (15-min access / 7-day refresh) + bcrypt + AES-256-GCM
- **Theme:** Windows 11 light only for Phase 1 (no dark mode)
- **Tests:** Vitest + Playwright
- **Local dev:** Docker Compose · **Deploy:** Vercel (FE) + Render (BE/PG/Redis)
- **CI:** GitHub Actions (lint → test → build → deploy)

## Phase 1 milestones (vertical slices)

Each milestone is end-to-end and demoable. **User drives milestone transitions** — manual approval after each demo.

| # | Milestone | Done when… |
|---|---|---|
| **M1** | Repo scaffold + Docker Compose | `docker compose up` boots Postgres+Redis+API+Web; Prisma migrates 10 tables; seed inserts 5 default agents; `/healthz` returns 200 on both services. |
| **M2** | Auth flow end-to-end | Login → JWT issued → home page renders user greeting. Logout works. Refresh-token rotation works. RLS integration test passes (user A cannot read user B). |
| **M3** | Chat creation + REST messaging | Click agent card → chat row created → `/chat/:id` renders → POST message → mock orchestrator reply persisted and shown. No WebSocket yet. |
| **M4** | WebSocket + OrchestratorAgent | Messages stream over WS; `OrchestratorAgent` lifecycle (perceive → reason → plan → act → reflect) wired via Redis pub/sub; typing indicators work; first real Claude call (acknowledgement only, no PR-domain work). |
| **M5** | Settings module | All five tabs functional (Data Sources, MCP, Model, Skills, Agents). API-key encryption roundtrip test green. Test-Connection / Verify buttons hit real endpoints. |
| **M6** | Deploy + CI | GH Actions pipeline green (lint → test → build); frontend on Vercel; backend + Postgres + Redis on Render; smoke test against staging passes. |

## What Phase 1 explicitly does NOT do

Per Phase 1 spec §8 — these arrive later. Phase 1 ships only the contracts they plug into.

- No real PR data ingestion or Boolean queries (→ Phase 2)
- No Claude enrichment of articles (→ Phase 3). M4 uses Claude for the orchestrator's acknowledgement reply only — no PR-domain analysis.
- No dashboard generation (→ Phase 4)
- No insight / learning / memory agents (→ Phase 5)
- No admin / governance UI (→ Phase 6)

## Deferred / blocking-later items

| Item | Needed at | Notes |
|---|---|---|
| Vercel account + token | M6 | Free tier OK |
| Render account + tokens (web + Postgres + Redis) | M6 | Free Postgres expires in 30 days — plan billing |
| Anthropic API key | M4 | Single key, low rate-limit fine for orchestrator ack |
| Domain name | Post-M6 | Optional; Vercel/Render preview URLs work for demo |
| Email provider (SES/Resend/Postmark) | Phase 4 | Not Phase 1 |

## Decision log

| Decision | Choice | Reason |
|---|---|---|
| Code location | `/app/` subfolder | Keeps specs + code in one repo, one history |
| Tech stack | TypeScript everywhere (Next.js + Fastify) | Phase 1 spec §2.2; single language end-to-end |
| Build order | Vertical slices M1–M6 | Always demoable; matches user's "test end-to-end then proceed" workflow |
| Frontend deploy | Vercel | Native Next.js host |
| Backend deploy | Render | Hosts Node + Postgres + Redis in one place |
| Dark mode | Deferred to Phase 6 | Light only for Phase 1 (HTML mockup is light-only) |
| Modular context | `docs/phaseN.md` lazy-loaded | Avoids loading all 6 specs into every session |
