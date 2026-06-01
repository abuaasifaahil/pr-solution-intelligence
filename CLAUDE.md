# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

PR Solution Intelligence — an enterprise multi-agent platform for PR/media intelligence, built by AlphaMetricX (AMX). Six implementation phases. See `PR_Solution_Intelligence_BRD.docx` for the business case and `docs/00-overview.md` for the technical design.

## Repo map

| Path | Purpose | Edit? |
|---|---|---|
| `docs/` | **Read this first.** Project design + per-phase digests. | Yes — keep current as phases progress |
| `docs/00-overview.md` | Design overview, repo layout, decision log | Yes |
| `docs/tech-stack.md` | Frozen tech choices across all phases | Only via ADR |
| `docs/phaseN.md` | Per-phase spec digest | Yes — flesh out as each phase starts |
| `app/` | Implementation (Next.js + Fastify monorepo) | Yes |
| `Phase 1/` … `Phase 6/` | Spec archive — `.docx` specs + `.html` mockups | **No.** Reference only. |
| `PR_Solution_Intelligence_BRD.docx` | Business requirements | **No.** Reference only. |

## Loading rules (modular context)

Phase specs are large. Do not load them all into context. Follow this order:

1. **Always read** `docs/tech-stack.md` before any code change — those decisions apply across every phase.
2. **Before working on Phase N**, read `docs/phaseN.md`. That digest is the source of truth for what to build.
3. **Do not read** `docs/phaseM.md` for other phases unless the active phase's digest calls out a cross-phase contract.
4. **Spec archive (`Phase N/`)** is reference-only. If a digest contradicts the spec, the spec wins — flag it and update the digest.
5. **HTML mockups (`Phase N/*.html`)** are the visual source of truth for that phase's UI. Match them pixel-faithfully unless they break responsive breakpoints.

## Current state

- **Active phase:** Phase 1 ✓ SHIPPED · Phase 2 ✓ SHIPPED · Phase 3 ✓ SHIPPED · Phase 3.5 ✓ SHIPPED 2026-06-01
- **Active milestone:** Phase 4 kickoff pending user approval
- **Completed milestones:** M1–M6 (Phase 1) · M7.1–M7.10 (Phase 2) · M8.1–M8.10 (Phase 3) · M9.1–M9.10 (Phase 3.5)
- **Remaining:** Phase 4 (dashboards), Phase 5 (memory + learning), Phase 5.5 (dynamic tool sandbox), Phase 6 (admin UI + dark mode), Phase 7 (MCP marketplace)
- See `docs/phase1.md`, `docs/phase2.md`, `docs/phase3.md`, `docs/phase3.5-autonomy.md` for shipped contracts.
- See `docs/adr/0001`, `docs/adr/0002`, `docs/adr/0003` for cross-phase architecture decisions.

### Surface area after Phase 3.5

- **REST endpoints:** 52 (22 from Phase 1 + 11 from Phase 2 + 9 from Phase 3 + 10 from Phase 3.5)
- **DB tables:** 21 (18 from Phase 1-3 + 3 from Phase 3.5 — `search_history`, `composable_skills`, `user_agents`)
- **WS events:** 27 (21 from Phase 1-3 + 6 from Phase 3.5 — `search:start|progress|fetched|error|complete`, `reach:absent|resolved`, `intent:extracting|extracted`)
- **Agents:** 5 (Orchestrator + DataExtractAgent + EnrichmentAgent + SimilarWebAgent + SearchAgent)
- **Cross-phase ADRs:** 3 (data-source adapter, skill composition, chat-entry composition)
- **Tests:** 832 backend + 169 frontend (+267 / +48 vs Phase 3)
- **Open follow-ups deferred to later phases:** `chat_data_sources` table + `SourceOrchestrator` (M9.11) · crawler/RSS/S3/Slack/MCP adapters · skill-manifest editor + composer runtime (Phase 5.5)

### Live deploy URLs

| Service | URL | Provider | Plan |
|---|---|---|---|
| Frontend | https://pr-solutions.vercel.app | Vercel | Hobby (free) |
| Backend | https://prsi-api.onrender.com | Render | Free web service |
| Postgres | internal-only `dpg-d8cfmna8qa3s73bhqo50-a` | Render | Free **— expires 2026-06-28** |
| Redis (Key-Value) | internal-only `red-d8cfmngg4nts738m05ug` | Render | Free 25 MB |
| GitHub repo | https://github.com/abuaasifaahil/pr-solution-intelligence | GitHub | Private |

Auto-deploys: push to `main` → Vercel + Render redeploy automatically. PRs get Vercel preview URLs.

⚠ **Render free Postgres expires 2026-06-28** (30 days from creation). Migrate to Starter ($7/mo) or Neon before then. See `docs/m6-deploy-ops.md`.

**Encryption key:** `ENCRYPTION_KEY` (32-byte hex, 64 chars) is set in Render env vars for prod and `app/backend/.env` for local. Rotating it invalidates every stored API key / token / model key. Store the value in a password manager — there is no recovery if it is lost.

**Test credentials** (seeded on every fresh DB):
- `user-a@test.local` / `Password123!` (Alice — display name "Alice (test)")
- `user-b@test.local` / `Password123!` (Bob — display name "Bob (test)")

## Reading the .docx specs

`.docx` is a ZIP of XML. To dump text from a spec:

```bash
unzip -p "Phase 1/Phase1_Technical_Specification.docx" word/document.xml \
  | python -c "import sys,re; print('\n'.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',sys.stdin.read())))"
```

Use this to refresh a digest when the user updates a spec — do not edit `.docx` files directly.

## Conventions

- **Tech stack is frozen** in `docs/tech-stack.md` — no Express, no NextAuth, no Python backend. Re-evaluations require an ADR.
- **Vertical slices over horizontal layers.** Every milestone is end-to-end and demoable; user signs off before next milestone starts.
- **RLS, not app-side filters**, for multi-user isolation.
- **Encryption keys live in env vars**, never in code or DB.
- **Windows 11 light theme only for Phase 1.** Dark mode deferred to Phase 6.
