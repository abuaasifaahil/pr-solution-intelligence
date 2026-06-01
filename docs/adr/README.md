# Architectural Decision Records (ADRs)

Each ADR captures one architectural decision that cuts across phases, the alternatives that were rejected, and the migration path. ADRs are **append-only** — when a decision is superseded, we add a new ADR that references the old one rather than editing history.

| # | Title | Status | Phases affected |
|---|---|---|---|
| [0001](./0001-data-source-adapter.md) | Data-source adapter pattern + multi-source per chat | Accepted 2026-06-01 | 3.5, 4, 5, 5.5 |
| [0002](./0002-skill-composition.md) | Skill-first composition (replacing fixed-agent dropdown) | Accepted 2026-06-01 | 5, 5.5, 6, 7 (new) |
| [0003](./0003-chat-entry-composition.md) | 8 chat-entry patterns + agent-as-prober + per-user authoring | Accepted 2026-06-01 | 3.5, 4, 5, 5.5, 6, 7 |

## When to write a new ADR

- Cross-phase contract change (e.g. a column or interface used by ≥2 phases)
- Tech-stack addition/removal (also requires updating `tech-stack.md`)
- Vendor or provider switch
- User-facing flow change that ripples through ≥2 phases
- Anything that makes you say "if I forget this in 3 months, I'll do the wrong thing"

## When NOT to write an ADR

- One-milestone implementation details (digests + commit messages are enough)
- Code style / linting / formatting (`.editorconfig` handles those)
- Library-version bumps without API change
