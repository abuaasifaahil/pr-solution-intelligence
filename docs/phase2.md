# Phase 2 — Data Pipeline (STUB)

**Source:** `Phase 2/Phase2_Technical_Specification.docx` (not yet digested)
**Status:** Not started · spec digest pending until M1–M6 of Phase 1 complete
**Builds on:** `phase1.md`

## One-line scope

Upload + conversational intake + Boolean query generation + data extract → produces the canonical "2,847 parsed articles" dataset that Phase 3 enriches.

## Plugs into (from Phase 1 contracts)

- `BaseAgent` → `DataExtractAgent` extends it
- File-upload route guarded by Phase 1 auth middleware
- `data_sources` table → reads configured APIs (Meltwater, Opoint, Webz, Twitter, Infovision)
- `chats.context` JSONB → stores collected params (brand, dates, intention)
- WebSocket per-chat channels → stream upload parsing progress
- OrchestratorAgent → routes to `DataExtractAgent` via Redis `agent:data_extract:incoming`

## Action when this phase begins

1. Run `unzip -p "Phase 2/Phase2_Technical_Specification.docx" word/document.xml | python -c "import sys,re; print('\n'.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',sys.stdin.read())))"` and digest the output into this file.
2. Define DB tables Phase 2 adds (likely `articles`, `uploads`, `boolean_queries`).
3. Define milestones using the same vertical-slice pattern as Phase 1.
4. Update root `CLAUDE.md` to mark Phase 2 as the active phase.
