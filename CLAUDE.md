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

- **Active phase:** Phase 1 — Foundation Core
- **Active milestone:** M5 — Settings tabs *(M4 WebSocket streaming complete)*
- **Completed milestones:** M1 (repo scaffold), M2 (auth flow), M6 (deploy: Vercel + Render), M3 (chat creation + REST messaging), M4 (WebSocket + OrchestratorAgent streaming)
- **Remaining:** M5 (settings tabs)
- See `docs/phase1.md` for milestone breakdown and `docs/plans/` for per-milestone plans.

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
